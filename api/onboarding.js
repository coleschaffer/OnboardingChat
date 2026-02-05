const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { syncTeamMembers, syncPartners } = require('./activecampaign');
const { syncTeamMembersToCircle, syncPartnersToCircle } = require('./circle');
const { updateBusinessOwnerCompany } = require('./monday');
const { postOnboardingUpdateToWelcomeThread, postMessage } = require('./slack-threads');
const { addContactsToGroups, buildWhatsAppAddSummary } = require('../lib/whatsapp-actions');
const { resolveGroupKeysForRole } = require('../lib/whatsapp-groups');

/**
 * Update Monday.com Company field when onboarding completes
 * Looks up the monday_item_id from samcart_orders by email
 */
async function updateMondayCompanyField(pool, answers) {
  const businessName = answers.businessName;
  const email = answers.email;

  if (!businessName || !email) {
    console.log('[Monday] No business name or email, skipping Company field update');
    return;
  }

  try {
    // Look up the SamCart order with monday_item_id by email
    const orderResult = await pool.query(`
      SELECT id, monday_item_id, email
      FROM samcart_orders
      WHERE LOWER(email) = LOWER($1)
        AND monday_item_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1
    `, [email]);

    if (orderResult.rows.length === 0) {
      console.log(`[Monday] No SamCart order with monday_item_id found for ${email}`);
      return;
    }

    const order = orderResult.rows[0];
    console.log(`[Monday] Updating Company field for monday_item_id ${order.monday_item_id}`);

    // Update the Company field in Monday
    const success = await updateBusinessOwnerCompany(order.monday_item_id, businessName);

    if (success) {
      // Log to activity_log
      await pool.query(`
        INSERT INTO activity_log (action, entity_type, entity_id, details)
        VALUES ($1, $2, $3, $4)
      `, [
        'monday_company_updated',
        'samcart_order',
        order.id,
        JSON.stringify({
          email: email,
          business_name: businessName,
          monday_item_id: order.monday_item_id
        })
      ]);

      console.log(`[Monday] Company field updated to "${businessName}" for ${email}`);
    }
  } catch (error) {
    console.error(`[Monday] Error updating Company field for ${email}:`, error.message);

    // Log the error
    await pool.query(`
      INSERT INTO activity_log (action, entity_type, entity_id, details)
      VALUES ($1, $2, $3, $4)
    `, [
      'monday_company_update_failed',
      'samcart_order',
      null,
      JSON.stringify({
        email: email,
        business_name: businessName,
        error: error.message
      })
    ]);
  }
}

async function postWhatsAppAddSummaryToThread(pool, email, label, groupKeys, contacts) {
  if (!email) return false;

  const orderResult = await pool.query(
    `
      SELECT slack_channel_id, slack_thread_ts
      FROM samcart_orders
      WHERE LOWER(email) = LOWER($1)
        AND slack_channel_id IS NOT NULL
        AND slack_thread_ts IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [email]
  );

  const order = orderResult.rows[0];
  if (!order) return false;

  const addResult = await addContactsToGroups({ contacts, groupKeys });
  const summaryText = buildWhatsAppAddSummary({
    label,
    groupResults: addResult.groupResults,
    participantsCount: addResult.participants.length,
    skipped: addResult.skipped,
    missingGroupKeys: addResult.missingGroupKeys
  });

  await postMessage(order.slack_channel_id, summaryText, [
    { type: 'section', text: { type: 'mrkdwn', text: summaryText } }
  ], order.slack_thread_ts);

  return true;
}

function formatPhoneForLabel(phone) {
  if (!phone) return null;
  const digits = phone.toString().replace(/\D/g, '');
  if (!digits) return null;
  const normalized = digits.length >= 10 ? digits.slice(-10) : digits;
  if (normalized.length === 10) {
    return `${normalized.slice(0, 3)}-${normalized.slice(3, 6)}-${normalized.slice(6)}`;
  }
  return normalized;
}

function buildContactsLabel(contacts, fallbackLabel) {
  const entries = (contacts || [])
    .map(contact => {
      const phoneLabel = formatPhoneForLabel(contact.phone);
      if (!phoneLabel) return null;
      const name = contact.name || contact.email || 'Unknown';
      return `${name} (${phoneLabel})`;
    })
    .filter(Boolean);

  if (entries.length === 0) return fallbackLabel;
  return `${entries.join(', ')} added`;
}

// Helper to send Slack welcome message as a thread
async function sendSlackWelcome(answers, teamMembers, cLevelPartners, pool) {
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  const SLACK_WELCOME_CHANNEL_ID = process.env.CA_PRO_NOTIFICATIONS_SLACK_CHANNEL;
  const SLACK_WELCOME_USER_ID = process.env.SLACK_WELCOME_USER_ID; // For tagging Stefan
  const BASE_URL = process.env.BASE_URL || 'https://onboarding.copyaccelerator.com';

  // Skip if Slack is not configured
  if (!SLACK_BOT_TOKEN || !SLACK_WELCOME_CHANNEL_ID) {
    console.log('Slack not configured (missing SLACK_BOT_TOKEN or CA_PRO_NOTIFICATIONS_SLACK_CHANNEL), skipping welcome message');
    return;
  }

  // Try to find Typeform data using multiple matching strategies: email → phone → name
  let typeformData = null;
  let samcartData = null;

  if (pool) {
    // Strategy 1: Try email
    // Strategy 2: Try phone
    // Strategy 3: Try first_name + last_name
    try {
      let conditions = [];
      let params = [];

      if (answers.email) {
        conditions.push(`LOWER(email) = LOWER($${params.length + 1})`);
        params.push(answers.email);
      }
      if (answers.phone) {
        const cleanPhone = answers.phone.replace(/\D/g, '');
        if (cleanPhone.length >= 10) {
          conditions.push(`REPLACE(REPLACE(REPLACE(phone, '-', ''), ' ', ''), '+', '') LIKE '%' || $${params.length + 1}`);
          params.push(cleanPhone.slice(-10));
        }
      }
      if (answers.firstName && answers.lastName) {
        conditions.push(`(LOWER(first_name) = LOWER($${params.length + 1}) AND LOWER(last_name) = LOWER($${params.length + 2}))`);
        params.push(answers.firstName, answers.lastName);
      }

      if (conditions.length > 0) {
        const query = `SELECT * FROM typeform_applications WHERE ${conditions.join(' OR ')} ORDER BY created_at DESC LIMIT 1`;
        const result = await pool.query(query, params);

        if (result.rows.length > 0) {
          typeformData = result.rows[0];
          console.log('Found matching Typeform data for:', typeformData.email || typeformData.first_name);
        } else {
          console.log('No Typeform match found with conditions:', conditions.length, 'params:', params);
        }
      } else {
        console.log('No email, phone, or name available for Typeform lookup');
      }
    } catch (err) {
      console.error('Error looking up Typeform data:', err);
    }

    // Also look up SamCart order data with same strategy
    try {
      let conditions = [];
      let params = [];

      if (answers.email) {
        conditions.push(`LOWER(email) = LOWER($${params.length + 1})`);
        params.push(answers.email);
      }
      if (answers.phone) {
        const cleanPhone = answers.phone.replace(/\D/g, '');
        if (cleanPhone.length >= 10) {
          conditions.push(`REPLACE(REPLACE(REPLACE(phone, '-', ''), ' ', ''), '+', '') LIKE '%' || $${params.length + 1}`);
          params.push(cleanPhone.slice(-10));
        }
      }
      if (answers.firstName && answers.lastName) {
        conditions.push(`(LOWER(first_name) = LOWER($${params.length + 1}) AND LOWER(last_name) = LOWER($${params.length + 2}))`);
        params.push(answers.firstName, answers.lastName);
      }

      if (conditions.length > 0) {
        const query = `SELECT * FROM samcart_orders WHERE ${conditions.join(' OR ')} ORDER BY created_at DESC LIMIT 1`;
        const result = await pool.query(query, params);

        if (result.rows.length > 0) {
          samcartData = result.rows[0];
          console.log('Found matching SamCart data for:', samcartData.email || samcartData.first_name);

          // Check if a delayed welcome was already sent
          if (samcartData.welcome_sent === true) {
            console.log('Delayed welcome already sent for this member, skipping Slack message');
            return; // Exit early - don't send duplicate welcome
          }
        }
      }
    } catch (err) {
      console.error('Error looking up SamCart data:', err);
    }

    // Log matches to activity feed
    if (typeformData) {
      const typeformName = [typeformData.first_name, typeformData.last_name].filter(Boolean).join(' ') || typeformData.email;
      const onboardingName = answers.businessName || 'Onboarding';
      await pool.query(`
        INSERT INTO activity_log (action, entity_type, entity_id, details)
        VALUES ($1, $2, $3, $4)
      `, ['record_matched', 'match', typeformData.id, JSON.stringify({
        typeform_name: typeformName,
        onboarding_name: onboardingName,
        match_type: 'typeform_to_onboarding'
      })]);
    }
  }

  // Build member data from chat answers AND Typeform data (all 15 questions)
  const memberData = {
    // Prefer Typeform data for name (since chat doesn't collect it)
    firstName: typeformData?.first_name || answers.firstName || '',
    lastName: typeformData?.last_name || answers.lastName || '',
    email: typeformData?.email || answers.email || '',
    phone: typeformData?.phone || answers.phone || '',
    // Chat data
    businessName: answers.businessName || '',
    businessOverview: answers.bio || '',
    massiveWin: answers.massiveWin || '',
    teamCount: answers.teamCount || '',
    trafficSources: answers.trafficSources || '',
    landingPages: answers.landingPages || '',
    aiSkillLevel: answers.aiSkillLevel || '',
    bio: answers.bio || '',
    // Typeform-specific fields (all 15 questions)
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

  console.log('Sending Slack welcome for:', memberData.businessName);

  const fullName = [memberData.firstName, memberData.lastName].filter(Boolean).join(' ');
  const memberName = fullName || memberData.businessName || 'New Member';

  // Check if we have a SamCart notification thread to reply to
  let channelId = SLACK_WELCOME_CHANNEL_ID;
  let parentThreadTs = null;

  if (samcartData && samcartData.slack_thread_ts && samcartData.slack_channel_id) {
    // Thread on the SamCart notification
    channelId = samcartData.slack_channel_id;
    parentThreadTs = samcartData.slack_thread_ts;
    console.log(`[Welcome] Threading on SamCart notification: ${parentThreadTs}`);
  } else {
    console.log('[Welcome] No SamCart thread found, creating new top-level message');
  }

  // Helper to send a message (optionally in a thread, with optional member data for editing context)
  async function sendMessage(blocks, text, threadTs = null, memberDataForEdit = null) {
    const payload = { channel: channelId, blocks, text };
    if (threadTs) payload.thread_ts = threadTs;

    // Include member data in metadata for edit context (Slack metadata limited to 3000 chars)
    if (memberDataForEdit) {
      payload.metadata = {
        event_type: 'welcome_message',
        event_payload: {
          firstName: memberDataForEdit.firstName || '',
          lastName: memberDataForEdit.lastName || '',
          businessName: memberDataForEdit.businessName || '',
          bio: memberDataForEdit.bio || '',
          massiveWin: memberDataForEdit.massiveWin || '',
          teamCount: memberDataForEdit.teamCount || '',
          trafficSources: memberDataForEdit.trafficSources || '',
          typeformBusinessDescription: memberDataForEdit.typeformBusinessDescription || '',
          typeformAnnualRevenue: memberDataForEdit.typeformAnnualRevenue || '',
          typeformMainChallenge: memberDataForEdit.typeformMainChallenge || '',
          typeformWhyCaPro: memberDataForEdit.typeformWhyCaPro || ''
        }
      };
    }

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

  // Create welcome message (either as thread reply to SamCart or new top-level message)
  const stefanTag = SLACK_WELCOME_USER_ID ? `<@${SLACK_WELCOME_USER_ID}>` : '';
  const parentResult = await sendMessage([
    {
      type: 'header',
      text: { type: 'plain_text', text: `🎉 New Member: ${memberName}`, emoji: true }
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Business:* ${memberData.businessName || 'N/A'}\n*Email:* ${memberData.email || 'N/A'}${stefanTag ? `\n${stefanTag}` : ''}` }
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: '_View thread for full details and welcome message →_' }
      ]
    }
  ], `New member: ${memberName}`, parentThreadTs);

  if (!parentResult.ok) {
    throw new Error(`Failed to send welcome message: ${parentResult.error}`);
  }

  // Use SamCart thread if available, otherwise use the new message as thread parent
  const threadTs = parentThreadTs || parentResult.ts;
  await new Promise(resolve => setTimeout(resolve, 300));

  // Thread message 1: Typeform Application Data (if available)
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

  // Thread message 2: SamCart Purchase Data (if available)
  if (samcartData) {
    const samcartFields = [
      `*Product:* ${samcartData.product_name || 'N/A'}`,
      `*Order Total:* ${samcartData.order_total ? `$${samcartData.order_total}` : 'N/A'}`,
      `*Order ID:* ${samcartData.samcart_order_id || 'N/A'}`,
      `*Status:* ${samcartData.status || 'N/A'}`,
      `*Email:* ${samcartData.email || 'N/A'}`,
      `*Name:* ${[samcartData.first_name, samcartData.last_name].filter(Boolean).join(' ') || 'N/A'}`
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
  }

  // Thread message 3: Onboarding Chat Data
  const onboardingFields = [
    `*Business Name:* ${memberData.businessName || 'N/A'}`,
    `*Team Size:* ${memberData.teamCount || 'N/A'}`,
    `*Traffic Sources:* ${memberData.trafficSources || 'N/A'}`,
    `*Landing Pages:* ${memberData.landingPages || 'N/A'}`,
    `*Massive Win Goal:* ${memberData.massiveWin || 'N/A'}`,
    `*AI Skill Level:* ${memberData.aiSkillLevel || 'N/A'}/10`,
    `*Bio:* ${memberData.bio || 'N/A'}`
  ];

  if (teamMembers && teamMembers.length > 0) {
    const teamList = teamMembers.map(tm => `  • ${tm.name} (${tm.email})`).join('\n');
    onboardingFields.push(`*Team Members Added:*\n${teamList}`);
  }

  if (cLevelPartners && cLevelPartners.length > 0) {
    const partnerList = cLevelPartners.map(p => `  • ${p.name} (${p.email})`).join('\n');
    onboardingFields.push(`*C-Level Partners:*\n${partnerList}`);
  }

  await sendMessage([
    {
      type: 'header',
      text: { type: 'plain_text', text: `📋 Onboarding Chat Data`, emoji: true }
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: onboardingFields.join('\n\n') }
    }
  ], `Onboarding data for ${memberName}`, threadTs);

  await new Promise(resolve => setTimeout(resolve, 300));

  // Thread message 4: Generate and send welcome message with Copy/Edit buttons
  const welcomeMessage = await generateWelcomeMessage(memberData);

  // Create copy URL with encoded message
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
  ], `Welcome message for ${memberName}`, threadTs, memberData);

  // Mark welcome_sent = true on matching SamCart order (if exists)
  if (samcartData?.id) {
    try {
      await pool.query(`
        UPDATE samcart_orders
        SET welcome_sent = true, welcome_sent_at = NOW()
        WHERE id = $1
      `, [samcartData.id]);
      console.log('Marked SamCart order as welcome_sent');
    } catch (err) {
      console.error('Error updating welcome_sent:', err);
    }
  }

  console.log('Slack welcome thread sent successfully');
}

// Convert revenue to generalized format (e.g., "$500,000" -> "6 figures")
function generalizeRevenue(revenue) {
  if (!revenue) return null;

  // If already generalized, return as-is
  if (/\d+\s*figures?/i.test(revenue)) return revenue;

  // Try to extract a number
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

  // Return original if can't parse, but never include specific amounts
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

  // Generalize revenue - never show exact amounts
  const generalizedRevenue = generalizeRevenue(memberData.typeformAnnualRevenue);

  const prompt = `You are writing a welcome message for a new CA Pro member to be posted in a WhatsApp group.

Here is ALL the member's information from their application:

CONTACT INFO:
- Name: ${fullName || 'Not provided'}
- Contact Preference: ${memberData.typeformContactPreference || 'Not provided'}

BUSINESS INFO:
- Business Name: ${memberData.businessName || 'Not provided'}
- Business Description: ${memberData.typeformBusinessDescription || 'Not provided'}
- About them/Bio: ${memberData.businessOverview || memberData.bio || 'Not provided'}
- Revenue Level: ${generalizedRevenue || 'Not provided'}
- Revenue Trend: ${memberData.typeformRevenueTrend || 'Not provided'}
- Team Size: ${memberData.teamCount || 'Not provided'}
- Has Team: ${memberData.typeformHasTeam || 'Not provided'}
- Traffic Sources: ${memberData.trafficSources || 'Not provided'}

GOALS & CHALLENGES:
- Main Challenge (#1 thing holding them back): ${memberData.typeformMainChallenge || 'Not provided'}
- What they want to achieve (massive win): ${memberData.massiveWin || 'Not provided'}
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

Example 3:
"Hey guys, please join me in extending a warm welcome to our newest CA Pro Member, Jonatan Staszewski!

Jonatan is the co-founder of a probiotic supplement brand. With 4+ years in ecomm and having already scaled and sold a $20M skincare brand, Jonatan brings serious experience to the community. Now he's building his next 8-figure brand in the supplement niche.

We're thrilled to have Jonatan in the CA Pro community and we're excited to help him scale even further.

Welcome Jonatan!"

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
    return data.content[0]?.text || `Welcome to CA Pro, ${memberData.businessName}!`;
  } catch (error) {
    console.error('Error generating welcome message:', error);
    return `Welcome to CA Pro! We're excited to have ${memberData.businessName || 'you'} in the community.`;
  }
}

// Save progress (partial or complete)
router.post('/save-progress', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { sessionId, answers, teamMembers, cLevelPartners, currentQuestion, totalQuestions, isComplete } = req.body;

    // Generate session ID if not provided
    const session = sessionId || uuidv4();
    const progress = Math.round((currentQuestion / totalQuestions) * 100);

    // If progress is 100%, treat as complete (prevents race condition)
    const isActuallyComplete = isComplete || progress >= 100;

    // Get the last answered question ID to determine if we need to sync
    const lastQuestionId = answers.lastQuestionId || null;

    // Check if session exists and get previous data
    const existing = await pool.query(
      'SELECT id, business_owner_id, data, is_complete FROM onboarding_submissions WHERE session_id = $1',
      [session]
    );

    let submissionId;
    let businessOwnerId = null;
    let previousData = null;
    let wasAlreadyComplete = false;

    if (existing.rows.length > 0) {
      wasAlreadyComplete = existing.rows[0].is_complete === true;
      // Update existing submission
      submissionId = existing.rows[0].id;
      businessOwnerId = existing.rows[0].business_owner_id;
      previousData = existing.rows[0].data;

      // Only update is_complete/completed_at if becoming complete (don't overwrite true with false)
      if (isActuallyComplete) {
        await pool.query(`
          UPDATE onboarding_submissions SET
            data = $1,
            progress_percentage = $2,
            last_question = $3,
            is_complete = true,
            completed_at = COALESCE(completed_at, NOW())
          WHERE session_id = $4
        `, [
          JSON.stringify({ answers, teamMembers, cLevelPartners }),
          progress,
          lastQuestionId,
          session
        ]);
      } else {
        await pool.query(`
          UPDATE onboarding_submissions SET
            data = $1,
            progress_percentage = $2,
            last_question = $3
          WHERE session_id = $4
        `, [
          JSON.stringify({ answers, teamMembers, cLevelPartners }),
          progress,
          lastQuestionId,
          session
        ]);
      }
    } else {
      // Create new submission
      const result = await pool.query(`
        INSERT INTO onboarding_submissions (
          session_id, data, progress_percentage, last_question, is_complete, completed_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [
        session,
        JSON.stringify({ answers, teamMembers, cLevelPartners }),
        progress,
        lastQuestionId,
        isActuallyComplete,
        isActuallyComplete ? new Date() : null
      ]);
      submissionId = result.rows[0].id;
    }

    // Sync Team Members to Circle/ActiveCampaign when they're submitted
    // Trigger when we have team members and they're newly added (not synced before)
    if (teamMembers && teamMembers.length > 0) {
      const previousTeamMembers = previousData?.teamMembers || [];
      const previousEmails = new Set(previousTeamMembers.map(m => m.email?.toLowerCase()).filter(Boolean));
      const newTeamMembers = teamMembers.filter(m => m.email && !previousEmails.has(m.email.toLowerCase()));

      if (newTeamMembers.length > 0) {
        console.log(`[Onboarding] Syncing ${newTeamMembers.length} new team member(s) to Circle/ActiveCampaign`);

        // Sync to Circle (async, don't wait)
        syncTeamMembersToCircle(newTeamMembers, pool).catch(err => {
          console.error('Failed to sync team members to Circle:', err);
        });

        // Sync to ActiveCampaign (async, don't wait)
        syncTeamMembers(newTeamMembers, pool).catch(err => {
          console.error('Failed to sync team members to ActiveCampaign:', err);
        });

        if (answers?.email) {
          const contacts = newTeamMembers.map(member => ({
            name: member.name || [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email,
            email: member.email,
            phone: member.phone
          }));
          const groupKeys = resolveGroupKeysForRole('team_member');
          const label = buildContactsLabel(contacts, 'Team members added');
          postWhatsAppAddSummaryToThread(pool, answers.email, label, groupKeys, contacts)
            .catch(err => console.error('[WhatsApp Add] Failed to add team members:', err.message));
        }
      }
    }

    // Sync Partners to Circle/ActiveCampaign when they're submitted
    if (cLevelPartners && cLevelPartners.length > 0) {
      const previousPartners = previousData?.cLevelPartners || [];
      const previousEmails = new Set(previousPartners.map(p => p.email?.toLowerCase()).filter(Boolean));
      const newPartners = cLevelPartners.filter(p => p.email && !previousEmails.has(p.email.toLowerCase()));

      if (newPartners.length > 0) {
        console.log(`[Onboarding] Syncing ${newPartners.length} new partner(s) to Circle/ActiveCampaign`);

        // Sync to Circle (async, don't wait)
        syncPartnersToCircle(newPartners, pool).catch(err => {
          console.error('Failed to sync partners to Circle:', err);
        });

        // Sync to ActiveCampaign (async, don't wait)
        syncPartners(newPartners, pool).catch(err => {
          console.error('Failed to sync partners to ActiveCampaign:', err);
        });

        if (answers?.email) {
          const contacts = newPartners.map(partner => ({
            name: partner.name || [partner.firstName, partner.lastName].filter(Boolean).join(' ') || partner.email,
            email: partner.email,
            phone: partner.phone
          }));
          const groupKeys = resolveGroupKeysForRole('partner');
          const label = buildContactsLabel(contacts, 'Partners added');
          postWhatsAppAddSummaryToThread(pool, answers.email, label, groupKeys, contacts)
            .catch(err => console.error('[WhatsApp Add] Failed to add partners:', err.message));
        }
      }
    }

    // If complete AND not already processed, create/update business owner and team members
    // The wasAlreadyComplete check prevents duplicate processing when endpoint is called multiple times
    if (isActuallyComplete && !wasAlreadyComplete) {
      businessOwnerId = await createOrUpdateBusinessOwner(pool, answers, teamMembers, cLevelPartners, session, submissionId);

      // Send Slack welcome message (async, don't wait)
      sendSlackWelcome(answers, teamMembers, cLevelPartners, pool).catch(err => {
        console.error('Failed to send Slack welcome:', err);
      });

      // Schedule Monday.com sync immediately
      // Business Owner is now created on SamCart purchase, so no need to wait
      await pool.query(`
        UPDATE onboarding_submissions
        SET monday_sync_scheduled_at = NOW()
        WHERE session_id = $1
      `, [session]);
      console.log(`[Onboarding] Scheduled Monday sync immediately (session: ${session})`);

      // Update Monday.com Company field if we have a SamCart order with monday_item_id
      updateMondayCompanyField(pool, answers).catch(err => {
        console.error('[Onboarding] Error updating Monday Company field:', err);
      });

      // If a delayed welcome was already sent, post onboarding update to that thread
      postOnboardingUpdateToWelcomeThread(pool, answers.email, { answers, teamMembers, cLevelPartners }).catch(err => {
        console.error('[Onboarding] Error posting onboarding update to welcome thread:', err);
      });

      // Update typeform_applications.onboarding_completed_at if email matches
      if (answers.email) {
        await pool.query(`
          UPDATE typeform_applications
          SET onboarding_completed_at = CURRENT_TIMESTAMP
          WHERE LOWER(email) = LOWER($1) AND onboarding_completed_at IS NULL
        `, [answers.email]);
        console.log(`[Onboarding] Set onboarding_completed_at for ${answers.email}`);

        // Log activity
        await pool.query(`
          INSERT INTO activity_log (action, entity_type, entity_id, details)
          SELECT 'onboarding_completed', 'typeform_application', id, $2::jsonb
          FROM typeform_applications
          WHERE LOWER(email) = LOWER($1)
          LIMIT 1
        `, [answers.email, JSON.stringify({ email: answers.email, business_name: answers.businessName })]);
      }

      // Note: Circle/ActiveCampaign sync now happens when questions are answered,
      // not at completion. The APIs handle duplicates gracefully.
    } else if (answers.email && !previousData?.answers?.email) {
      // First time email is submitted - set onboarding_started_at
      await pool.query(`
        UPDATE typeform_applications
        SET onboarding_started_at = CURRENT_TIMESTAMP
        WHERE LOWER(email) = LOWER($1) AND onboarding_started_at IS NULL
      `, [answers.email]);
      console.log(`[Onboarding] Set onboarding_started_at for ${answers.email}`);

      // Log activity
      await pool.query(`
        INSERT INTO activity_log (action, entity_type, entity_id, details)
        SELECT 'onboarding_started', 'typeform_application', id, $2::jsonb
        FROM typeform_applications
        WHERE LOWER(email) = LOWER($1)
        LIMIT 1
      `, [answers.email, JSON.stringify({ email: answers.email })]);
    }

    res.json({
      success: true,
      sessionId: session,
      submissionId,
      businessOwnerId,
      progress,
      isComplete: isActuallyComplete
    });
  } catch (error) {
    console.error('Error saving progress:', error);
    res.status(500).json({ error: 'Failed to save progress' });
  }
});

// Helper function to create/update business owner
async function createOrUpdateBusinessOwner(pool, answers, teamMembers, cLevelPartners, sessionId, submissionId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let businessOwnerId;

    // Look up Typeform data to get name (since chat doesn't collect it)
    let typeformData = null;
    if (answers.email) {
      const typeformResult = await client.query(
        'SELECT first_name, last_name, phone FROM typeform_applications WHERE LOWER(email) = LOWER($1) ORDER BY created_at DESC LIMIT 1',
        [answers.email]
      );
      if (typeformResult.rows.length > 0) {
        typeformData = typeformResult.rows[0];
        console.log(`[Onboarding] Found Typeform data for ${answers.email}: ${typeformData.first_name} ${typeformData.last_name}`);
      }
    }

    // Use Typeform name if chat didn't collect it
    const firstName = answers.firstName || typeformData?.first_name || null;
    const lastName = answers.lastName || typeformData?.last_name || null;
    const phone = answers.phone || typeformData?.phone || null;

    // Try to find existing member by email if provided
    if (answers.email) {
      const existingMember = await client.query(
        'SELECT id FROM business_owners WHERE email = $1',
        [answers.email]
      );

      if (existingMember.rows.length > 0) {
        businessOwnerId = existingMember.rows[0].id;

        // Update existing member (also fill in name/phone from Typeform if missing)
        await client.query(`
          UPDATE business_owners SET
            first_name = COALESCE(first_name, $1),
            last_name = COALESCE(last_name, $2),
            phone = COALESCE(phone, $3),
            business_name = COALESCE($4, business_name),
            business_overview = COALESCE($5, business_overview),
            team_count = COALESCE($6, team_count),
            traffic_sources = COALESCE($7, traffic_sources),
            landing_pages = COALESCE($8, landing_pages),
            massive_win = COALESCE($9, massive_win),
            ai_skill_level = COALESCE($10, ai_skill_level),
            bio = COALESCE($11, bio),
            headshot_url = COALESCE($12, headshot_url),
            whatsapp_number = COALESCE($13, whatsapp_number),
            whatsapp_joined = COALESCE($14, whatsapp_joined),
            anything_else = COALESCE($15, anything_else),
            onboarding_status = 'completed',
            onboarding_progress = 100
          WHERE id = $16
        `, [
          firstName,
          lastName,
          phone,
          answers.businessName,
          answers.businessOverview,
          answers.teamCount,
          answers.trafficSources,
          answers.landingPages,
          answers.massiveWin,
          answers.aiSkillLevel,
          answers.bio,
          answers.headshotLink,
          answers.whatsappNumber,
          answers.whatsappJoined === 'done',
          answers.anythingElse,
          businessOwnerId
        ]);
      }
    }

    // Create new business owner if needed
    if (!businessOwnerId) {
      const memberResult = await client.query(`
        INSERT INTO business_owners (
          first_name, last_name, email, phone, business_name, business_overview,
          team_count, traffic_sources, landing_pages, massive_win, ai_skill_level,
          bio, headshot_url, whatsapp_number, whatsapp_joined, anything_else,
          source, onboarding_status, onboarding_progress
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        RETURNING id
      `, [
        firstName,
        lastName,
        answers.email || null,
        phone,
        answers.businessName,
        answers.businessOverview,
        answers.teamCount,
        answers.trafficSources,
        answers.landingPages,
        answers.massiveWin,
        answers.aiSkillLevel,
        answers.bio,
        answers.headshotLink,
        answers.whatsappNumber,
        answers.whatsappJoined === 'done',
        answers.anythingElse,
        'chat_onboarding',
        'completed',
        100
      ]);
      businessOwnerId = memberResult.rows[0].id;
    }

    // Link submission to business owner
    await client.query(
      'UPDATE onboarding_submissions SET business_owner_id = $1 WHERE session_id = $2',
      [businessOwnerId, sessionId]
    );

    // Add team members
    if (teamMembers && teamMembers.length > 0) {
      for (const member of teamMembers) {
        // Handle both old format (firstName/lastName) and new format (name)
        const firstName = member.firstName || member.name || '';
        const lastName = member.lastName || '';

        await client.query(`
          INSERT INTO team_members (
            business_owner_id, first_name, last_name, email, phone, role, source
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          businessOwnerId,
          firstName,
          lastName,
          member.email,
          member.phone,
          member.role || null,
          'chat_onboarding'
        ]);
      }
    }

    // Add C-level partners
    if (cLevelPartners && cLevelPartners.length > 0) {
      for (const partner of cLevelPartners) {
        // Handle both old format (firstName/lastName) and new format (name)
        const firstName = partner.firstName || partner.name || '';
        const lastName = partner.lastName || '';

        await client.query(`
          INSERT INTO c_level_partners (
            business_owner_id, first_name, last_name, email, phone, source
          ) VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          businessOwnerId,
          firstName,
          lastName,
          partner.email,
          partner.phone,
          'chat_onboarding'
        ]);
      }
    }

    // Note: onboarding_completed activity is logged in the main save-progress handler
    // to avoid duplicate log entries

    await client.query('COMMIT');
    return businessOwnerId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Legacy submit endpoint (for backwards compatibility)
router.post('/submit', async (req, res) => {
  try {
    const { answers, teamMembers, cLevelPartners } = req.body;

    // Forward to save-progress with isComplete=true
    req.body = {
      sessionId: uuidv4(),
      answers,
      teamMembers,
      cLevelPartners,
      currentQuestion: 100,
      totalQuestions: 100,
      isComplete: true
    };

    // Call save-progress logic
    const pool = req.app.locals.pool;
    const session = req.body.sessionId;

    const result = await pool.query(`
      INSERT INTO onboarding_submissions (
        session_id, data, progress_percentage, is_complete, completed_at
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `, [
      session,
      JSON.stringify({ answers, teamMembers, cLevelPartners }),
      100,
      true,
      new Date()
    ]);

    const businessOwnerId = await createOrUpdateBusinessOwner(
      pool, answers, teamMembers, cLevelPartners, session, result.rows[0].id
    );

    res.status(201).json({
      success: true,
      message: 'Onboarding completed successfully',
      business_owner_id: businessOwnerId
    });
  } catch (error) {
    console.error('Error submitting onboarding:', error);
    res.status(500).json({ error: 'Failed to submit onboarding data' });
  }
});

// Get all onboarding submissions with filters
router.get('/submissions', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { limit = 50, offset = 0, complete, search } = req.query;

    let query = `
      SELECT
        os.*,
        bo.first_name,
        bo.last_name,
        bo.email,
        bo.business_name
      FROM onboarding_submissions os
      LEFT JOIN business_owners bo ON os.business_owner_id = bo.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    // Filter by completion status
    if (complete !== undefined) {
      query += ` AND os.is_complete = $${paramIndex++}`;
      params.push(complete === 'true');
    }

    // Search
    if (search) {
      query += ` AND (
        bo.first_name ILIKE $${paramIndex} OR
        bo.last_name ILIKE $${paramIndex} OR
        bo.email ILIKE $${paramIndex} OR
        bo.business_name ILIKE $${paramIndex}
      )`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    query += ` ORDER BY os.updated_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    // Get counts
    const countsResult = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_complete = true) as complete_count,
        COUNT(*) FILTER (WHERE is_complete = false) as incomplete_count,
        COUNT(*) as total_count
      FROM onboarding_submissions
    `);

    res.json({
      submissions: result.rows,
      counts: {
        complete: parseInt(countsResult.rows[0].complete_count),
        incomplete: parseInt(countsResult.rows[0].incomplete_count),
        total: parseInt(countsResult.rows[0].total_count)
      },
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Error fetching submissions:', error);
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
});

// Get single submission by ID
router.get('/submissions/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    const result = await pool.query(`
      SELECT
        os.*,
        bo.first_name,
        bo.last_name,
        bo.email,
        bo.business_name
      FROM onboarding_submissions os
      LEFT JOIN business_owners bo ON os.business_owner_id = bo.id
      WHERE os.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching submission:', error);
    res.status(500).json({ error: 'Failed to fetch submission' });
  }
});

// Get submission by session ID (for resuming)
router.get('/session/:sessionId', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { sessionId } = req.params;

    const result = await pool.query(
      'SELECT * FROM onboarding_submissions WHERE session_id = $1',
      [sessionId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching session:', error);
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

// Mark submission as complete and create member
router.post('/submissions/:id/complete', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    // Get the submission
    const subResult = await pool.query(
      'SELECT * FROM onboarding_submissions WHERE id = $1',
      [id]
    );

    if (subResult.rows.length === 0) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    const submission = subResult.rows[0];
    const data = submission.data || {};

    // Create business owner from submission data
    const businessOwnerId = await createOrUpdateBusinessOwner(
      pool,
      data.answers || {},
      data.teamMembers || [],
      data.cLevelPartners || [],
      submission.session_id,
      id
    );

    // Mark submission as complete
    await pool.query(`
      UPDATE onboarding_submissions SET
        is_complete = true,
        progress_percentage = 100,
        completed_at = CURRENT_TIMESTAMP,
        business_owner_id = $1
      WHERE id = $2
    `, [businessOwnerId, id]);

    res.json({
      success: true,
      message: 'Submission marked as complete',
      businessOwnerId
    });
  } catch (error) {
    console.error('Error marking submission complete:', error);
    res.status(500).json({ error: 'Failed to mark submission as complete' });
  }
});

// Delete submission
router.delete('/submissions/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM onboarding_submissions WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    res.json({ success: true, message: 'Submission deleted' });
  } catch (error) {
    console.error('Error deleting submission:', error);
    res.status(500).json({ error: 'Failed to delete submission' });
  }
});

// Get onboarding status summary
router.get('/status', async (req, res) => {
  try {
    const pool = req.app.locals.pool;

    const result = await pool.query(`
      SELECT
        onboarding_status as status,
        COUNT(*) as count
      FROM business_owners
      GROUP BY onboarding_status
    `);

    const statusMap = result.rows.reduce((acc, row) => {
      acc[row.status] = parseInt(row.count);
      return acc;
    }, { pending: 0, in_progress: 0, completed: 0 });

    // Also get submission completion stats
    const submissionStats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_complete = true) as complete,
        COUNT(*) FILTER (WHERE is_complete = false) as incomplete
      FROM onboarding_submissions
    `);

    res.json({
      member_status: statusMap,
      submissions: {
        complete: parseInt(submissionStats.rows[0].complete),
        incomplete: parseInt(submissionStats.rows[0].incomplete)
      }
    });
  } catch (error) {
    console.error('Error fetching onboarding status:', error);
    res.status(500).json({ error: 'Failed to fetch onboarding status' });
  }
});

module.exports = router;
