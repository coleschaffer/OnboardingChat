const express = require('express');
const router = express.Router();
const { syncOnboardingToMonday } = require('./monday');

// Helper to convert revenue to generalized format
function generalizeRevenue(revenue) {
  if (!revenue) return null;
  if (/\d+\s*figures?/i.test(revenue)) return revenue;

  const cleanedRevenue = revenue.replace(/[$,]/g, '');
  const match = cleanedRevenue.match(/(\d+(?:\.\d+)?)\s*(k|m|million|thousand)?/i);

  if (match) {
    let num = parseFloat(match[1]);
    const suffix = (match[2] || '').toLowerCase();

    if (suffix === 'k' || suffix === 'thousand') num *= 1000;
    if (suffix === 'm' || suffix === 'million') num *= 1000000;

    if (num >= 100000000) return '9 figures';
    if (num >= 10000000) return '8 figures';
    if (num >= 1000000) return '7 figures';
    if (num >= 100000) return '6 figures';
    if (num >= 10000) return '5 figures';
  }

  return revenue;
}

// Generate welcome message using Claude
async function generateWelcomeMessage(memberData) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const fullName = [memberData.firstName, memberData.lastName].filter(Boolean).join(' ');
  const displayName = fullName || memberData.businessName || 'our newest member';

  if (!apiKey) {
    return `Welcome to CA Pro! We're excited to have ${displayName} in the community.`;
  }

  const generalizedRevenue = generalizeRevenue(memberData.typeformAnnualRevenue);

  const prompt = `You are writing a welcome message for a new CA Pro member to be posted in a WhatsApp group.

Here is ALL the member's information from their application:

CONTACT INFO:
- Name: ${fullName || 'Not provided'}
- Contact Preference: ${memberData.typeformContactPreference || 'Not provided'}

BUSINESS INFO:
- Business Name: ${memberData.businessName || 'Not provided'}
- Business Description: ${memberData.typeformBusinessDescription || 'Not provided'}
- Revenue Level: ${generalizedRevenue || 'Not provided'}
- Revenue Trend: ${memberData.typeformRevenueTrend || 'Not provided'}
- Has Team: ${memberData.typeformHasTeam || 'Not provided'}

GOALS & CHALLENGES:
- Main Challenge (#1 thing holding them back): ${memberData.typeformMainChallenge || 'Not provided'}
- Why they joined CA Pro: ${memberData.typeformWhyCaPro || 'Not provided'}

READINESS:
- Investment Readiness: ${memberData.typeformInvestmentReadiness || 'Not provided'}
- Decision Timeline: ${memberData.typeformDecisionTimeline || 'Not provided'}

ADDITIONAL:
- Anything else they shared: ${memberData.typeformAnythingElse || 'Not provided'}
- How they heard about CA Pro: ${memberData.typeformReferralSource || 'Not provided'}

IMPORTANT RULES:
1. NEVER include specific revenue numbers or dollar amounts. Only use general terms like "7 figures", "8 figures", "growing revenue", etc.
2. NEVER include email addresses or phone numbers.
3. Focus on what's interesting about their business and journey.

Write a warm, professional welcome message similar to these examples:

Example 1:
"Hey Everyone!

Please join me in giving a warm welcome to our newest CA Pro member, Apostolos Mentzos!

Apostolos is the founder of Hair Haven, a new ecommerce brand focused on men's supplements for hair growth. He also runs a successful car dealership and is now diving full force into the ecommerce space.

We're excited to have you here, Apostolos, and looking forward to supporting you on this next stage of your journey!"

Example 2:
"Hey everyone, please join me in extending a warm welcome to our newest Mastermind Member, Javier Velasco!

Javier is the founder of Luminara, a natural health and beauty products brand helping people enhance their well-being and appearance. With 7 figures in revenue and growing, Luminara is making significant strides in the health and wellness industry.

We're excited to have Javier join our community and look forward to supporting his journey to scale and grow Luminara.

Welcome Javier!"

Guidelines:
- Start with "Hey guys" or "Hey everyone" and extend a warm welcome
- Use their actual name - use first name naturally throughout
- Describe what they do / their business in 1-2 sentences - make it sound interesting
- If they have notable experience or achievements, mention them
- Mention why they're joining or what they hope to achieve
- End with a warm welcome using their first name
- Keep it 2-3 short paragraphs
- Be genuine and enthusiastic but not over the top
- Use the most relevant and interesting details
- If revenue is mentioned, ONLY use generalized terms (7 figures, 8 figures, etc.)

Write ONLY the welcome message, no additional commentary.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      throw new Error(`Claude API error: ${response.status}`);
    }

    const data = await response.json();
    return data.content[0]?.text || `Welcome to CA Pro, ${displayName}!`;
  } catch (error) {
    console.error('Error generating welcome message:', error);
    return `Welcome to CA Pro! We're excited to have ${displayName} in the community.`;
  }
}

// Send delayed welcome message to Slack
async function sendDelayedWelcome(samcartOrder, typeformData, pool) {
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  const SLACK_WELCOME_USER_ID = process.env.SLACK_WELCOME_USER_ID;
  const BASE_URL = process.env.BASE_URL || 'https://onboarding.copyaccelerator.com';

  if (!SLACK_BOT_TOKEN || !SLACK_WELCOME_USER_ID) {
    console.log('Slack not configured, skipping delayed welcome');
    return false;
  }

  // Build member data from Typeform + SamCart
  const memberData = {
    firstName: typeformData?.first_name || samcartOrder?.first_name || '',
    lastName: typeformData?.last_name || samcartOrder?.last_name || '',
    email: typeformData?.email || samcartOrder?.email || '',
    phone: typeformData?.phone || samcartOrder?.phone || '',
    businessName: typeformData?.business_description?.split(/[.,]/)[0] || '', // First part of description as business name
    typeformBusinessDescription: typeformData?.business_description || '',
    typeformAnnualRevenue: typeformData?.annual_revenue || '',
    typeformRevenueTrend: typeformData?.revenue_trend || '',
    typeformMainChallenge: typeformData?.main_challenge || '',
    typeformWhyCaPro: typeformData?.why_ca_pro || '',
    typeformContactPreference: typeformData?.contact_preference || '',
    typeformInvestmentReadiness: typeformData?.investment_readiness || '',
    typeformDecisionTimeline: typeformData?.decision_timeline || '',
    typeformHasTeam: typeformData?.has_team || '',
    typeformAnythingElse: typeformData?.anything_else || typeformData?.additional_info || '',
    typeformReferralSource: typeformData?.referral_source || ''
  };

  const fullName = [memberData.firstName, memberData.lastName].filter(Boolean).join(' ');
  const memberName = fullName || 'New Member';

  console.log(`Sending delayed welcome for: ${memberName} (${samcartOrder.email})`);

  // Open DM channel
  const openResponse = await fetch('https://slack.com/api/conversations.open', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify({ users: SLACK_WELCOME_USER_ID })
  });

  const openData = await openResponse.json();
  if (!openData.ok) {
    throw new Error(`Failed to open DM: ${openData.error}`);
  }

  const channelId = openData.channel.id;

  // Helper to send message
  async function sendMessage(blocks, text, threadTs = null) {
    const payload = { channel: channelId, blocks, text };
    if (threadTs) payload.thread_ts = threadTs;

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
      },
      body: JSON.stringify(payload)
    });
    return response.json();
  }

  // Parent message with delayed welcome indicator
  const parentResult = await sendMessage([
    {
      type: 'header',
      text: { type: 'plain_text', text: `🎉 New Member: ${memberName}`, emoji: true }
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Email:* ${memberData.email || 'N/A'}` }
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: '_⏰ Delayed welcome (OnboardingChat not completed after 1 hour) - View thread for details →_' }
      ]
    }
  ], `New member: ${memberName}`);

  if (!parentResult.ok) {
    throw new Error(`Failed to send parent message: ${parentResult.error}`);
  }

  const threadTs = parentResult.ts;
  await new Promise(resolve => setTimeout(resolve, 300));

  // Thread message 1: Typeform Data (if available)
  if (typeformData) {
    const typeformFields = [
      `*--- Contact Info ---*`,
      `*Q1-2 Name:* ${[typeformData.first_name, typeformData.last_name].filter(Boolean).join(' ') || 'N/A'}`,
      `*Q3 Email:* ${typeformData.email || 'N/A'}`,
      `*Q4 Phone:* ${typeformData.phone || 'N/A'}`,
      `*Q5 Best Way to Reach:* ${typeformData.contact_preference || 'N/A'}`,
      ``,
      `*--- Business Info ---*`,
      `*Q6 Business:* ${typeformData.business_description || 'N/A'}`,
      `*Q7 Annual Revenue:* ${typeformData.annual_revenue || 'N/A'}`,
      `*Q8 Revenue Trend:* ${typeformData.revenue_trend || 'N/A'}`,
      ``,
      `*--- Goals & Challenges ---*`,
      `*Q9 #1 Challenge:* ${typeformData.main_challenge || 'N/A'}`,
      `*Q10 Why CA Pro:* ${typeformData.why_ca_pro || 'N/A'}`,
      ``,
      `*--- Readiness ---*`,
      `*Q11 Investment Ready:* ${typeformData.investment_readiness || 'N/A'}`,
      `*Q12 Timeline:* ${typeformData.decision_timeline || 'N/A'}`,
      `*Q13 Has Team:* ${typeformData.has_team || 'N/A'}`,
      ``,
      `*--- Additional ---*`,
      `*Q14 Anything Else:* ${typeformData.anything_else || typeformData.additional_info || 'N/A'}`,
      `*Q15 Referral Source:* ${typeformData.referral_source || 'N/A'}`
    ];

    await sendMessage([
      {
        type: 'header',
        text: { type: 'plain_text', text: `📝 Typeform Application (All 15 Questions)`, emoji: true }
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: typeformFields.join('\n') }
      }
    ], `Typeform data for ${memberName}`, threadTs);

    await new Promise(resolve => setTimeout(resolve, 300));
  }

  // Thread message 2: SamCart Data
  const samcartFields = [
    `*Product:* ${samcartOrder.product_name || 'N/A'}`,
    `*Order Total:* ${samcartOrder.order_total ? `$${samcartOrder.order_total}` : 'N/A'}`,
    `*Order ID:* ${samcartOrder.samcart_order_id || 'N/A'}`,
    `*Status:* ${samcartOrder.status || 'N/A'}`,
    `*Email:* ${samcartOrder.email || 'N/A'}`,
    `*Name:* ${[samcartOrder.first_name, samcartOrder.last_name].filter(Boolean).join(' ') || 'N/A'}`
  ];

  await sendMessage([
    {
      type: 'header',
      text: { type: 'plain_text', text: `💳 SamCart Purchase`, emoji: true }
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: samcartFields.join('\n\n') }
    }
  ], `SamCart data for ${memberName}`, threadTs);

  await new Promise(resolve => setTimeout(resolve, 300));

  // Thread message 3: Note about missing OnboardingChat
  await sendMessage([
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `⚠️ *Note:* This member has not completed the OnboardingChat yet. The welcome message below is generated from Typeform application data only.` }
    }
  ], `OnboardingChat not completed`, threadTs);

  await new Promise(resolve => setTimeout(resolve, 300));

  // Thread message 4: Generated welcome message
  const welcomeMessage = await generateWelcomeMessage(memberData);
  const copyUrl = `${BASE_URL}/copy.html?text=${encodeURIComponent(welcomeMessage)}`;

  await sendMessage([
    {
      type: 'header',
      text: { type: 'plain_text', text: '✨ Generated Welcome Message', emoji: true }
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: welcomeMessage }
    },
    {
      type: 'divider'
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '📋 Copy to Clipboard', emoji: true },
          url: copyUrl,
          style: 'primary'
        }
      ]
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: '_Reply in this thread to request changes to the welcome message._' }
      ]
    }
  ], `Welcome message for ${memberName}`, threadTs);

  console.log(`Delayed welcome sent successfully for ${memberName}`);
  return true;
}

// Process delayed welcomes - called by Railway cron job
router.post('/process-delayed-welcomes', async (req, res) => {
  try {
    // Verify secret key
    const secretKey = req.headers['x-cron-secret'] || req.body.secret;
    const expectedSecret = process.env.CRON_SECRET;

    if (!expectedSecret) {
      console.error('CRON_SECRET not configured');
      return res.status(500).json({ error: 'Server not configured for cron jobs' });
    }

    if (secretKey !== expectedSecret) {
      console.error('Invalid cron secret provided');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const pool = req.app.locals.pool;
    console.log('Processing delayed welcomes...');

    // Find SamCart orders created more than 1 hour ago that haven't had welcome sent
    const pendingOrders = await pool.query(`
      SELECT * FROM samcart_orders
      WHERE welcome_sent = false
        AND created_at < NOW() - INTERVAL '1 hour'
        AND status = 'completed'
      ORDER BY created_at ASC
      LIMIT 10
    `);

    console.log(`Found ${pendingOrders.rows.length} pending orders to process`);

    const results = {
      processed: 0,
      skipped_has_onboarding: 0,
      skipped_no_typeform: 0,
      sent: 0,
      errors: []
    };

    for (const order of pendingOrders.rows) {
      try {
        // Check if this user has completed OnboardingChat
        // Match by email → phone → name
        let hasOnboarding = false;
        let conditions = [];
        let params = [];

        if (order.email) {
          conditions.push(`LOWER(bo.email) = LOWER($${params.length + 1})`);
          params.push(order.email);
        }
        if (order.phone) {
          const cleanPhone = order.phone.replace(/\D/g, '');
          if (cleanPhone.length >= 10) {
            conditions.push(`REPLACE(REPLACE(REPLACE(bo.phone, '-', ''), ' ', ''), '+', '') LIKE '%' || $${params.length + 1}`);
            params.push(cleanPhone.slice(-10));
          }
        }
        if (order.first_name && order.last_name) {
          conditions.push(`(LOWER(bo.first_name) = LOWER($${params.length + 1}) AND LOWER(bo.last_name) = LOWER($${params.length + 2}))`);
          params.push(order.first_name, order.last_name);
        }

        if (conditions.length > 0) {
          const onboardingResult = await pool.query(`
            SELECT bo.id FROM business_owners bo
            WHERE bo.source = 'chat_onboarding'
              AND bo.onboarding_status = 'completed'
              AND (${conditions.join(' OR ')})
            LIMIT 1
          `, params);

          hasOnboarding = onboardingResult.rows.length > 0;
        }

        if (hasOnboarding) {
          // User completed OnboardingChat - mark welcome_sent to prevent future processing
          // The OnboardingChat flow already sent (or will send) the welcome
          await pool.query(`
            UPDATE samcart_orders
            SET welcome_sent = true, welcome_sent_at = NOW()
            WHERE id = $1
          `, [order.id]);

          results.skipped_has_onboarding++;
          console.log(`Skipped ${order.email} - has OnboardingChat submission`);
          continue;
        }

        // Look for Typeform data with same matching strategy
        let typeformData = null;
        conditions = [];
        params = [];

        if (order.email) {
          conditions.push(`LOWER(email) = LOWER($${params.length + 1})`);
          params.push(order.email);
        }
        if (order.phone) {
          const cleanPhone = order.phone.replace(/\D/g, '');
          if (cleanPhone.length >= 10) {
            conditions.push(`REPLACE(REPLACE(REPLACE(phone, '-', ''), ' ', ''), '+', '') LIKE '%' || $${params.length + 1}`);
            params.push(cleanPhone.slice(-10));
          }
        }
        if (order.first_name && order.last_name) {
          conditions.push(`(LOWER(first_name) = LOWER($${params.length + 1}) AND LOWER(last_name) = LOWER($${params.length + 2}))`);
          params.push(order.first_name, order.last_name);
        }

        if (conditions.length > 0) {
          const typeformResult = await pool.query(`
            SELECT * FROM typeform_applications
            WHERE ${conditions.join(' OR ')}
            ORDER BY created_at DESC
            LIMIT 1
          `, params);

          if (typeformResult.rows.length > 0) {
            typeformData = typeformResult.rows[0];
          }
        }

        if (!typeformData) {
          // No Typeform data - skip (can't generate meaningful welcome without application info)
          results.skipped_no_typeform++;
          console.log(`Skipped ${order.email} - no Typeform application found`);
          continue;
        }

        // Send delayed welcome
        const sent = await sendDelayedWelcome(order, typeformData, pool);

        if (sent) {
          // Mark welcome_sent
          await pool.query(`
            UPDATE samcart_orders
            SET welcome_sent = true, welcome_sent_at = NOW()
            WHERE id = $1
          `, [order.id]);

          // Log to activity feed
          await pool.query(`
            INSERT INTO activity_log (action, entity_type, entity_id, details)
            VALUES ($1, $2, $3, $4)
          `, [
            'delayed_welcome_sent',
            'samcart_order',
            order.id,
            JSON.stringify({
              email: order.email,
              name: [order.first_name, order.last_name].filter(Boolean).join(' '),
              typeform_id: typeformData.id,
              reason: 'OnboardingChat not completed within 1 hour'
            })
          ]);

          results.sent++;
          console.log(`Sent delayed welcome for ${order.email}`);
        }

        results.processed++;
      } catch (error) {
        console.error(`Error processing order ${order.id}:`, error);
        results.errors.push({ order_id: order.id, email: order.email, error: error.message });
      }
    }

    console.log('Delayed welcome processing complete:', results);
    res.json({
      success: true,
      ...results
    });
  } catch (error) {
    console.error('Error processing delayed welcomes:', error);
    res.status(500).json({ error: 'Failed to process delayed welcomes' });
  }
});

// Process pending Monday.com syncs - called by Railway cron job
router.post('/process-monday-syncs', async (req, res) => {
  try {
    // Verify secret key
    const secretKey = req.headers['x-cron-secret'] || req.body.secret;
    const expectedSecret = process.env.CRON_SECRET;

    if (!expectedSecret) {
      console.error('CRON_SECRET not configured');
      return res.status(500).json({ error: 'Server not configured for cron jobs' });
    }

    if (secretKey !== expectedSecret) {
      console.error('Invalid cron secret provided');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const pool = req.app.locals.pool;
    console.log('Processing pending Monday.com syncs...');

    // Find completed onboarding submissions that need Monday sync
    // monday_sync_scheduled_at is in the past and monday_synced is false
    // Only try syncs scheduled within the last 2 hours (prevent infinite retries)
    const pendingSyncs = await pool.query(`
      SELECT os.*, bo.email as business_owner_email
      FROM onboarding_submissions os
      LEFT JOIN business_owners bo ON os.business_owner_id = bo.id
      WHERE os.monday_sync_scheduled_at IS NOT NULL
        AND os.monday_sync_scheduled_at <= NOW()
        AND os.monday_sync_scheduled_at >= NOW() - INTERVAL '2 hours'
        AND os.monday_synced = false
        AND os.is_complete = true
      ORDER BY os.monday_sync_scheduled_at ASC
      LIMIT 10
    `);

    console.log(`Found ${pendingSyncs.rows.length} pending Monday syncs to process`);

    const results = {
      processed: 0,
      synced: 0,
      skipped: 0,
      errors: []
    };

    for (const submission of pendingSyncs.rows) {
      try {
        const data = submission.data || {};
        const teamMembers = data.teamMembers || [];
        const partners = data.cLevelPartners || data.partners || [];
        const businessOwnerEmail = submission.business_owner_email || data.answers?.email;

        if (!businessOwnerEmail) {
          console.log(`[Monday] Skipping submission ${submission.id} - no business owner email`);
          results.skipped++;

          // Mark as synced to prevent retry (can't sync without email)
          await pool.query(`
            UPDATE onboarding_submissions
            SET monday_synced = true, monday_synced_at = NOW()
            WHERE id = $1
          `, [submission.id]);
          continue;
        }

        if (teamMembers.length === 0 && partners.length === 0) {
          console.log(`[Monday] Skipping submission ${submission.id} - no team members or partners`);
          results.skipped++;

          // Mark as synced (nothing to sync)
          await pool.query(`
            UPDATE onboarding_submissions
            SET monday_synced = true, monday_synced_at = NOW()
            WHERE id = $1
          `, [submission.id]);
          continue;
        }

        console.log(`[Monday] Processing sync for ${businessOwnerEmail} (${teamMembers.length} team members, ${partners.length} partners)`);

        // Sync to Monday.com
        const syncResult = await syncOnboardingToMonday(data, businessOwnerEmail, pool);

        // Check if Business Owner wasn't found - if so, DON'T mark as synced to allow retry
        const teamMembersBONotFound = syncResult.teamMembers?.businessOwnerNotFound;
        const partnersBONotFound = syncResult.partners?.businessOwnerNotFound;

        if ((teamMembersBONotFound && teamMembers.length > 0) || (partnersBONotFound && partners.length > 0)) {
          console.log(`[Monday] Business Owner not in Monday yet - will retry sync on next cron run`);
          // Don't mark as synced - will retry on next cron
          results.processed++;
          continue;
        }

        // Check if there were errors - if all items failed, don't mark as synced
        const totalToSync = teamMembers.length + partners.length;
        const totalSynced = syncResult.totalSynced || 0;
        const totalErrors = syncResult.totalErrors || 0;

        if (totalToSync > 0 && totalSynced === 0 && totalErrors > 0) {
          console.log(`[Monday] All items failed to sync (${totalErrors} errors) - will retry on next cron run`);
          results.errors.push({
            submission_id: submission.id,
            error: `All ${totalErrors} items failed to sync`
          });
          results.processed++;
          continue;
        }

        // Mark as synced (either succeeded or nothing to sync)
        await pool.query(`
          UPDATE onboarding_submissions
          SET monday_synced = true, monday_synced_at = NOW()
          WHERE id = $1
        `, [submission.id]);

        results.synced++;
        results.processed++;

        console.log(`[Monday] Sync complete for ${businessOwnerEmail}: ${syncResult.totalSynced} synced, ${syncResult.totalErrors} errors`);
      } catch (error) {
        console.error(`[Monday] Error processing submission ${submission.id}:`, error);
        results.errors.push({
          submission_id: submission.id,
          error: error.message
        });
      }
    }

    console.log('Monday sync processing complete:', results);
    res.json({
      success: true,
      ...results
    });
  } catch (error) {
    console.error('Error processing Monday syncs:', error);
    res.status(500).json({ error: 'Failed to process Monday syncs' });
  }
});

// Health check for cron job monitoring
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = router;
