const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { gmailService } = require('../lib/gmail');
const { postApplicationNotification, createApplicationThread, postMessage } = require('./slack-threads');
const { createBusinessOwnerItem, businessOwnerExistsInMonday } = require('./monday');

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
  const amount = orderData.order_total ? parseFloat(orderData.order_total).toFixed(2) : 'N/A';

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Order ID:* ${orderData.samcart_order_id || 'N/A'}\n*Product:* ${orderData.product_name || 'CA Pro Membership'}\n*Amount:* ${amount}\n----------------------------------\n*Name:* ${customerName}\n*Email:* ${orderData.email || 'N/A'}`
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

// SamCart webhook handler
router.post('/samcart', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const payload = req.body;

    console.log('SamCart webhook received:', JSON.stringify(payload, null, 2));

    // SamCart sends different event types
    const eventType = payload.type || 'order'; // order, refund, subscription, etc.

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

    // Post notification to #notifications-capro (async - don't block response)
    postSamCartNotification(pool, result.rows[0].id, orderData).catch(err => {
      console.error('[SamCart] Error posting Slack notification:', err);
    });

    // Create Business Owner in Monday.com (async - don't block response)
    createBusinessOwnerInMonday(pool, result.rows[0].id, orderData, payload).catch(err => {
      console.error('[SamCart] Error creating Monday Business Owner:', err);
    });

    res.status(200).json({
      success: true,
      order_id: result.rows[0].id
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
        await pool.query(`
          INSERT INTO email_threads (
            gmail_thread_id, gmail_message_id, typeform_application_id,
            recipient_email, recipient_first_name, subject, initial_email_sent_at, status
          ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, 'sent')
        `, [
          emailResult.threadId,
          emailResult.messageId,
          applicationId,
          recipientEmail,
          firstName,
          subject
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
