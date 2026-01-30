const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

// Helper to send Slack welcome message as a thread
async function sendSlackWelcome(answers, teamMembers, cLevelPartners, pool) {
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  const SLACK_WELCOME_USER_ID = process.env.SLACK_WELCOME_USER_ID;
  const BASE_URL = process.env.BASE_URL || 'https://onboarding.copyaccelerator.com';

  // Skip if Slack is not configured
  if (!SLACK_BOT_TOKEN || !SLACK_WELCOME_USER_ID) {
    console.log('Slack not configured, skipping welcome message');
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

  // Build member data from chat answers AND Typeform data
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
    // Typeform-specific fields
    typeformBusinessDescription: typeformData?.business_description || '',
    typeformAnnualRevenue: typeformData?.annual_revenue || '',
    typeformMainChallenge: typeformData?.main_challenge || '',
    typeformWhyCaPro: typeformData?.why_ca_pro || ''
  };

  console.log('Sending Slack welcome for:', memberData.businessName);

  // Open DM channel with the welcome user
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
  const fullName = [memberData.firstName, memberData.lastName].filter(Boolean).join(' ');
  const memberName = fullName || memberData.businessName || 'New Member';

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

  // Create parent message (thread starter) with member overview
  const parentResult = await sendMessage([
    {
      type: 'header',
      text: { type: 'plain_text', text: `🎉 New Member: ${memberName}`, emoji: true }
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Business:* ${memberData.businessName || 'N/A'}\n*Email:* ${memberData.email || 'N/A'}` }
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: '_View thread for full details and welcome message →_' }
      ]
    }
  ], `New member: ${memberName}`);

  if (!parentResult.ok) {
    throw new Error(`Failed to send parent message: ${parentResult.error}`);
  }

  const threadTs = parentResult.ts;
  await new Promise(resolve => setTimeout(resolve, 300));

  // Thread message 1: Typeform Application Data (if available)
  if (typeformData) {
    const typeformFields = [
      `*Name:* ${fullName || 'N/A'}`,
      `*Email:* ${memberData.email || 'N/A'}`,
      `*Phone:* ${memberData.phone || 'N/A'}`,
      `*Business Description:* ${memberData.typeformBusinessDescription || 'N/A'}`,
      `*Annual Revenue:* ${memberData.typeformAnnualRevenue || 'N/A'}`,
      `*Main Challenge:* ${memberData.typeformMainChallenge || 'N/A'}`,
      `*Why CA Pro:* ${memberData.typeformWhyCaPro || 'N/A'}`
    ];

    await sendMessage([
      {
        type: 'header',
        text: { type: 'plain_text', text: `📝 Typeform Application`, emoji: true }
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: typeformFields.join('\n\n') }
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

Here is the member's information:
- Name: ${fullName || 'Not provided'}
- Business Name: ${memberData.businessName || 'Not provided'}
- Business Description (from application): ${memberData.typeformBusinessDescription || 'Not provided'}
- About them/Bio: ${memberData.businessOverview || memberData.bio || 'Not provided'}
- What they want to achieve (massive win): ${memberData.massiveWin || 'Not provided'}
- Why they joined CA Pro: ${memberData.typeformWhyCaPro || 'Not provided'}
- Main Challenge: ${memberData.typeformMainChallenge || 'Not provided'}
- Team Count: ${memberData.teamCount || 'Not provided'}
- Traffic Sources: ${memberData.trafficSources || 'Not provided'}
- Revenue Level: ${generalizedRevenue || 'Not provided'}

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

    // Check if session exists
    const existing = await pool.query(
      'SELECT id, business_owner_id FROM onboarding_submissions WHERE session_id = $1',
      [session]
    );

    let submissionId;
    let businessOwnerId = null;

    if (existing.rows.length > 0) {
      // Update existing submission
      submissionId = existing.rows[0].id;
      businessOwnerId = existing.rows[0].business_owner_id;

      await pool.query(`
        UPDATE onboarding_submissions SET
          data = $1,
          progress_percentage = $2,
          last_question = $3,
          is_complete = $4,
          completed_at = $5
        WHERE session_id = $6
      `, [
        JSON.stringify({ answers, teamMembers, cLevelPartners }),
        progress,
        answers.lastQuestionId || null,
        isComplete || false,
        isComplete ? new Date() : null,
        session
      ]);
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
        answers.lastQuestionId || null,
        isComplete || false,
        isComplete ? new Date() : null
      ]);
      submissionId = result.rows[0].id;
    }

    // If complete, create/update business owner and team members
    if (isComplete) {
      businessOwnerId = await createOrUpdateBusinessOwner(pool, answers, teamMembers, cLevelPartners, session, submissionId);

      // Send Slack welcome message (async, don't wait)
      sendSlackWelcome(answers, teamMembers, cLevelPartners, pool).catch(err => {
        console.error('Failed to send Slack welcome:', err);
      });
    }

    res.json({
      success: true,
      sessionId: session,
      submissionId,
      businessOwnerId,
      progress,
      isComplete: isComplete || false
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

    // Try to find existing member by email if provided
    if (answers.email) {
      const existingMember = await client.query(
        'SELECT id FROM business_owners WHERE email = $1',
        [answers.email]
      );

      if (existingMember.rows.length > 0) {
        businessOwnerId = existingMember.rows[0].id;

        // Update existing member
        await client.query(`
          UPDATE business_owners SET
            business_name = COALESCE($1, business_name),
            business_overview = COALESCE($2, business_overview),
            team_count = COALESCE($3, team_count),
            traffic_sources = COALESCE($4, traffic_sources),
            landing_pages = COALESCE($5, landing_pages),
            massive_win = COALESCE($6, massive_win),
            ai_skill_level = COALESCE($7, ai_skill_level),
            bio = COALESCE($8, bio),
            headshot_url = COALESCE($9, headshot_url),
            whatsapp_number = COALESCE($10, whatsapp_number),
            whatsapp_joined = COALESCE($11, whatsapp_joined),
            anything_else = COALESCE($12, anything_else),
            onboarding_status = 'completed',
            onboarding_progress = 100
          WHERE id = $13
        `, [
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
        answers.firstName || null,
        answers.lastName || null,
        answers.email || null,
        answers.phone || null,
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

    // Log activity
    await client.query(`
      INSERT INTO activity_log (action, entity_type, entity_id, details)
      VALUES ($1, $2, $3, $4)
    `, ['onboarding_completed', 'business_owner', businessOwnerId, JSON.stringify({ business: answers.businessName })]);

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
