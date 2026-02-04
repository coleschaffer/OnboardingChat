const express = require('express');
const router = express.Router();
const { syncOnboardingToMonday, createBusinessOwnerItem, businessOwnerExistsInMonday, updateBusinessOwnerCompany } = require('./monday');
const { gmailService } = require('../lib/gmail');
const { postReplyNotification } = require('./slack-threads');

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
      `*Name:* ${[typeformData.first_name, typeformData.last_name].filter(Boolean).join(' ') || 'N/A'}`,
      `*Email:* ${typeformData.email || 'N/A'}`,
      `*Phone:* ${typeformData.phone || 'N/A'}`,
      `*Best Way to Reach:* ${typeformData.contact_preference || 'N/A'}`,
      ``,
      `*--- Business Info ---*`,
      `*Business:* ${typeformData.business_description || 'N/A'}`,
      `*Annual Revenue:* ${typeformData.annual_revenue || 'N/A'}`,
      `*Revenue Trend:* ${typeformData.revenue_trend || 'N/A'}`,
      ``,
      `*--- Goals & Challenges ---*`,
      `*#1 Challenge:* ${typeformData.main_challenge || 'N/A'}`,
      `*Why CA Pro:* ${typeformData.why_ca_pro || 'N/A'}`,
      ``,
      `*--- Readiness ---*`,
      `*Investment Ready:* ${typeformData.investment_readiness || 'N/A'}`,
      `*Timeline:* ${typeformData.decision_timeline || 'N/A'}`,
      `*Has Team:* ${typeformData.has_team || 'N/A'}`,
      ``,
      `*--- Additional ---*`,
      `*Anything Else:* ${typeformData.anything_else || typeformData.additional_info || 'N/A'}`,
      `*Referral Source:* ${typeformData.referral_source || 'N/A'}`
    ];

    await sendMessage([
      {
        type: 'header',
        text: { type: 'plain_text', text: `📝 Typeform Application`, emoji: true }
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

        // Check if Monday is not configured - if so, DON'T mark as synced to allow retry when configured
        if (syncResult.notConfigured) {
          console.log(`[Monday] Monday.com API not configured - will retry sync on next cron run when configured`);
          results.processed++;
          continue;
        }

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

// Process email replies - check tracked Gmail threads for new replies
router.post('/process-email-replies', async (req, res) => {
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

    // Check if Gmail is configured
    if (!process.env.STEF_GOOGLE_CLIENT_ID || !process.env.STEF_GOOGLE_REFRESH_TOKEN) {
      console.log('Gmail not configured, skipping email reply check');
      return res.json({ success: true, skipped: true, reason: 'Gmail not configured' });
    }

    const pool = req.app.locals.pool;
    console.log('Checking for email replies...');

    // Get all email threads to check for new replies
    // Includes both threads with no replies yet AND threads that already have replies (for multi-reply detection)
    const threadsResult = await pool.query(`
      SELECT et.*, ta.first_name, ta.last_name
      FROM email_threads et
      LEFT JOIN typeform_applications ta ON et.typeform_application_id = ta.id
      WHERE et.gmail_thread_id IS NOT NULL
        AND et.status IN ('sent', 'replied')
      ORDER BY et.created_at ASC
      LIMIT 50
    `);

    const results = {
      checked: 0,
      replies_found: 0,
      errors: []
    };

    for (const thread of threadsResult.rows) {
      try {
        results.checked++;

        const replyCheck = await gmailService.checkForReplies(
          thread.gmail_thread_id,
          thread.gmail_message_id
        );

        // Check if there are new replies (more than we've seen before)
        const previousReplyCount = thread.reply_count || 0;
        const hasNewReplies = replyCheck.hasReply && replyCheck.replyCount > previousReplyCount;

        if (hasNewReplies) {
          const newReplyCount = replyCheck.replyCount - previousReplyCount;
          results.replies_found += newReplyCount;
          console.log(`${newReplyCount} new reply(s) found for ${thread.recipient_email} (total: ${replyCheck.replyCount})`);

          // Update email_threads record
          await pool.query(`
            UPDATE email_threads SET
              has_reply = true,
              reply_received_at = CURRENT_TIMESTAMP,
              reply_count = $1,
              last_reply_snippet = $2,
              last_reply_body = $3,
              status = 'replied'
            WHERE id = $4
          `, [
            replyCheck.replyCount,
            replyCheck.latestReply?.snippet,
            replyCheck.latestReply?.body,
            thread.id
          ]);

          // Update typeform_applications with replied_at timestamp
          if (thread.typeform_application_id) {
            await pool.query(
              'UPDATE typeform_applications SET replied_at = CURRENT_TIMESTAMP WHERE id = $1 AND replied_at IS NULL',
              [thread.typeform_application_id]
            );
          }

          // Log activity
          await pool.query(`
            INSERT INTO activity_log (action, entity_type, entity_id, details)
            VALUES ($1, $2, $3, $4)
          `, ['email_reply_received', 'typeform_application', thread.typeform_application_id, JSON.stringify({
            email: thread.recipient_email,
            gmail_thread_id: thread.gmail_thread_id,
            reply_snippet: replyCheck.latestReply?.snippet?.substring(0, 100),
            reply_count: replyCheck.replyCount
          })]);

          // Post notification to Slack thread
          if (thread.typeform_application_id) {
            try {
              const recipientName = `${thread.first_name || ''} ${thread.last_name || ''}`.trim() || thread.recipient_email;
              await postReplyNotification(
                pool,
                thread.typeform_application_id,
                recipientName,
                thread.recipient_email,
                replyCheck.latestReply?.snippet,
                replyCheck.latestReply?.body,
                thread.gmail_thread_id
              );
              console.log(`Posted reply notification to Slack for ${thread.recipient_email}`);
            } catch (slackError) {
              console.error('Failed to post Slack notification:', slackError.message);
            }
          }
        }
      } catch (error) {
        console.error(`Error checking thread ${thread.id}:`, error.message);
        results.errors.push({ thread_id: thread.id, error: error.message });
      }
    }

    console.log('Email reply check complete:', results);
    res.json({
      success: true,
      ...results
    });
  } catch (error) {
    console.error('Error processing email replies:', error);
    res.status(500).json({ error: 'Failed to process email replies' });
  }
});

// Process pending email sends (30-second undo window)
router.post('/process-pending-emails', async (req, res) => {
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

    // Check if Gmail is configured
    if (!process.env.STEF_GOOGLE_CLIENT_ID || !process.env.STEF_GOOGLE_REFRESH_TOKEN) {
      console.log('Gmail not configured, skipping pending email processing');
      return res.json({ success: true, skipped: true, reason: 'Gmail not configured' });
    }

    const pool = req.app.locals.pool;
    console.log('Processing pending email sends...');

    // Find pending emails whose send_at time has passed
    const pendingResult = await pool.query(`
      SELECT pe.*, ta.first_name, ta.last_name
      FROM pending_email_sends pe
      LEFT JOIN typeform_applications ta ON pe.typeform_application_id = ta.id
      WHERE pe.status = 'pending'
        AND pe.send_at <= NOW()
      ORDER BY pe.send_at ASC
      LIMIT 20
    `);

    const results = {
      processed: 0,
      sent: 0,
      errors: []
    };

    const slackBlocks = require('../lib/slack-blocks');
    const { postMessage } = require('./slack-threads');

    for (const pending of pendingResult.rows) {
      results.processed++;

      try {
        // Get the existing thread to reply to
        let threadId = pending.gmail_thread_id;
        let messageId = null;

        // If we have a thread ID, get the latest message ID for proper threading
        if (threadId) {
          try {
            const thread = await gmailService.getThread(threadId);
            if (thread.messages && thread.messages.length > 0) {
              const lastMessage = thread.messages[thread.messages.length - 1];
              messageId = lastMessage.payload.headers.find(h => h.name.toLowerCase() === 'message-id')?.value;
            }
          } catch (e) {
            console.log('Could not get thread for reply:', e.message);
          }
        }

        // Send the email
        const subject = pending.subject || 'Re: Thanks for applying to CA Pro';
        const emailResult = await gmailService.sendEmail(
          pending.to_email,
          subject,
          pending.body,
          threadId,
          messageId
        );

        // Update pending email status
        await pool.query(`
          UPDATE pending_email_sends SET
            status = 'sent',
            sent_at = CURRENT_TIMESTAMP,
            gmail_thread_id = $1
          WHERE id = $2
        `, [emailResult.threadId, pending.id]);

        // Log activity
        await pool.query(`
          INSERT INTO activity_log (action, entity_type, entity_id, details)
          VALUES ($1, $2, $3, $4)
        `, ['email_reply_sent', 'typeform_application', pending.typeform_application_id, JSON.stringify({
          email: pending.to_email,
          gmail_thread_id: emailResult.threadId,
          user_id: pending.user_id
        })]);

        // Post confirmation to Slack thread
        if (pending.channel_id && pending.thread_ts) {
          try {
            const confirmBlock = slackBlocks.createEmailSentConfirmationBlock(
              pending.to_email,
              pending.body
            );
            await postMessage(
              pending.channel_id,
              confirmBlock.text,
              confirmBlock.blocks,
              pending.thread_ts
            );
          } catch (slackError) {
            console.error('Failed to post Slack confirmation:', slackError.message);
          }
        }

        results.sent++;
        console.log(`Sent pending email to ${pending.to_email}`);

      } catch (error) {
        console.error(`Error sending pending email ${pending.id}:`, error.message);

        // Mark as failed
        await pool.query(`
          UPDATE pending_email_sends SET
            status = 'failed',
            error_message = $1
          WHERE id = $2
        `, [error.message, pending.id]);

        results.errors.push({ pending_id: pending.id, error: error.message });
      }
    }

    console.log('Pending email processing complete:', results);
    res.json({
      success: true,
      ...results
    });
  } catch (error) {
    console.error('Error processing pending emails:', error);
    res.status(500).json({ error: 'Failed to process pending emails' });
  }
});

// Reset Monday sync for testing - requires cron secret
router.post('/reset-monday-sync', async (req, res) => {
  try {
    const secretKey = req.headers['x-cron-secret'] || req.body.secret;
    const expectedSecret = process.env.CRON_SECRET;

    if (!expectedSecret || secretKey !== expectedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const pool = req.app.locals.pool;

    const result = await pool.query(`
      UPDATE onboarding_submissions
      SET monday_synced = false,
          monday_synced_at = NULL,
          monday_sync_scheduled_at = NOW()
      WHERE is_complete = true
        AND monday_synced = true
        AND created_at > NOW() - INTERVAL '24 hours'
      RETURNING id, session_id
    `);

    console.log(`[Monday] Reset ${result.rowCount} submissions for Monday sync retry`);
    res.json({
      success: true,
      reset: result.rowCount,
      submissions: result.rows
    });
  } catch (error) {
    console.error('Error resetting Monday sync:', error);
    res.status(500).json({ error: 'Failed to reset Monday sync' });
  }
});

// Delete Typeform application by email for re-testing
// This allows the Typeform webhook to be processed again for the same email
router.post('/reset-typeform-test', async (req, res) => {
  try {
    const secretKey = req.headers['x-cron-secret'] || req.body.secret;
    const expectedSecret = process.env.CRON_SECRET;

    if (!expectedSecret || secretKey !== expectedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const pool = req.app.locals.pool;

    // First get the application ID
    const appResult = await pool.query(
      'SELECT id FROM typeform_applications WHERE LOWER(email) = LOWER($1) ORDER BY created_at DESC LIMIT 1',
      [email]
    );

    if (appResult.rows.length === 0) {
      return res.json({
        success: true,
        message: `No Typeform application found for ${email}`,
        deleted: {
          typeform_applications: 0,
          email_threads: 0
        }
      });
    }

    const appId = appResult.rows[0].id;

    // Delete related email_threads
    const emailThreadsResult = await pool.query(
      'DELETE FROM email_threads WHERE typeform_application_id = $1 RETURNING id',
      [appId]
    );

    // Delete the typeform application
    const deleteResult = await pool.query(
      'DELETE FROM typeform_applications WHERE id = $1 RETURNING id, email, first_name',
      [appId]
    );

    console.log(`[Test] Deleted Typeform application for ${email}: app=${appId}, threads=${emailThreadsResult.rowCount}`);

    res.json({
      success: true,
      message: `Deleted Typeform application for ${email}. You can now re-submit the Typeform to test the flow.`,
      deleted: {
        typeform_applications: deleteResult.rowCount,
        email_threads: emailThreadsResult.rowCount,
        application_id: appId
      }
    });
  } catch (error) {
    console.error('Error resetting Typeform test:', error);
    res.status(500).json({ error: 'Failed to reset Typeform test' });
  }
});

// Manually trigger email/Slack flow for an existing application (for testing)
router.post('/trigger-email-flow', async (req, res) => {
  try {
    const secretKey = req.headers['x-cron-secret'] || req.body.secret;
    const expectedSecret = process.env.CRON_SECRET;

    if (!expectedSecret || secretKey !== expectedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const pool = req.app.locals.pool;

    // Find the most recent application for this email
    const appResult = await pool.query(`
      SELECT id, first_name, last_name, email, emailed_at, slack_thread_ts
      FROM typeform_applications
      WHERE LOWER(email) = LOWER($1)
      ORDER BY created_at DESC
      LIMIT 1
    `, [email]);

    if (appResult.rows.length === 0) {
      return res.status(404).json({ error: `No Typeform application found for ${email}` });
    }

    const app = appResult.rows[0];

    // Import the function from webhooks
    const { sendAutomatedEmailAndSlackThread } = require('./webhooks-helpers');

    // Build fieldMapping
    const fieldMapping = {
      email: app.email,
      first_name: app.first_name,
      last_name: app.last_name
    };

    console.log(`[Test] Manually triggering email/Slack flow for ${email}`);

    // Check current state
    const currentState = {
      emailed_at: app.emailed_at,
      slack_thread_ts: app.slack_thread_ts
    };

    // Re-run the email/Slack flow
    // Note: This will skip if email already sent (emailed_at is set)
    // For a full retest, use reset-typeform-test first

    res.json({
      success: true,
      message: `Triggering email/Slack flow for ${email}. Check Railway logs for details.`,
      application_id: app.id,
      current_state: currentState,
      note: currentState.emailed_at ?
        'Email was already sent. Use reset-typeform-test first to fully retest.' :
        'Email will be sent now.'
    });

  } catch (error) {
    console.error('Error triggering email flow:', error);
    res.status(500).json({ error: 'Failed to trigger email flow' });
  }
});

// Process pending Monday Business Owner creations - retry failed/missing ones
router.post('/process-monday-business-owners', async (req, res) => {
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
    console.log('[Monday] Processing pending Business Owner creations...');

    // Find SamCart orders from the last 24 hours without monday_item_id
    const pendingOrders = await pool.query(`
      SELECT id, samcart_order_id, email, first_name, last_name, phone,
             product_name, order_total, raw_data, created_at
      FROM samcart_orders
      WHERE monday_item_id IS NULL
        AND email IS NOT NULL
        AND created_at > NOW() - INTERVAL '24 hours'
        AND status = 'completed'
      ORDER BY created_at ASC
      LIMIT 20
    `);

    console.log(`[Monday] Found ${pendingOrders.rows.length} orders without monday_item_id`);

    const results = {
      processed: 0,
      created: 0,
      skipped_exists: 0,
      errors: []
    };

    for (const order of pendingOrders.rows) {
      try {
        results.processed++;

        // Check if Business Owner already exists in Monday (might have been created via Zapier)
        const exists = await businessOwnerExistsInMonday(order.email);
        if (exists) {
          console.log(`[Monday] Business Owner already exists for ${order.email}, skipping`);
          results.skipped_exists++;
          continue;
        }

        // Build orderData from the row
        const orderData = {
          email: order.email,
          first_name: order.first_name,
          last_name: order.last_name,
          phone: order.phone,
          product_name: order.product_name,
          order_total: order.order_total,
          created_at: order.created_at
        };

        // Parse raw_data for payment method detection
        let rawData = null;
        try {
          rawData = typeof order.raw_data === 'string' ? JSON.parse(order.raw_data) : order.raw_data;
        } catch (e) {
          // Ignore parse errors
        }

        // Create the Business Owner in Monday
        const item = await createBusinessOwnerItem(orderData, rawData);

        if (item) {
          // Store monday_item_id in database
          await pool.query(`
            UPDATE samcart_orders
            SET monday_item_id = $1, monday_created_at = NOW()
            WHERE id = $2
          `, [item.id, order.id]);

          // Log to activity_log
          await pool.query(`
            INSERT INTO activity_log (action, entity_type, entity_id, details)
            VALUES ($1, $2, $3, $4)
          `, [
            'monday_business_owner_created_retry',
            'samcart_order',
            order.id,
            JSON.stringify({
              email: order.email,
              name: item.name,
              monday_item_id: item.id,
              product: order.product_name
            })
          ]);

          // Check if there's a completed onboarding with a business name to update
          const onboardingResult = await pool.query(`
            SELECT os.data
            FROM onboarding_submissions os
            JOIN business_owners bo ON os.business_owner_id = bo.id
            WHERE LOWER(bo.email) = LOWER($1)
              AND os.is_complete = true
            ORDER BY os.completed_at DESC
            LIMIT 1
          `, [order.email]);

          if (onboardingResult.rows.length > 0) {
            const data = onboardingResult.rows[0].data || {};
            const businessName = data.answers?.businessName;
            if (businessName) {
              console.log(`[Monday] Also updating Company field to "${businessName}"`);
              await updateBusinessOwnerCompany(item.id, businessName);
            }
          }

          results.created++;
          console.log(`[Monday] Created Business Owner for ${order.email} (retry)`);
        }
      } catch (error) {
        console.error(`[Monday] Error processing order ${order.id}:`, error.message);
        results.errors.push({
          order_id: order.id,
          email: order.email,
          error: error.message
        });
      }
    }

    console.log('[Monday] Business Owner processing complete:', results);
    res.json({
      success: true,
      ...results
    });
  } catch (error) {
    console.error('[Monday] Error processing Business Owners:', error);
    res.status(500).json({ error: 'Failed to process Monday Business Owners' });
  }
});

module.exports = router;
