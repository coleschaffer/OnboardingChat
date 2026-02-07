const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { gmailService } = require('../lib/gmail');
const { postApplicationNotification, createApplicationThread, postMessage } = require('./slack-threads');
const { createBusinessOwnerItem, businessOwnerExistsInMonday, findBusinessOwnerByEmail, getColumnIds, updateBusinessOwnerStatusByEmail, updateTeamMemberStatusByEmail } = require('./monday');
const { sendWelcomeThread } = require('./jobs');
const { createWhatsAppCopyBlock } = require('../lib/slack-blocks');
const { createMemberThread, getMemberThread, updateMemberThreadMetadata } = require('../lib/member-threads');
const { parseMoney, formatCurrency, formatFullName } = require('../lib/billing-utils');
const { DEFAULT_TIMEZONE, getMonthKeyInTimeZone, getDateKeyInTimeZone } = require('../lib/time');
const { removeGroupParticipants, normalizePhoneForWasender } = require('../lib/wasender-client');
const { addContactsToGroups, buildWhatsAppAddSummary } = require('../lib/whatsapp-actions');
const { resolveGroupKeysForRole } = require('../lib/whatsapp-groups');
const { removeMembersFromCircle } = require('./circle');

// Typeform webhook handler
router.post('/typeform', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const pool = req.app.locals.pool;

    // Verify webhook signature if secret is configured
    const signature = req.headers['typeform-signature'];
    const webhookSecret = process.env.TYPEFORM_WEBHOOK_SECRET;

    if (webhookSecret && signature) {
      const hash = crypto
        .createHmac('sha256', webhookSecret)
        .update(req.body)
        .digest('base64');

      const expectedSignature = `sha256=${hash}`;

      if (signature !== expectedSignature) {
        console.warn('Invalid Typeform webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    // Parse the body
    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { event_type, form_response } = payload;

    // Only process form_response events
    if (event_type !== 'form_response') {
      return res.status(200).json({ message: 'Event type ignored' });
    }

    const responseId = form_response.token;
    const answers = form_response.answers || [];
    const definition = form_response.definition || {};
    const fields = definition.fields || [];

    console.log('Typeform answers received:', JSON.stringify(answers, null, 2));

    // Build a map of field ID to field title for better matching
    const fieldTitleMap = {};
    fields.forEach(f => {
      fieldTitleMap[f.id] = f.title?.toLowerCase() || '';
    });

    // Extract answers by looking at field titles/types - ALL 15 QUESTIONS
    const fieldMapping = {
      first_name: null,           // Q1
      last_name: null,            // Q2
      email: null,                // Q3
      phone: null,                // Q4
      contact_preference: null,   // Q5: Best way to reach you
      business_description: null, // Q6: Tell me about your business
      annual_revenue: null,       // Q7: Current annual revenue
      revenue_trend: null,        // Q8: In the last 3 months has your revenue
      main_challenge: null,       // Q9: #1 thing holding you back
      why_ca_pro: null,           // Q10: What specifically about CA Pro
      investment_readiness: null, // Q11: Prepared to make this investment
      decision_timeline: null,    // Q12: Timeline for making a decision
      has_team: null,             // Q13: Do you have a team currently
      anything_else: null,        // Q14: Anything else I should know
      referral_source: null       // Q15: How did you hear about CA Pro
    };

    // Process each answer and map to our fields
    for (const answer of answers) {
      const fieldId = answer.field?.id;
      const fieldTitle = fieldTitleMap[fieldId] || '';
      const value = extractAnswerValue(answer);

      // Match by field type first
      if (answer.type === 'email' && !fieldMapping.email) {
        fieldMapping.email = value;
      } else if (answer.type === 'phone_number' && !fieldMapping.phone) {
        fieldMapping.phone = value;
      }
      // Q1: First name
      else if (fieldTitle.includes('first') && fieldTitle.includes('name')) {
        fieldMapping.first_name = value;
      }
      // Q2: Last name
      else if (fieldTitle.includes('last') && fieldTitle.includes('name')) {
        fieldMapping.last_name = value;
      }
      // Q5: Best way to reach you
      else if (fieldTitle.includes('best way') || fieldTitle.includes('reach you')) {
        fieldMapping.contact_preference = value;
      }
      // Q6: Tell me about your business
      else if ((fieldTitle.includes('tell') && fieldTitle.includes('business')) ||
               fieldTitle.includes('what do you sell') || fieldTitle.includes('who do you sell')) {
        fieldMapping.business_description = value;
      }
      // Q7: Current annual revenue
      else if (fieldTitle.includes('current') && fieldTitle.includes('revenue')) {
        fieldMapping.annual_revenue = value;
      }
      // Q8: Revenue trend (last 3 months)
      else if (fieldTitle.includes('last 3 months') || fieldTitle.includes('revenue:')) {
        fieldMapping.revenue_trend = value;
      }
      // Q9: Main challenge (#1 thing holding back)
      else if (fieldTitle.includes('holding') || fieldTitle.includes('#1')) {
        fieldMapping.main_challenge = value;
      }
      // Q10: Why CA Pro (what specifically made you want to apply)
      else if (fieldTitle.includes('specifically') && fieldTitle.includes('ca pro')) {
        fieldMapping.why_ca_pro = value;
      }
      // Q11: Investment readiness ($5,000/month)
      else if (fieldTitle.includes('investment') || fieldTitle.includes('$5,000') || fieldTitle.includes('prepared')) {
        fieldMapping.investment_readiness = value;
      }
      // Q12: Decision timeline
      else if (fieldTitle.includes('timeline') || fieldTitle.includes('decision')) {
        fieldMapping.decision_timeline = value;
      }
      // Q13: Has team
      else if (fieldTitle.includes('team currently') || fieldTitle.includes('have a team')) {
        fieldMapping.has_team = value;
      }
      // Q14: Anything else
      else if (fieldTitle.includes('anything else') || fieldTitle.includes('should know')) {
        fieldMapping.anything_else = value;
      }
      // Q15: Referral source (how did you hear)
      else if (fieldTitle.includes('how did you hear') || fieldTitle.includes('lastly')) {
        fieldMapping.referral_source = value;
      }
    }

    console.log('Parsed Typeform fields:', fieldMapping);

    // Check if response already exists
    const existing = await pool.query(
      'SELECT id FROM typeform_applications WHERE typeform_response_id = $1',
      [responseId]
    );

    if (existing.rows.length > 0) {
      console.log(`[Typeform] Duplicate response detected: ${responseId} already exists as ${existing.rows[0].id}`);
      return res.status(200).json({ message: 'Response already processed' });
    }

    console.log(`[Typeform] New response: ${responseId} for ${fieldMapping.email}`);


    // Insert new application with all 15 fields
    const result = await pool.query(`
      INSERT INTO typeform_applications (
        typeform_response_id,
        first_name,
        last_name,
        email,
        phone,
        contact_preference,
        business_description,
        annual_revenue,
        revenue_trend,
        main_challenge,
        why_ca_pro,
        investment_readiness,
        decision_timeline,
        has_team,
        anything_else,
        referral_source,
        raw_data,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING id
    `, [
      responseId,
      fieldMapping.first_name,
      fieldMapping.last_name,
      fieldMapping.email,
      fieldMapping.phone,
      fieldMapping.contact_preference,
      fieldMapping.business_description,
      fieldMapping.annual_revenue,
      fieldMapping.revenue_trend,
      fieldMapping.main_challenge,
      fieldMapping.why_ca_pro,
      fieldMapping.investment_readiness,
      fieldMapping.decision_timeline,
      fieldMapping.has_team,
      fieldMapping.anything_else,
      fieldMapping.referral_source,
      JSON.stringify(form_response),
      'new'
    ]);

    // Log activity
    await pool.query(`
      INSERT INTO activity_log (action, entity_type, entity_id, details)
      VALUES ($1, $2, $3, $4)
    `, ['new_application', 'application', result.rows[0].id, JSON.stringify({
      name: `${fieldMapping.first_name} ${fieldMapping.last_name}`,
      source: 'typeform_webhook'
    })]);

    console.log(`New Typeform application received: ${result.rows[0].id}`);

    const applicationId = result.rows[0].id;

    // Send automated email and create Slack thread (async - don't block response)
    sendAutomatedEmailAndSlackThread(pool, applicationId, fieldMapping).catch(err => {
      console.error('Error in automated email/Slack flow:', err);
    });

    res.status(200).json({
      success: true,
      application_id: applicationId
    });
  } catch (error) {
    console.error('Error processing Typeform webhook:', error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

// Helper function to extract value from any Typeform answer type
function extractAnswerValue(answer) {
  if (!answer) return null;

  switch (answer.type) {
    case 'text':
    case 'short_text':
    case 'long_text':
      return answer.text;
    case 'email':
      return answer.email;
    case 'phone_number':
      return answer.phone_number;
    case 'number':
      return answer.number?.toString();
    case 'boolean':
      return answer.boolean ? 'Yes' : 'No';
    case 'choice':
      return answer.choice?.label || answer.choice?.other;
    case 'choices':
      return (answer.choices?.labels || []).join(', ');
    case 'date':
      return answer.date;
    case 'url':
      return answer.url;
    case 'file_url':
      return answer.file_url;
    default:
      // Try common properties
      return answer.text || answer.email || answer.phone_number ||
             answer.number?.toString() || answer.choice?.label || null;
  }
}

// Test endpoint for webhook
router.get('/typeform/test', (req, res) => {
  res.json({ message: 'Typeform webhook endpoint is active' });
});

/**
 * Create Business Owner in Monday.com from SamCart order
 * Called async after order insertion
 */
async function createBusinessOwnerInMonday(pool, orderId, orderData, rawData) {
  try {
    // Check if Business Owner already exists by email
    if (orderData.email) {
      const exists = await businessOwnerExistsInMonday(orderData.email);
      if (exists) {
        console.log(`[Monday] Business Owner already exists for ${orderData.email}, skipping creation`);
        return null;
      }
    }

    // If phone is missing, try to get it from Typeform application
    if (!orderData.phone && orderData.email) {
      const typeformResult = await pool.query(
        'SELECT phone FROM typeform_applications WHERE LOWER(email) = LOWER($1) ORDER BY created_at DESC LIMIT 1',
        [orderData.email]
      );
      if (typeformResult.rows.length > 0 && typeformResult.rows[0].phone) {
        orderData.phone = typeformResult.rows[0].phone;
        console.log(`[Monday] Got phone from Typeform: ${orderData.phone}`);
      }
    }

    // Create the Business Owner in Monday
    const item = await createBusinessOwnerItem(orderData, rawData);

    if (item) {
      // Store monday_item_id in database
      await pool.query(`
        UPDATE samcart_orders
        SET monday_item_id = $1, monday_created_at = NOW()
        WHERE id = $2
      `, [item.id, orderId]);

      // Log to activity_log
      await pool.query(`
        INSERT INTO activity_log (action, entity_type, entity_id, details)
        VALUES ($1, $2, $3, $4)
      `, [
        'monday_business_owner_created',
        'samcart_order',
        orderId,
        JSON.stringify({
          email: orderData.email,
          name: item.name,
          monday_item_id: item.id,
          product: orderData.product_name
        })
      ]);

      console.log(`[Monday] Stored monday_item_id ${item.id} for order ${orderId}`);
      return item;
    }

    return null;
  } catch (error) {
    console.error(`[Monday] Error creating Business Owner for order ${orderId}:`, error.message);

    // Log the error to activity_log
    await pool.query(`
      INSERT INTO activity_log (action, entity_type, entity_id, details)
      VALUES ($1, $2, $3, $4)
    `, [
      'monday_business_owner_failed',
      'samcart_order',
      orderId,
      JSON.stringify({
        email: orderData.email,
        error: error.message
      })
    ]);

    return null;
  }
}

/**
 * Post SamCart order notification to #notifications-capro
 * Returns the thread_ts for threading the welcome message
 */
async function postSamCartNotification(pool, orderId, orderData) {
  const channelId = process.env.CA_PRO_NOTIFICATIONS_SLACK_CHANNEL;

  if (!channelId) {
    console.log('[SamCart] CA_PRO_NOTIFICATIONS_SLACK_CHANNEL not set, skipping Slack notification');
    return null;
  }

  const customerName = [orderData.first_name, orderData.last_name].filter(Boolean).join(' ') || 'N/A';
  const amount = orderData.order_total ? formatCurrency(orderData.order_total) : null;
  const amountLabel = amount || 'N/A';

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🎉 *Order Complete*\n*Order ID:* ${orderData.samcart_order_id || 'N/A'}\n*Product:* ${orderData.product_name || 'CA Pro Membership'}\n*Amount:* ${amountLabel}\n----------------------------------\n*Name:* ${customerName}\n*Email:* ${orderData.email || 'N/A'}`
      }
    }
  ];

  const text = `New SamCart Order: ${customerName} - ${orderData.product_name || 'CA Pro'}`;

  try {
    const response = await postMessage(channelId, text, blocks);

    if (response && response.ts) {
      // Store the Slack thread info in samcart_orders
      await pool.query(
        'UPDATE samcart_orders SET slack_channel_id = $1, slack_thread_ts = $2 WHERE id = $3',
        [channelId, response.ts, orderId]
      );

      console.log(`[SamCart] Posted notification to Slack, thread_ts: ${response.ts}`);
      return { channelId, threadTs: response.ts };
    }

    return null;
  } catch (error) {
    console.error('[SamCart] Error posting to Slack:', error);
    return null;
  }
}

async function postYearlyPurchaseToRenewalThread(pool, orderData) {
  const productId = orderData.product_id ? orderData.product_id.toString() : '';
  const productName = (orderData.product_name || '').toLowerCase();
  const isYearly = productId === '1062289' || productName.includes('yearly');

  if (!isYearly || !orderData.email) {
    return false;
  }

  const result = await pool.query(
    `
      SELECT slack_channel_id, slack_thread_ts
      FROM member_threads
      WHERE member_email = $1
        AND thread_type = 'yearly_renewal'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [orderData.email.toLowerCase()]
  );

  const thread = result.rows[0];
  if (!thread?.slack_channel_id || !thread?.slack_thread_ts) {
    return false;
  }

  const amountLabel = orderData.order_total ? formatCurrency(orderData.order_total) : 'N/A';
  const message = `✅ Yearly renewal purchase completed\n*Order ID:* ${orderData.samcart_order_id || 'N/A'}\n*Amount:* ${amountLabel}`;

  await postMessage(thread.slack_channel_id, message, [
    { type: 'section', text: { type: 'mrkdwn', text: message } }
  ], thread.slack_thread_ts);

  return true;
}

function normalizeSamcartEventType(rawType) {
  return (rawType || '').toString().trim().toLowerCase().replace(/[_\.]+/g, ' ');
}

function normalizeSamcartEventTypeForMatch(rawType) {
  const raw = (rawType || '').toString().trim();
  if (!raw) return '';
  const withSpaces = raw.replace(/[_\.]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return withSpaces.toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeSamcartStatus(rawStatus) {
  return (rawStatus || '').toString().trim().toLowerCase();
}

function mapSubscriptionEventType(rawType) {
  const normalized = normalizeSamcartEventTypeForMatch(rawType);
  if (!normalized) return null;

  if (normalized.includes('recurring payment failed')) return 'charge_failed';
  if (normalized.includes('recurring payment recovered')) return 'recovered';
  if (normalized.includes('recurring payment succeeded') || normalized.includes('recurring payment success')) return 'charged';

  if (normalized.includes('subscription charge failed')) return 'charge_failed';
  if (normalized.includes('subscription charged') || normalized.includes('subscription charge succeeded')) return 'charged';
  if (normalized.includes('subscription recovered')) return 'recovered';

  if (normalized.includes('subscription delinquent') || normalized.includes('delinquent')) return 'delinquent';
  if (normalized.includes('subscription canceled') || normalized.includes('subscription cancelled')) return 'canceled';
  if (normalized === 'cancel' || normalized === 'canceled' || normalized === 'cancelled') return 'canceled';

  if (normalized.includes('subscription')) return 'subscription_event';

  return null;
}

function refineSubscriptionEventType(mappedType, rawStatus) {
  const status = normalizeSamcartStatus(rawStatus);
  // Only apply status-based hints when we already know this is a subscription-style event.
  // (Otherwise, order webhooks with status="paid"/"completed" could be misclassified.)
  if (!mappedType) return null;
  if (!status) return mappedType;

  // If the webhook type is vague ("subscription updated"), use status as a hint.
  if (mappedType !== 'subscription_event') {
    return mappedType;
  }

  if (status.includes('delinquent') || status.includes('past_due') || status.includes('past due') || status.includes('unpaid')) {
    return 'delinquent';
  }

  if (status.includes('cancel')) return 'canceled';
  if (status.includes('recover')) return 'recovered';
  if (status.includes('success') || status.includes('succeed') || status.includes('charged') || status.includes('paid')) return 'charged';
  if (status.includes('fail')) return 'charge_failed';

  return mappedType;
}

function isOrderEventType(rawType) {
  const normalized = normalizeSamcartEventTypeForMatch(rawType);
  if (!normalized) return false;
  return (
    normalized === 'order' ||
    normalized === 'order complete' ||
    normalized === 'order completed' ||
    normalized === 'order paid'
  );
}

function extractSamcartEmail(payload) {
  const customer = payload.customer || payload.customer_details || payload.subscription?.customer || payload.subscription?.customer_details || {};
  const email =
    customer.email ||
    payload.customer_email ||
    payload.email ||
    payload.subscription?.email ||
    payload.order?.customer_email ||
    payload.order?.email ||
    null;

  if (!email) return null;
  const trimmed = email.toString().trim();
  return trimmed || null;
}

function extractSamcartPhone(payload) {
  const customer = payload.customer || payload.customer_details || payload.subscription?.customer || payload.subscription?.customer_details || {};
  const phone =
    customer.phone ||
    payload.customer_phone ||
    payload.phone ||
    payload.subscription?.phone ||
    payload.order?.customer_phone ||
    payload.order?.phone ||
    null;

  if (!phone) return null;
  const trimmed = phone.toString().trim();
  return trimmed || null;
}

function extractSamcartAmount(payload) {
  const candidates = [
    payload.charge?.amount,
    payload.subscription?.amount,
    payload.order?.total,
    payload.order?.order_total,
    payload.order_total,
    payload.amount,
    payload.total
  ];

  for (const value of candidates) {
    const parsed = parseMoney(value);
    if (parsed != null) return parsed;
  }

  return null;
}

function extractSamcartSubscriptionId(payload) {
  return payload.subscription?.id || payload.subscription_id || payload.data?.subscription_id || null;
}

function extractSamcartOrderId(payload) {
  return payload.order?.id || payload.order_id || payload.order?.order_id || null;
}

function parseSamcartTimestamp(value) {
  if (value == null) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  // Numeric timestamps: allow seconds or milliseconds.
  const parseEpochNumber = (num) => {
    if (!Number.isFinite(num)) return null;
    // Heuristic: seconds are ~1e9-1e10; ms are ~1e12-1e13.
    if (num > 1e12) return new Date(num);
    if (num > 1e9) return new Date(num * 1000);
    return new Date(num);
  };

  if (typeof value === 'number') {
    const date = parseEpochNumber(value);
    return date && !Number.isNaN(date.getTime()) ? date : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    // Unix timestamps often arrive as strings too.
    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      const date = parseEpochNumber(num);
      return date && !Number.isNaN(date.getTime()) ? date : null;
    }

    const date = new Date(trimmed);
    return !Number.isNaN(date.getTime()) ? date : null;
  }

  // Fallback: try Date constructor on unknown types.
  try {
    const date = new Date(value);
    return !Number.isNaN(date.getTime()) ? date : null;
  } catch {
    return null;
  }
}

function extractSamcartEventTimestamp(payload) {
  const candidates = [
    payload.event_time,
    payload.event_timestamp,
    payload.timestamp,
    payload.created_at,
    payload.event?.created_at
  ];

  const now = Date.now();
  const earliestAllowed = Date.UTC(2000, 0, 1);
  const latestAllowed = now + 7 * 24 * 60 * 60 * 1000;

  for (const value of candidates) {
    const date = parseSamcartTimestamp(value);
    if (!date) continue;
    const t = date.getTime();
    // Guard against epoch-second parsing bugs sending us to 1970, or other implausible dates.
    if (t < earliestAllowed || t > latestAllowed) continue;
    return date;
  }

  return new Date();
}

function buildSamcartEventKey(payload, rawType) {
  const candidate =
    payload.id ||
    payload.event_id ||
    payload.webhook_id ||
    payload.event?.id ||
    payload.event?.uuid ||
    payload.subscription?.id ||
    payload.subscription_id ||
    payload.order?.id ||
    payload.order_id;

  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload || {}))
    .digest('hex');

  if (candidate) {
    return `${normalizeSamcartEventType(rawType) || 'event'}:${candidate}:${hash}`;
  }

  return `${normalizeSamcartEventType(rawType) || 'event'}:${hash}`;
}

async function recordSubscriptionEvent(pool, {
  eventKey,
  eventType,
  email,
  subscriptionId,
  orderId,
  amount,
  currency,
  status,
  occurredAt,
  periodKey,
  rawData
}) {
  const normalizedEmail = email ? email.toString().trim().toLowerCase() : null;

  const insertResult = await pool.query(`
    INSERT INTO samcart_subscription_events (
      event_key, event_type, email, period_key,
      subscription_id, order_id, amount, currency,
      status, occurred_at, raw_data
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (event_key) DO NOTHING
    RETURNING *
  `, [
    eventKey,
    eventType,
    normalizedEmail,
    periodKey,
    subscriptionId,
    orderId,
    amount,
    currency || 'USD',
    status || null,
    occurredAt,
    JSON.stringify(rawData || {})
  ]);

  if (insertResult.rows[0]) {
    return { event: insertResult.rows[0], created: true };
  }

  // Duplicate delivery or repeated attempt. For charge_failed, SamCart can resend an identical payload
  // across multiple payment retry attempts, so we treat a "duplicate" that arrives much later as a new attempt.
  const latestResult = await pool.query(
    `
      SELECT *
      FROM samcart_subscription_events
      WHERE event_key = $1 OR event_key LIKE $2
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [eventKey, `${eventKey}:attempt:%`]
  );

  const latest = latestResult.rows[0] || null;
  if (!latest) return { event: null, created: false };

  if (eventType === 'charge_failed') {
    const lastCreated = latest.created_at ? new Date(latest.created_at) : null;
    const now = new Date();
    const lastTime = lastCreated && !Number.isNaN(lastCreated.getTime()) ? lastCreated.getTime() : 0;
    const deltaMs = now.getTime() - lastTime;

    // If we receive the same fingerprinted payload hours/days later, count it as a new retry attempt.
    // This avoids "Attempt #1" forever when SamCart payloads don't include a unique attempt id/timestamp.
    const ATTEMPT_GAP_MS = 6 * 60 * 60 * 1000; // 6 hours
    if (deltaMs >= ATTEMPT_GAP_MS) {
      const suffix = `${Math.floor(now.getTime() / 1000)}-${crypto.randomBytes(3).toString('hex')}`;
      const attemptKey = `${eventKey}:attempt:${suffix}`.slice(0, 255);

      const attemptInsert = await pool.query(
        `
          INSERT INTO samcart_subscription_events (
            event_key, event_type, email, period_key,
            subscription_id, order_id, amount, currency,
            status, occurred_at, raw_data
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (event_key) DO NOTHING
          RETURNING *
        `,
        [
          attemptKey,
          eventType,
          normalizedEmail,
          periodKey,
          subscriptionId,
          orderId,
          amount,
          currency || 'USD',
          status || null,
          occurredAt,
          JSON.stringify(rawData || {})
        ]
      );

      if (attemptInsert.rows[0]) {
        return { event: attemptInsert.rows[0], created: true };
      }
    }
  }

  return { event: latest, created: false };
}

async function markSubscriptionEventSlackNotified(pool, eventId) {
  if (!pool || !eventId) return;
  await pool.query(
    `
      UPDATE samcart_subscription_events
      SET slack_notified = TRUE,
          slack_notified_at = CURRENT_TIMESTAMP,
          slack_error = NULL
      WHERE id = $1
    `,
    [eventId]
  );
}

async function markSubscriptionEventSlackError(pool, eventId, error) {
  if (!pool || !eventId) return;
  const message = (error && error.message) ? error.message : (error ? String(error) : null);
  await pool.query(
    `
      UPDATE samcart_subscription_events
      SET slack_notified = FALSE,
          slack_notified_at = NULL,
          slack_error = $2
      WHERE id = $1
    `,
    [eventId, message]
  );
}

function isSlackThreadMissingError(error) {
  const message = (error && error.message) ? error.message : '';
  return (
    message.includes('thread_not_found') ||
    message.includes('message_not_found') ||
    message.includes('invalid_ts')
  );
}

async function resetMemberThreadSlackPointers(pool, threadId) {
  if (!pool || !threadId) return;
  await pool.query(
    'UPDATE member_threads SET slack_channel_id = NULL, slack_thread_ts = NULL WHERE id = $1',
    [threadId]
  );
}

async function ensureMemberThreadSlack(pool, createParams, expectedChannelId) {
  const initialResult = await createMemberThread(pool, createParams);
  let thread = initialResult?.thread || null;

  if (!thread) return { thread: null };

  // If the thread exists but is in the wrong channel, "move" by recreating the root message in the new channel.
  if (
    expectedChannelId &&
    thread.slack_channel_id &&
    thread.slack_channel_id !== expectedChannelId &&
    thread.id
  ) {
    await resetMemberThreadSlackPointers(pool, thread.id);
    const movedResult = await createMemberThread(pool, createParams);
    thread = movedResult?.thread || thread;
  }

  return { thread };
}

async function postMessageToMemberThread(pool, thread, createParams, expectedChannelId, text, blocks) {
  if (!thread?.slack_channel_id || !thread?.slack_thread_ts) {
    throw new Error('Missing Slack thread identifiers');
  }

  // If we've changed channels for failures, ensure we're posting to the expected channel.
  if (expectedChannelId && thread.slack_channel_id !== expectedChannelId && thread.id) {
    await resetMemberThreadSlackPointers(pool, thread.id);
    const ensured = await ensureMemberThreadSlack(pool, createParams, expectedChannelId);
    thread = ensured.thread;
    if (!thread?.slack_channel_id || !thread?.slack_thread_ts) {
      throw new Error('Failed to re-create Slack thread in expected channel');
    }
  }

  try {
    await postMessage(thread.slack_channel_id, text, blocks, thread.slack_thread_ts);
    return thread;
  } catch (error) {
    if (!isSlackThreadMissingError(error) || !thread?.id) throw error;

    console.warn('[SamCart] Slack thread missing; re-creating thread and retrying post...');
    await resetMemberThreadSlackPointers(pool, thread.id);
    const repaired = await ensureMemberThreadSlack(pool, createParams, expectedChannelId);
    const repairedThread = repaired.thread;

    if (!repairedThread?.slack_channel_id || !repairedThread?.slack_thread_ts) {
      throw error;
    }

    await postMessage(repairedThread.slack_channel_id, text, blocks, repairedThread.slack_thread_ts);
    return repairedThread;
  }
}

async function countSubscriptionFailures(pool, email, periodKey, since = null) {
  const params = [email, periodKey];
  let query = `
      SELECT COUNT(*)::int AS count
      FROM samcart_subscription_events
      WHERE TRIM(LOWER(email)) = TRIM(LOWER($1))
        AND event_type = 'charge_failed'
        AND to_char(created_at AT TIME ZONE '${DEFAULT_TIMEZONE}', 'YYYY-MM') = $2
  `;

  if (since) {
    query += ` AND created_at >= $3`;
    params.push(since);
  }

  const result = await pool.query(query, params);
  return result.rows[0]?.count || 0;
}

function buildMonthlyBounceTemplate(firstName) {
  const greetingName = firstName || 'there';
  return `Hey ${greetingName}, hope you're doing well! Just wanted to give you a heads up - your most recent CA Pro payment didn't go through.\n\nIt'll automatically retry in a few days, so if your card is good you can ignore this. Otherwise, here is link to update your payment info: https://copyaccelerator.samcart.com/customer_hub/login. Let me know if you need any help!`;
}

async function extractPhoneFromMondayItem(mondayItem) {
  if (!mondayItem) return null;

  try {
    const columns = await getColumnIds('6400461985');
    const phoneColumnIds = Object.entries(columns)
      .filter(([title]) => {
        const lower = title.toLowerCase();
        return lower.includes('phone') || lower.includes('whatsapp');
      })
      .map(([, col]) => col.id);

    const phoneColumn = mondayItem.column_values?.find(col => phoneColumnIds.includes(col.id) && col.text);
    return phoneColumn?.text || null;
  } catch (error) {
    console.error('[WhatsApp Add] Monday phone lookup failed:', error.message);
    return null;
  }
}

async function resolveBusinessOwnerForWhatsAppAdd(pool, email, orderData = {}) {
  const normalizedEmail = (email || '').toLowerCase();
  let firstName = orderData.first_name || null;
  let lastName = orderData.last_name || null;
  let phone = orderData.phone || null;

  if (normalizedEmail) {
    try {
      const tfResult = await pool.query(
        'SELECT first_name, last_name, phone FROM typeform_applications WHERE LOWER(email) = LOWER($1) ORDER BY created_at DESC LIMIT 1',
        [normalizedEmail]
      );
      if (tfResult.rows[0]) {
        firstName = firstName || tfResult.rows[0].first_name;
        lastName = lastName || tfResult.rows[0].last_name;
        phone = phone || tfResult.rows[0].phone;
      }
    } catch (error) {
      console.error('[WhatsApp Add] Typeform lookup failed:', error.message);
    }

    try {
      const mondayItem = await findBusinessOwnerByEmail(normalizedEmail);
      if (mondayItem) {
        const mondayPhone = await extractPhoneFromMondayItem(mondayItem);
        phone = phone || mondayPhone;
        if ((!firstName || !lastName) && mondayItem.name) {
          const parts = mondayItem.name.split(' ').filter(Boolean);
          firstName = firstName || parts[0] || null;
          lastName = lastName || parts.slice(1).join(' ') || null;
        }
      }
    } catch (error) {
      console.error('[WhatsApp Add] Monday lookup failed:', error.message);
    }

    try {
      const boResult = await pool.query(
        'SELECT first_name, last_name, phone, whatsapp_number FROM business_owners WHERE LOWER(email) = LOWER($1) LIMIT 1',
        [normalizedEmail]
      );
      if (boResult.rows[0]) {
        firstName = firstName || boResult.rows[0].first_name;
        lastName = lastName || boResult.rows[0].last_name;
        phone = phone || boResult.rows[0].whatsapp_number || boResult.rows[0].phone;
      }
    } catch (error) {
      console.error('[WhatsApp Add] Business owner lookup failed:', error.message);
    }
  }

  const name = formatFullName(firstName, lastName) || normalizedEmail || 'Member';
  return { name, email: normalizedEmail, phone };
}

async function resolveMemberContext(pool, email, phone) {
  const normalizedEmail = (email || '').toLowerCase();

  let firstName = null;
  let lastName = null;
  let displayName = null;
  let phoneNumber = null;
  let businessOwnerId = null;

  if (normalizedEmail) {
    try {
      const mondayItem = await findBusinessOwnerByEmail(normalizedEmail);
      if (mondayItem) {
        displayName = mondayItem.name || displayName;

        const columns = await getColumnIds('6400461985');
        const phoneColumnIds = Object.entries(columns)
          .filter(([title]) => {
            const lower = title.toLowerCase();
            return lower.includes('phone') || lower.includes('whatsapp');
          })
          .map(([, col]) => col.id);

        const phoneColumn = mondayItem.column_values?.find(col => phoneColumnIds.includes(col.id) && col.text);
        if (phoneColumn?.text) {
          phoneNumber = phoneNumber || phoneColumn.text;
        }

        if (displayName && !firstName && !lastName) {
          const nameParts = displayName.split(' ').filter(Boolean);
          firstName = nameParts[0] || firstName;
          lastName = nameParts.slice(1).join(' ') || lastName;
        }
      }
    } catch (error) {
      console.error('[Offboarding] Monday lookup failed:', error.message);
    }

    try {
      const tfResult = await pool.query(
        'SELECT first_name, last_name, phone FROM typeform_applications WHERE LOWER(email) = LOWER($1) ORDER BY created_at DESC LIMIT 1',
        [normalizedEmail]
      );
      if (tfResult.rows[0]) {
        firstName = firstName || tfResult.rows[0].first_name;
        lastName = lastName || tfResult.rows[0].last_name;
        phoneNumber = phoneNumber || tfResult.rows[0].phone;
      }
    } catch (error) {
      console.error('[Offboarding] Typeform lookup failed:', error.message);
    }

    try {
      const boResult = await pool.query(
        'SELECT id, first_name, last_name, phone, whatsapp_number FROM business_owners WHERE LOWER(email) = LOWER($1) LIMIT 1',
        [normalizedEmail]
      );
      if (boResult.rows[0]) {
        businessOwnerId = boResult.rows[0].id;
        firstName = firstName || boResult.rows[0].first_name;
        lastName = lastName || boResult.rows[0].last_name;
        phoneNumber = phoneNumber || boResult.rows[0].whatsapp_number || boResult.rows[0].phone;
      }
    } catch (error) {
      console.error('[Offboarding] Business owner lookup failed:', error.message);
    }

    try {
      const scResult = await pool.query(
        'SELECT first_name, last_name, phone FROM samcart_orders WHERE LOWER(email) = LOWER($1) ORDER BY created_at DESC LIMIT 1',
        [normalizedEmail]
      );
      if (scResult.rows[0]) {
        firstName = firstName || scResult.rows[0].first_name;
        lastName = lastName || scResult.rows[0].last_name;
        phoneNumber = phoneNumber || scResult.rows[0].phone;
      }
    } catch (error) {
      console.error('[Offboarding] SamCart lookup failed:', error.message);
    }
  }

  if (!displayName) {
    displayName = formatFullName(firstName, lastName) || normalizedEmail || 'Member';
  }

  if (!phoneNumber && phone) {
    phoneNumber = phone;
  }

  const teamMembers = [];
  const partners = [];

  if (businessOwnerId) {
    const tmResult = await pool.query(
      'SELECT first_name, last_name, email, phone FROM team_members WHERE business_owner_id = $1',
      [businessOwnerId]
    );
    tmResult.rows.forEach(row => {
      teamMembers.push({
        name: formatFullName(row.first_name, row.last_name) || row.email,
        email: row.email,
        phone: row.phone
      });
    });

    const partnerResult = await pool.query(
      'SELECT first_name, last_name, email, phone FROM c_level_partners WHERE business_owner_id = $1',
      [businessOwnerId]
    );
    partnerResult.rows.forEach(row => {
      partners.push({
        name: formatFullName(row.first_name, row.last_name) || row.email,
        email: row.email,
        phone: row.phone
      });
    });
  }

  return {
    email: normalizedEmail,
    firstName,
    lastName,
    displayName,
    phone: phoneNumber,
    businessOwnerId,
    teamMembers,
    partners
  };
}

async function performOffboardingActions(pool, context, thread, reasonLabel) {
  const results = {
    monday: null,
    teamMembers: [],
    circle: null,
    wasender: [],
    skippedPhones: []
  };

  const cancelDate = getDateKeyInTimeZone(new Date(), DEFAULT_TIMEZONE);

  results.monday = await updateBusinessOwnerStatusByEmail(context.email, 'Canceled', cancelDate);

  for (const member of context.teamMembers) {
    if (!member.email) continue;
    const updateResult = await updateTeamMemberStatusByEmail(member.email, 'Canceled');
    results.teamMembers.push({ email: member.email, ...updateResult });
  }

  const partnersWithOwner = [
    { name: context.displayName, email: context.email, phone: context.phone },
    ...context.partners
  ];

  results.circle = await removeMembersFromCircle(context.teamMembers, partnersWithOwner);

  const groupJids = [process.env.JID_AI, process.env.JID_TM, process.env.JID_BO].filter(Boolean);
  const contacts = [
    { name: context.displayName, email: context.email, phone: context.phone },
    ...context.partners,
    ...context.teamMembers
  ];

  const participants = new Map();
  for (const contact of contacts) {
    const normalized = normalizePhoneForWasender(contact.phone);
    if (!normalized) {
      results.skippedPhones.push({ name: contact.name, email: contact.email });
      continue;
    }
    participants.set(normalized, contact);
  }

  for (const groupJid of groupJids) {
    const response = await removeGroupParticipants(groupJid, Array.from(participants.keys()));
    results.wasender.push({ groupJid, ...response });
  }

  if (thread?.id) {
    const metadata = thread.metadata || {};
    if (!metadata.offboarded_at) {
      metadata.offboarded_at = new Date().toISOString();
      metadata.offboarding_reason = reasonLabel || null;
      await updateMemberThreadMetadata(pool, thread.id, metadata);
    }
  }

  return results;
}

// SamCart webhook handler
router.post('/samcart', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const payload = req.body;

    console.log('SamCart webhook received:', JSON.stringify(payload, null, 2));

    // SamCart sends different event types
    const eventType = payload.type || payload.event_type || payload.event?.type || payload.event?.event_type || payload.action || null;
    const mappedSubscriptionEventType = mapSubscriptionEventType(eventType);
    const rawStatus = payload.status || payload.subscription?.status || payload.charge?.status || null;
    const subscriptionEventType = refineSubscriptionEventType(mappedSubscriptionEventType, rawStatus);

    // Handle subscription events (monthly retries / cancellations)
    if (subscriptionEventType) {
      const email = extractSamcartEmail(payload);
      const phone = extractSamcartPhone(payload);
      const occurredAt = extractSamcartEventTimestamp(payload);
      const periodKey = getMonthKeyInTimeZone(occurredAt, DEFAULT_TIMEZONE);
      const eventKey = buildSamcartEventKey(payload, eventType);
      const amount = extractSamcartAmount(payload);
      const subscriptionId = extractSamcartSubscriptionId(payload);
      const orderId = extractSamcartOrderId(payload);
      const status = rawStatus;
      const failureChannelId = process.env.CA_PRO_FAILED_SLACK_CHANNEL || process.env.CA_PRO_NOTIFICATIONS_SLACK_CHANNEL;

      if (!email) {
        console.warn('[SamCart] Subscription event missing email');
      }

      const recordResult = await recordSubscriptionEvent(pool, {
        eventKey,
        eventType: subscriptionEventType,
        email,
        periodKey,
        subscriptionId,
        orderId,
        amount,
        currency: payload.currency || payload.order?.currency || 'USD',
        status,
        occurredAt,
        rawData: payload
      });

      const subscriptionEvent = recordResult?.event || null;
      const wasCreated = Boolean(recordResult?.created);

      // If SamCart retries delivery, we still want a chance to post Slack if we previously errored.
      if (subscriptionEvent?.slack_notified) {
        return res.status(200).json({ success: true, duplicate: !wasCreated, already_notified: true });
      }

      if (!email) {
        return res.status(200).json({ success: true, event: subscriptionEventType, skipped: 'missing_email' });
      }

      const context = await resolveMemberContext(pool, email, phone);
      const amountLabel = amount != null ? formatCurrency(amount) : 'N/A';
      const firstName = context.firstName || (context.displayName || '').split(' ')[0] || '';
      const displayName = context.displayName || email || 'Member';

      try {
        if (subscriptionEventType === 'charge_failed') {
          const existingThread = await getMemberThread(pool, email, 'monthly_bounce', periodKey);
          let lastRecoveryAt = null;
          if (existingThread?.metadata?.last_recovery_at) {
            const parsed = new Date(existingThread.metadata.last_recovery_at);
            if (!Number.isNaN(parsed.getTime())) {
              lastRecoveryAt = parsed;
            }
          }
          const attemptCount = await countSubscriptionFailures(pool, email, periodKey, lastRecoveryAt);
          const summaryText = `⚠️ Subscription Charge Failed (Attempt #${attemptCount})\n*Name:* ${displayName}\n*Email:* ${email || 'N/A'}\n*Amount:* ${amountLabel}`;
          const summaryBlocks = [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: summaryText }
            }
          ];

          const threadCreateParams = {
            email,
            name: displayName,
            threadType: 'monthly_bounce',
            periodKey,
            channelId: failureChannelId,
            summaryText,
            summaryBlocks,
            metadata: { period_key: periodKey }
          };

          const ensured = await ensureMemberThreadSlack(pool, threadCreateParams, failureChannelId);
          let thread = ensured.thread;

          if (!thread?.slack_channel_id || !thread?.slack_thread_ts) {
            throw new Error('Failed to create or load Slack thread for subscription failure');
          }

          const attemptMessage = `Attempt #${attemptCount}: Charge failed — ${amountLabel}`;
          thread = await postMessageToMemberThread(pool, thread, threadCreateParams, failureChannelId, attemptMessage, [
            { type: 'section', text: { type: 'mrkdwn', text: attemptMessage } }
          ]);

          if (attemptCount === 1) {
            const whatsappMessage = buildMonthlyBounceTemplate(firstName);
            const whatsappBlock = createWhatsAppCopyBlock(whatsappMessage);
            thread = await postMessageToMemberThread(pool, thread, threadCreateParams, failureChannelId, whatsappBlock.text, whatsappBlock.blocks);
          }

          if (attemptCount >= 4) {
            const alreadyOffboarded = thread?.metadata?.offboarded_at;
            const offboardResults = alreadyOffboarded ? null : await performOffboardingActions(pool, context, thread, 'delinquent');

            if (offboardResults && thread?.slack_channel_id && thread?.slack_thread_ts) {
              const summaryLines = [
                `🚫 Subscription delinquent after attempt #${attemptCount} — offboarding triggered.`,
                `• Monday BO status: ${offboardResults.monday?.success ? 'updated' : 'failed'}`,
                `• Team members updated: ${offboardResults.teamMembers.filter(t => t.success).length}`,
                `• Circle removals: ${offboardResults.circle?.removed || 0} (${offboardResults.circle?.errors?.length || 0} errors)`,
                `• WhatsApp removals: ${offboardResults.wasender.filter(r => r.success).length}/${offboardResults.wasender.length} groups`
              ];
              thread = await postMessageToMemberThread(pool, thread, threadCreateParams, failureChannelId, summaryLines.join('\n'), [
                { type: 'section', text: { type: 'mrkdwn', text: summaryLines.join('\n') } }
              ]);

              if (offboardResults.skippedPhones.length > 0) {
                const skippedLines = offboardResults.skippedPhones.map(p => `• ${p.name || 'Unknown'} (${p.email || 'no email'})`);
                const skippedText = `⚠️ Skipped WhatsApp removal (missing phone):\n${skippedLines.join('\n')}`;
                thread = await postMessageToMemberThread(pool, thread, threadCreateParams, failureChannelId, skippedText, [
                  { type: 'section', text: { type: 'mrkdwn', text: skippedText } }
                ]);
              }
            }
          }

          await markSubscriptionEventSlackNotified(pool, subscriptionEvent?.id);

          return res.status(200).json({ success: true, event: subscriptionEventType });
        }

        if (subscriptionEventType === 'charged' || subscriptionEventType === 'recovered') {
          const thread = await getMemberThread(pool, email, 'monthly_bounce', periodKey);
          if (thread?.slack_channel_id && thread?.slack_thread_ts) {
            const failures = await countSubscriptionFailures(pool, email, periodKey);
            const metadata = thread.metadata || {};
            if (failures > 0 && !metadata.recovery_posted_at) {
              const recoveryText = `✅ Payment recovered after ${failures} failed attempt${failures === 1 ? '' : 's'} — ${amountLabel}`;
              const threadCreateParams = {
                email,
                name: displayName,
                threadType: 'monthly_bounce',
                periodKey,
                channelId: failureChannelId,
                summaryText: recoveryText,
                summaryBlocks: [{ type: 'section', text: { type: 'mrkdwn', text: recoveryText } }],
                metadata: thread.metadata || { period_key: periodKey }
              };

              await postMessageToMemberThread(pool, thread, threadCreateParams, failureChannelId, recoveryText, [
                { type: 'section', text: { type: 'mrkdwn', text: recoveryText } }
              ]);

              metadata.recovery_posted_at = new Date().toISOString();
              metadata.last_recovery_at = metadata.recovery_posted_at;
              await updateMemberThreadMetadata(pool, thread.id, metadata);
            }
          }

          await markSubscriptionEventSlackNotified(pool, subscriptionEvent?.id);

          return res.status(200).json({ success: true, event: subscriptionEventType });
        }

        if (subscriptionEventType === 'delinquent') {
          const summaryText = `🚫 Subscription Delinquent\n*Name:* ${displayName}\n*Email:* ${email || 'N/A'}\n*Amount:* ${amountLabel}`;
          const summaryBlocks = [
            { type: 'section', text: { type: 'mrkdwn', text: summaryText } }
          ];

          const threadCreateParams = {
            email,
            name: displayName,
            threadType: 'monthly_bounce',
            periodKey,
            channelId: failureChannelId,
            summaryText,
            summaryBlocks,
            metadata: { period_key: periodKey }
          };

          const ensured = await ensureMemberThreadSlack(pool, threadCreateParams, failureChannelId);
          let thread = ensured.thread;
          if (!thread?.slack_channel_id || !thread?.slack_thread_ts) {
            throw new Error('Failed to create or load Slack thread for subscription delinquent');
          }

          // Always log the delinquent transition in the thread, even if offboarding already ran.
          const delinquentReply = `🚫 Subscription marked delinquent\n*Name:* ${displayName}\n*Email:* ${email || 'N/A'}\n*Amount:* ${amountLabel}`;
          thread = await postMessageToMemberThread(pool, thread, threadCreateParams, failureChannelId, delinquentReply, [
            { type: 'section', text: { type: 'mrkdwn', text: delinquentReply } }
          ]);

          const alreadyOffboarded = thread?.metadata?.offboarded_at;
          const offboardResults = alreadyOffboarded ? null : await performOffboardingActions(pool, context, thread, 'delinquent');

          if (offboardResults && thread?.slack_channel_id && thread?.slack_thread_ts) {
            const summaryLines = [
              `🚫 Subscription delinquent — offboarding triggered.`,
              `• Monday BO status: ${offboardResults.monday?.success ? 'updated' : 'failed'}`,
              `• Team members updated: ${offboardResults.teamMembers.filter(t => t.success).length}`,
              `• Circle removals: ${offboardResults.circle?.removed || 0} (${offboardResults.circle?.errors?.length || 0} errors)`,
              `• WhatsApp removals: ${offboardResults.wasender.filter(r => r.success).length}/${offboardResults.wasender.length} groups`
            ];
            thread = await postMessageToMemberThread(pool, thread, threadCreateParams, failureChannelId, summaryLines.join('\n'), [
              { type: 'section', text: { type: 'mrkdwn', text: summaryLines.join('\n') } }
            ]);

            if (offboardResults.skippedPhones.length > 0) {
              const skippedLines = offboardResults.skippedPhones.map(p => `• ${p.name || 'Unknown'} (${p.email || 'no email'})`);
              const skippedText = `⚠️ Skipped WhatsApp removal (missing phone):\n${skippedLines.join('\n')}`;
              thread = await postMessageToMemberThread(pool, thread, threadCreateParams, failureChannelId, skippedText, [
                { type: 'section', text: { type: 'mrkdwn', text: skippedText } }
              ]);
            }
          }

          await markSubscriptionEventSlackNotified(pool, subscriptionEvent?.id);

          return res.status(200).json({ success: true, event: subscriptionEventType });
        }

        if (subscriptionEventType === 'canceled') {
          const cancelDateKey = getDateKeyInTimeZone(occurredAt, DEFAULT_TIMEZONE);
          const summaryText = `🛑 Subscription Canceled\n*Name:* ${displayName}\n*Email:* ${email || 'N/A'}\n*Amount:* ${amountLabel}`;
          const summaryBlocks = [
            { type: 'section', text: { type: 'mrkdwn', text: summaryText } }
          ];

          const threadCreateParams = {
            email,
            name: displayName,
            threadType: 'cancel',
            periodKey: cancelDateKey,
            channelId: failureChannelId,
            summaryText,
            summaryBlocks,
            metadata: { cancel_date: cancelDateKey }
          };

          const ensured = await ensureMemberThreadSlack(pool, threadCreateParams, failureChannelId);
          let thread = ensured.thread;
          if (!thread?.slack_channel_id || !thread?.slack_thread_ts) {
            throw new Error('Failed to create or load Slack thread for subscription canceled');
          }

          // Always post at least one reply so we can detect deleted threads and repair.
          const cancelReply = `🛑 Subscription cancellation received\n*Name:* ${displayName}\n*Email:* ${email || 'N/A'}\n*Amount:* ${amountLabel}`;
          thread = await postMessageToMemberThread(pool, thread, threadCreateParams, failureChannelId, cancelReply, [
            { type: 'section', text: { type: 'mrkdwn', text: cancelReply } }
          ]);

          await pool.query(
            `
              INSERT INTO cancellations (member_email, member_name, source, slack_channel_id, slack_thread_ts, member_thread_id)
              SELECT $1, $2, $3, $4, $5, $6
              WHERE NOT EXISTS (
                SELECT 1 FROM cancellations WHERE member_thread_id = $6
              )
            `,
            [
              email,
              displayName,
              'samcart_webhook',
              thread?.slack_channel_id || null,
              thread?.slack_thread_ts || null,
              thread?.id || null
            ]
          );

          const alreadyOffboarded = thread?.metadata?.offboarded_at;
          const offboardResults = alreadyOffboarded ? null : await performOffboardingActions(pool, context, thread, 'canceled');

          if (offboardResults && thread?.slack_channel_id && thread?.slack_thread_ts) {
            const summaryLines = [
              `🛑 Cancellation received — offboarding triggered.`,
              `• Monday BO status: ${offboardResults.monday?.success ? 'updated' : 'failed'}`,
              `• Team members updated: ${offboardResults.teamMembers.filter(t => t.success).length}`,
              `• Circle removals: ${offboardResults.circle?.removed || 0} (${offboardResults.circle?.errors?.length || 0} errors)`,
              `• WhatsApp removals: ${offboardResults.wasender.filter(r => r.success).length}/${offboardResults.wasender.length} groups`
            ];
            thread = await postMessageToMemberThread(pool, thread, threadCreateParams, failureChannelId, summaryLines.join('\n'), [
              { type: 'section', text: { type: 'mrkdwn', text: summaryLines.join('\n') } }
            ]);

            if (offboardResults.skippedPhones.length > 0) {
              const skippedLines = offboardResults.skippedPhones.map(p => `• ${p.name || 'Unknown'} (${p.email || 'no email'})`);
              const skippedText = `⚠️ Skipped WhatsApp removal (missing phone):\n${skippedLines.join('\n')}`;
              thread = await postMessageToMemberThread(pool, thread, threadCreateParams, failureChannelId, skippedText, [
                { type: 'section', text: { type: 'mrkdwn', text: skippedText } }
              ]);
            }
          }

          await markSubscriptionEventSlackNotified(pool, subscriptionEvent?.id);

          return res.status(200).json({ success: true, event: subscriptionEventType });
        }

        return res.status(200).json({ success: true, event: subscriptionEventType });
      } catch (handlingError) {
        await markSubscriptionEventSlackError(pool, subscriptionEvent?.id, handlingError);
        throw handlingError;
      }
    }

    const isOrderEvent = isOrderEventType(eventType);
    if (!isOrderEvent) {
      console.log(`[SamCart] Ignoring non-order event: ${eventType || 'unknown'}`);
      return res.status(200).json({ success: true, ignored: true, event: eventType || null });
    }

    // Extract customer data from SamCart payload
    // SamCart typically sends: customer object with email, name, phone
    const customer = payload.customer || {};
    const order = payload.order || payload;

    const orderData = {
      samcart_order_id: order.id || order.order_id || null,
      event_type: eventType,
      email: customer.email || order.customer_email || order.email || null,
      first_name: customer.first_name || order.customer_first_name || order.first_name || null,
      last_name: customer.last_name || order.customer_last_name || order.last_name || null,
      phone: customer.phone || order.customer_phone || order.phone || null,
      product_name: order.product_name || order.product?.name || null,
      product_id: order.product_id || order.product?.id || null,
      order_total: order.total || order.order_total || null,
      currency: order.currency || 'USD',
      status: order.status || 'completed'
    };

    console.log('Parsed SamCart order:', orderData);

    // Skip if no email (required for linking)
    if (!orderData.email) {
      console.warn('SamCart webhook missing email, storing anyway');
    }

    // Check if order already exists
    if (orderData.samcart_order_id) {
      const existing = await pool.query(
        'SELECT id FROM samcart_orders WHERE samcart_order_id = $1',
        [orderData.samcart_order_id]
      );

      if (existing.rows.length > 0) {
        // Update existing order (e.g., status change)
        await pool.query(`
          UPDATE samcart_orders SET
            event_type = $1,
            status = $2,
            raw_data = $3,
            updated_at = CURRENT_TIMESTAMP
          WHERE samcart_order_id = $4
        `, [eventType, orderData.status, JSON.stringify(payload), orderData.samcart_order_id]);

        console.log(`Updated SamCart order: ${orderData.samcart_order_id}`);
        return res.status(200).json({ success: true, message: 'Order updated' });
      }
    }

    // Insert new order with welcome_sent = false (will be set to true after welcome is sent)
    const result = await pool.query(`
      INSERT INTO samcart_orders (
        samcart_order_id, event_type, email, first_name, last_name, phone,
        product_name, product_id, order_total, currency, status, raw_data, welcome_sent
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id
    `, [
      orderData.samcart_order_id,
      orderData.event_type,
      orderData.email,
      orderData.first_name,
      orderData.last_name,
      orderData.phone,
      orderData.product_name,
      orderData.product_id,
      orderData.order_total,
      orderData.currency,
      orderData.status,
      JSON.stringify(payload),
      false  // welcome_sent starts as false
    ]);

    // Try to link to Typeform application by email - set purchased_at timestamp
    if (orderData.email) {
      await pool.query(`
        UPDATE typeform_applications
        SET purchased_at = CURRENT_TIMESTAMP
        WHERE LOWER(email) = LOWER($1) AND purchased_at IS NULL
      `, [orderData.email]);
    }

    // Log activity - payment notification
    const customerName = [orderData.first_name, orderData.last_name].filter(Boolean).join(' ') || orderData.email || 'Unknown';
    await pool.query(`
      INSERT INTO activity_log (action, entity_type, entity_id, details)
      VALUES ($1, $2, $3, $4)
    `, ['new_payment', 'order', result.rows[0].id, JSON.stringify({
      name: customerName,
      email: orderData.email,
      product: orderData.product_name,
      amount: orderData.order_total,
      currency: orderData.currency
    })]);

    console.log(`New SamCart order received: ${result.rows[0].id}`);
    const orderId = result.rows[0].id;

    // If yearly renewal purchase, log in renewal thread (async)
    postYearlyPurchaseToRenewalThread(pool, orderData).catch(err => {
      console.error('[SamCart] Error posting yearly renewal purchase:', err.message);
    });

    // Post notification to #notifications-capro, then send welcome thread
    postSamCartNotification(pool, orderId, orderData).then(async (notifResult) => {
      if (!notifResult) return;

      // Look up Typeform data for this email
      let typeformData = null;
      if (orderData.email) {
        const tfResult = await pool.query(
          'SELECT * FROM typeform_applications WHERE LOWER(email) = LOWER($1) ORDER BY created_at DESC LIMIT 1',
          [orderData.email]
        );
        typeformData = tfResult.rows[0] || null;
      }

      // Get the full order with thread info
      const orderResult = await pool.query('SELECT * FROM samcart_orders WHERE id = $1', [orderId]);
      const fullOrder = orderResult.rows[0];

      if (orderData.email) {
        try {
          const contact = await resolveBusinessOwnerForWhatsAppAdd(pool, orderData.email, orderData);
          const groupKeys = resolveGroupKeysForRole('business_owner');
          const addResult = await addContactsToGroups({ contacts: [contact], groupKeys });
          const summaryText = buildWhatsAppAddSummary({
            label: `Business Owner ${contact.name || contact.email || ''}`.trim(),
            groupResults: addResult.groupResults,
            participantsCount: addResult.participants.length,
            skipped: addResult.skipped,
            missingGroupKeys: addResult.missingGroupKeys,
            hideParticipantCount: true
          });

          if (fullOrder?.slack_channel_id && fullOrder?.slack_thread_ts) {
            await postMessage(fullOrder.slack_channel_id, summaryText, [
              { type: 'section', text: { type: 'mrkdwn', text: summaryText } }
            ], fullOrder.slack_thread_ts);
          } else {
            console.log('[WhatsApp Add] Slack thread not found; skipping WhatsApp add log');
          }

          if (addResult.groupResults.some(result => result.result?.success)) {
            await pool.query(
              `
                UPDATE typeform_applications
                SET whatsapp_joined_at = CURRENT_TIMESTAMP
                WHERE LOWER(email) = LOWER($1) AND whatsapp_joined_at IS NULL
              `,
              [orderData.email]
            );
          }
        } catch (waError) {
          console.error('[WhatsApp Add] Failed to add BO to groups:', waError.message);
        }
      }

      if (fullOrder && fullOrder.slack_thread_ts) {
        // Send welcome thread immediately
        try {
          await sendWelcomeThread(fullOrder, typeformData, pool);

          // Mark welcome_sent = true
          await pool.query(
            'UPDATE samcart_orders SET welcome_sent = true, welcome_sent_at = NOW() WHERE id = $1',
            [orderId]
          );

          console.log(`[SamCart] Welcome thread sent for ${orderData.email}`);
        } catch (err) {
          console.error('[SamCart] Error sending welcome thread:', err);
        }
      }
    }).catch(err => {
      console.error('[SamCart] Error posting Slack notification:', err);
    });

    // Create Business Owner in Monday.com (async - don't block response)
    createBusinessOwnerInMonday(pool, orderId, orderData, payload).catch(err => {
      console.error('[SamCart] Error creating Monday Business Owner:', err);
    });

    res.status(200).json({
      success: true,
      order_id: orderId
    });
  } catch (error) {
    console.error('Error processing SamCart webhook:', error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

// Test endpoint for SamCart webhook
router.get('/samcart/test', (req, res) => {
  res.json({ message: 'SamCart webhook endpoint is active' });
});

/**
 * Send automated email on Typeform submission and create Slack thread
 */
async function sendAutomatedEmailAndSlackThread(pool, applicationId, fieldMapping) {
  const recipientEmail = fieldMapping.email;
  const firstName = fieldMapping.first_name || 'there';

  console.log(`[AutoEmail] Starting automated email/Slack flow for application ${applicationId}`);
  console.log(`[AutoEmail] Recipient: ${recipientEmail}, First Name: ${firstName}`);

  if (!recipientEmail) {
    console.log('[AutoEmail] No email in Typeform submission, skipping automated email');
    return;
  }

  const CALENDLY_URL = 'https://calendly.com/stefanpaulgeorgi/ca-pro-1-1-with-stefan';

  const subject = 'Thanks for applying to CA Pro';
  const body = `Hey ${firstName}, thanks for taking some time to apply to CA Pro. I'm reaching out directly to schedule a quick call to discuss the mastermind and see if it's a good fit for both sides.

Here's a calendar link where you can book a call: ${CALENDLY_URL}

If none of those times work for any reason, let me know and we'll find a time that does.

Best,
Stefan`;

  try {
    // Step 1: Post application notification to Slack (replaces Zapier)
    if (process.env.CA_PRO_APPLICATION_SLACK_CHANNEL_ID) {
      console.log('[AutoEmail] Posting application notification to Slack...');
      const slackResult = await postApplicationNotification(pool, applicationId, fieldMapping);
      if (slackResult) {
        console.log(`[AutoEmail] Application posted to Slack with ts: ${slackResult.messageTs}`);
      } else {
        console.log('[AutoEmail] Failed to post application to Slack');
      }
    }

    // Step 2: Try to send email (continue flow even if it fails)
    let emailSent = false;
    let emailError = null;
    let emailResult = null;

    // Check if Gmail is configured
    if (!process.env.STEF_GOOGLE_CLIENT_ID || !process.env.STEF_GOOGLE_REFRESH_TOKEN) {
      emailError = 'Gmail not configured - missing STEF_GOOGLE_CLIENT_ID or STEF_GOOGLE_REFRESH_TOKEN';
      console.log(`[AutoEmail] ${emailError}`);
    } else {
      console.log('[AutoEmail] Gmail credentials found, proceeding with email send');
      try {
        console.log(`[AutoEmail] Sending email to ${recipientEmail}...`);
        emailResult = await gmailService.sendEmail(recipientEmail, subject, body);
        emailSent = true;
        console.log(`[AutoEmail] Email sent successfully! Thread ID: ${emailResult.threadId}, Message ID: ${emailResult.messageId}`);

        // Create email thread record
        let slackThreadInfo = null;
        try {
          const slackResult = await pool.query(
            'SELECT slack_channel_id, slack_thread_ts FROM typeform_applications WHERE id = $1',
            [applicationId]
          );
          slackThreadInfo = slackResult.rows[0] || null;
        } catch (e) {
          slackThreadInfo = null;
        }

        await pool.query(`
          INSERT INTO email_threads (
            gmail_thread_id, gmail_message_id, typeform_application_id,
            recipient_email, recipient_first_name, subject, initial_email_sent_at, status,
            context_type, context_id, slack_channel_id, slack_thread_ts, recipient_name
          ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, 'sent', $7, $8, $9, $10, $11)
        `, [
          emailResult.threadId,
          emailResult.messageId,
          applicationId,
          recipientEmail,
          firstName,
          subject,
          'typeform_application',
          applicationId,
          slackThreadInfo?.slack_channel_id || null,
          slackThreadInfo?.slack_thread_ts || null,
          `${firstName}`.trim() || recipientEmail
        ]);

        // Update typeform_applications with emailed_at timestamp
        await pool.query(
          'UPDATE typeform_applications SET emailed_at = CURRENT_TIMESTAMP WHERE id = $1',
          [applicationId]
        );

        // Log activity
        await pool.query(`
          INSERT INTO activity_log (action, entity_type, entity_id, details)
          VALUES ($1, $2, $3, $4)
        `, ['email_sent', 'typeform_application', applicationId, JSON.stringify({
          email: recipientEmail,
          subject: subject,
          gmail_thread_id: emailResult.threadId
        })]);

        console.log(`[AutoEmail] Email records saved for ${recipientEmail}`);
      } catch (err) {
        emailError = err.message;
        console.error(`[AutoEmail] Email failed: ${emailError}`);

        // Log the error
        await pool.query(`
          INSERT INTO activity_log (action, entity_type, entity_id, details)
          VALUES ($1, $2, $3, $4)
        `, ['email_send_failed', 'typeform_application', applicationId, JSON.stringify({
          email: recipientEmail,
          error: emailError
        })]);
      }
    }

    // Step 3: Add WhatsApp template and email status to Slack thread
    if (process.env.CA_PRO_APPLICATION_SLACK_CHANNEL_ID) {
      const slackBlocks = require('../lib/slack-blocks');

      // Get stored thread info
      const threadResult = await pool.query(
        'SELECT slack_channel_id, slack_thread_ts FROM typeform_applications WHERE id = $1',
        [applicationId]
      );

      if (threadResult.rows[0]?.slack_thread_ts) {
        const { slack_channel_id: channelId, slack_thread_ts: threadTs } = threadResult.rows[0];

        // Post WhatsApp template
        const whatsappBlock = slackBlocks.createWhatsAppTemplateBlock(firstName);
        await postMessage(channelId, whatsappBlock.text, whatsappBlock.blocks, threadTs);

        // Post email status (success or error)
        if (emailSent) {
          const emailBlock = slackBlocks.createEmailSentBlock(recipientEmail, subject, body);
          await postMessage(channelId, emailBlock.text, emailBlock.blocks, threadTs);
          console.log(`[AutoEmail] Slack thread updated with email success for ${recipientEmail}`);
        } else {
          const errorBlock = slackBlocks.createEmailFailedBlock(recipientEmail, emailError);
          await postMessage(channelId, errorBlock.text, errorBlock.blocks, threadTs);
          console.log(`[AutoEmail] Slack thread updated with email error for ${recipientEmail}`);
        }

        // Log activity
        await pool.query(
          'INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4)',
          ['slack_thread_updated', 'typeform_application', applicationId, JSON.stringify({
            channel_id: channelId,
            thread_ts: threadTs,
            email: recipientEmail,
            email_sent: emailSent
          })]
        );
      } else {
        console.log('[AutoEmail] Could not update Slack thread - thread not found');
      }
    }

  } catch (error) {
    console.error('[AutoEmail] Error in automated email/Slack flow:', error);
    // Log the error but don't throw - this is a background process
    await pool.query(`
      INSERT INTO activity_log (action, entity_type, entity_id, details)
      VALUES ($1, $2, $3, $4)
    `, ['email_flow_error', 'typeform_application', applicationId, JSON.stringify({
      email: recipientEmail,
      error: error.message
    })]);
  }
}

module.exports = router;
