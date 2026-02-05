const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const slackBlocks = require('../lib/slack-blocks');
const { openModal, postMessage, deleteMessage, postNoteToPurchaseThread } = require('./slack-threads');
const { gmailService } = require('../lib/gmail');
const { createApplicationNote, syncApplicationNoteToSlack } = require('../lib/notes');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_WELCOME_USER_ID = process.env.SLACK_WELCOME_USER_ID || 'U0ABG2G4Q2G';

function looksLikeUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test((value || '').trim());
}

function looksLikeEmail(value) {
    return ((value || '').trim()).includes('@');
}

function extractEmailFromSlackMessage(message) {
    if (!message) return null;

    const parts = [];
    if (typeof message.text === 'string') parts.push(message.text);

    if (Array.isArray(message.blocks)) {
        for (const block of message.blocks) {
            if (block?.text?.text) parts.push(block.text.text);
            if (Array.isArray(block?.fields)) {
                parts.push(...block.fields.map(f => f?.text).filter(Boolean));
            }
            if (Array.isArray(block?.elements)) {
                parts.push(...block.elements.map(el => el?.text || el?.value).filter(Boolean));
            }
        }
    }

    const normalized = parts
        .join('\n')
        .replace(/mailto:/gi, '')
        .replace(/[<>|]/g, ' ');

    const match = normalized.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match?.[0] || null;
}

function escapeMrkdwn(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function cleanLookupText(rawText) {
    return (rawText || '')
        .replace(/<@[A-Z0-9]+>/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function formatName(firstName, lastName) {
    const full = [firstName, lastName].map(v => (v || '').trim()).filter(Boolean).join(' ').trim();
    return full || 'Unknown';
}

function truncateText(value, maxLen = 220) {
    const text = String(value || '').trim();
    if (!text) return 'N/A';
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen - 1)}…`;
}

function formatDateTime(value) {
    if (!value) return 'N/A';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'N/A';
    return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });
}

function parseMemberLookupQuery(rawText) {
    const cleaned = cleanLookupText(rawText)
        .replace(/^(find|lookup|search|get)\s+/i, '')
        .trim();
    if (!cleaned) return null;

    const emailMatch = cleaned.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (emailMatch?.[0]) {
        return {
            type: 'email',
            email: emailMatch[0].trim()
        };
    }

    const parts = cleaned
        .split(' ')
        .map(part => part.replace(/^[,.;:!?]+|[,.;:!?]+$/g, ''))
        .filter(Boolean);
    if (parts.length === 0) return null;

    if (parts.length >= 2) {
        return {
            type: 'full_name',
            firstName: parts[0].trim(),
            lastName: parts.slice(1).join(' ').trim()
        };
    }

    return {
        type: 'first_name',
        firstName: parts[0].trim()
    };
}

function describeLookupQuery(query) {
    if (!query) return '';
    if (query.type === 'email') return query.email || '';
    return [query.firstName, query.lastName].filter(Boolean).join(' ').trim();
}

async function findTypeformMatches(pool, query) {
    const params = [];
    let whereClause = '';

    if (query.type === 'email') {
        whereClause = 'LOWER(ta.email) = LOWER($1)';
        params.push(query.email);
    } else if (query.type === 'full_name') {
        whereClause = 'LOWER(TRIM(ta.first_name)) = LOWER(TRIM($1)) AND LOWER(TRIM(ta.last_name)) = LOWER(TRIM($2))';
        params.push(query.firstName, query.lastName);
    } else {
        whereClause = 'LOWER(TRIM(ta.first_name)) = LOWER(TRIM($1))';
        params.push(query.firstName);
    }

    const result = await pool.query(`
        WITH latest_per_email AS (
            SELECT DISTINCT ON (COALESCE(LOWER(ta.email), ta.id::text))
                ta.*
            FROM typeform_applications ta
            WHERE ${whereClause}
            ORDER BY COALESCE(LOWER(ta.email), ta.id::text), ta.created_at DESC
        )
        SELECT *
        FROM latest_per_email
        ORDER BY created_at DESC
        LIMIT 25
    `, params);

    return result.rows;
}

async function getLatestOnboardingContextByEmail(pool, email) {
    if (!email) return null;

    const result = await pool.query(`
        SELECT
            bo.id AS business_owner_id,
            bo.first_name AS bo_first_name,
            bo.last_name AS bo_last_name,
            bo.email AS bo_email,
            bo.business_name AS bo_business_name,
            bo.team_count AS bo_team_count,
            bo.annual_revenue AS bo_annual_revenue,
            bo.whatsapp_joined AS bo_whatsapp_joined,
            os.id AS onboarding_submission_id,
            os.data AS onboarding_data,
            os.progress_percentage AS onboarding_progress,
            os.is_complete AS onboarding_is_complete,
            os.created_at AS onboarding_created_at,
            os.updated_at AS onboarding_updated_at,
            os.completed_at AS onboarding_completed_at
        FROM business_owners bo
        LEFT JOIN LATERAL (
            SELECT id, data, progress_percentage, is_complete, created_at, updated_at, completed_at
            FROM onboarding_submissions
            WHERE business_owner_id = bo.id
            ORDER BY created_at DESC
            LIMIT 1
        ) os ON true
        WHERE LOWER(bo.email) = LOWER($1)
        LIMIT 1
    `, [email]);

    return result.rows[0] || null;
}

function buildAmbiguousLookupBlocks(matches, query) {
    const queryLabel = describeLookupQuery(query);
    const displayed = matches.slice(0, 15);
    const options = displayed
        .map((row, index) => {
            const fullName = escapeMrkdwn(formatName(row.first_name, row.last_name));
            const email = row.email ? ` (${escapeMrkdwn(row.email)})` : '';
            return `${index + 1}. *${fullName}*${email}`;
        })
        .join('\n');
    const hiddenCount = Math.max(matches.length - displayed.length, 0);

    return [
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `I found multiple members for *${escapeMrkdwn(queryLabel)}* (${matches.length} matches).`
            }
        },
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: options
            }
        },
        ...(hiddenCount > 0 ? [{
            type: 'context',
            elements: [{
                type: 'mrkdwn',
                text: `…and ${hiddenCount} more`
            }]
        }] : []),
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: 'Reply with the *full name* (first + last) or *email* so I can pull the exact record.'
            }
        }
    ];
}

function buildMemberLookupBlocks(typeformRow, onboardingContext) {
    const typeformName = formatName(typeformRow.first_name, typeformRow.last_name);
    const sourceLabel = onboardingContext?.onboarding_submission_id ? 'Typeform + Onboarding Chat' : 'Typeform only';
    const typeformAnythingElse = typeformRow.anything_else || typeformRow.additional_info || '';

    const typeformLines = [
        `*Name:* ${escapeMrkdwn(typeformName)}`,
        `*Email:* ${escapeMrkdwn(typeformRow.email || 'N/A')}`,
        `*Phone:* ${escapeMrkdwn(typeformRow.phone || 'N/A')}`,
        `*Submitted:* ${escapeMrkdwn(formatDateTime(typeformRow.created_at))}`,
        `*Best Way to Reach:* ${escapeMrkdwn(truncateText(typeformRow.contact_preference || 'N/A', 120))}`,
        `*Business Description:* ${escapeMrkdwn(truncateText(typeformRow.business_description || 'N/A'))}`,
        `*Annual Revenue:* ${escapeMrkdwn(truncateText(typeformRow.annual_revenue || 'N/A', 120))}`,
        `*Revenue Trend:* ${escapeMrkdwn(truncateText(typeformRow.revenue_trend || 'N/A', 120))}`,
        `*#1 Challenge:* ${escapeMrkdwn(truncateText(typeformRow.main_challenge || 'N/A'))}`,
        `*Why CA Pro:* ${escapeMrkdwn(truncateText(typeformRow.why_ca_pro || 'N/A'))}`,
        `*Investment Readiness:* ${escapeMrkdwn(truncateText(typeformRow.investment_readiness || 'N/A', 120))}`,
        `*Decision Timeline:* ${escapeMrkdwn(truncateText(typeformRow.decision_timeline || 'N/A', 120))}`,
        `*Has Team:* ${escapeMrkdwn(String(typeformRow.has_team || 'N/A'))}`,
        `*Anything Else:* ${escapeMrkdwn(truncateText(typeformAnythingElse || 'N/A'))}`,
        `*Referral Source:* ${escapeMrkdwn(truncateText(typeformRow.referral_source || 'N/A', 120))}`
    ];

    let onboardingText = '_No Onboarding Chat submission found yet for this member._';
    if (onboardingContext?.onboarding_submission_id) {
        const onboardingData = onboardingContext.onboarding_data || {};
        const answers = onboardingData.answers || {};
        const onboardingTeamMembers = Array.isArray(onboardingData.teamMembers) ? onboardingData.teamMembers.length : 0;
        const onboardingPartners = Array.isArray(onboardingData.cLevelPartners) ? onboardingData.cLevelPartners.length : 0;
        const statusLabel = onboardingContext.onboarding_is_complete ? 'Complete' : 'In Progress';

        const onboardingLines = [
            `*Submission Status:* ${statusLabel} (${onboardingContext.onboarding_progress || 0}% progress)`,
            `*Updated:* ${escapeMrkdwn(formatDateTime(onboardingContext.onboarding_updated_at || onboardingContext.onboarding_created_at))}`,
            `*Business Name:* ${escapeMrkdwn(truncateText(answers.businessName || onboardingContext.bo_business_name || 'N/A', 120))}`,
            `*Team Count:* ${escapeMrkdwn(String(answers.teamCount || onboardingContext.bo_team_count || 'N/A'))}`,
            `*Traffic Sources:* ${escapeMrkdwn(truncateText(answers.trafficSources || 'N/A'))}`,
            `*Landing Pages:* ${escapeMrkdwn(truncateText(answers.landingPages || 'N/A'))}`,
            `*Massive Win:* ${escapeMrkdwn(truncateText(answers.massiveWin || 'N/A'))}`,
            `*AI Skill Level:* ${escapeMrkdwn(String(answers.aiSkillLevel || 'N/A'))}`,
            `*Bio:* ${escapeMrkdwn(truncateText(answers.bio || 'N/A'))}`,
            `*Scheduled Call:* ${escapeMrkdwn(String(answers.scheduleCall || 'N/A'))}`,
            `*WhatsApp Joined:* ${escapeMrkdwn(String(answers.whatsappJoined || (onboardingContext.bo_whatsapp_joined ? 'done' : 'N/A')))}`,
            `*Team Members Added:* ${onboardingTeamMembers}`,
            `*Partners Added:* ${onboardingPartners}`
        ];

        onboardingText = onboardingLines.join('\n');
    }

    return [
        {
            type: 'header',
            text: {
                type: 'plain_text',
                text: `Member Lookup: ${typeformName}`
            }
        },
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `*Data Found:* ${sourceLabel}`
            }
        },
        { type: 'divider' },
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `*📝 Typeform*\n${typeformLines.join('\n')}`
            }
        },
        { type: 'divider' },
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `*💬 Onboarding Chat*\n${onboardingText}`
            }
        }
    ];
}

async function handleMemberLookupDM(pool, channelId, rawText) {
    const query = parseMemberLookupQuery(rawText);
    if (!query) {
        await postMessage(
            channelId,
            'Send a first name, full name, or email to look up a member.',
            [{
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: 'Send a member *first name*, *full name* (`First Last`), or *email* and I will return their Typeform data plus Onboarding Chat data when available.'
                }
            }]
        );
        return;
    }

    const matches = await findTypeformMatches(pool, query);
    if (!matches.length) {
        const queryText = query.type === 'email'
            ? query.email
            : [query.firstName, query.lastName].filter(Boolean).join(' ');
        await postMessage(
            channelId,
            `No members found for "${queryText}".`,
            [{
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `I couldn't find a Typeform member for *${escapeMrkdwn(queryText)}*. Try full name or email.`
                }
            }]
        );
        return;
    }

    if (matches.length > 1) {
        await postMessage(
            channelId,
            `Multiple members found for ${describeLookupQuery(query)}.`,
            buildAmbiguousLookupBlocks(matches, query)
        );
        return;
    }

    const typeformRow = matches[0];
    const onboardingContext = typeformRow.email
        ? await getLatestOnboardingContextByEmail(pool, typeformRow.email)
        : null;

    await postMessage(
        channelId,
        `Member lookup result for ${formatName(typeformRow.first_name, typeformRow.last_name)}`,
        buildMemberLookupBlocks(typeformRow, onboardingContext)
    );
}

// Verify Slack request signature
function verifySlackSignature(req, res, next) {
    const signature = req.headers['x-slack-signature'];
    const timestamp = req.headers['x-slack-request-timestamp'];
    const body = req.rawBody;

    if (!signature || !timestamp || !body) {
        return res.status(400).send('Missing signature headers');
    }

    // Check timestamp to prevent replay attacks (5 min window)
    const time = Math.floor(Date.now() / 1000);
    if (Math.abs(time - timestamp) > 300) {
        return res.status(400).send('Request too old');
    }

    const sigBasestring = `v0:${timestamp}:${body}`;
    const mySignature = 'v0=' + crypto
        .createHmac('sha256', SLACK_SIGNING_SECRET)
        .update(sigBasestring, 'utf8')
        .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature))) {
        return res.status(400).send('Invalid signature');
    }

    next();
}

// Generate welcome message using Claude
async function generateWelcomeMessage(memberData) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY not set');
    }

    const prompt = `You are writing a welcome message for a new CA Pro member to be posted in a WhatsApp group.

Here is the member's information:
- Name: ${memberData.firstName || ''} ${memberData.lastName || ''}
- Business Name: ${memberData.businessName || 'Not provided'}
- Business Overview: ${memberData.businessOverview || 'Not provided'}
- What they want to achieve (massive win): ${memberData.massiveWin || 'Not provided'}
- Team Count: ${memberData.teamCount || 'Not provided'}
- Traffic Sources: ${memberData.trafficSources || 'Not provided'}

Write a warm, professional welcome message similar to these examples:

Example 1:
"Hey guys, please join me in extending a warm welcome to our newest CA Pro Member, Michele Monacommi! He is the co-founder of an anti-age skincare brand for men made in Italy, selling in both Italy and the US market.

Michele is joining CA Pro to increase creative output and become more efficient with AI, as he currently handles most of the creative development with his business partner.

We're thrilled to have Michele in the CA Pro community and excited to support his growth.
Welcome Michele!"

Example 2:
"Hey guys, please join me in extending a warm welcome to our newest CA Pro Member, Collin Schmelebeck!

Collin is a Google Ads specialist who helps Meta-driven DTC brands build independent acquisition channels on Google and YouTube without relying solely on Meta to scale. A Navy veteran, Collin is focused on taking full control of the funnel—from AI-powered landing page creation to static and video ad production.

He's joining CA Pro to speed up his entire ad lander process and create complete systems that let him deliver better results for his clients faster than competitors.

We're excited to have Collin in the CA Pro community and to support his growth. Welcome Collin!"

Guidelines:
- Start with "Hey guys, please join me in extending a warm welcome..." or similar
- Include their name and brief business description
- Mention why they're joining/what they hope to achieve
- End with a warm welcome
- Keep it 2-4 short paragraphs
- Be genuine and enthusiastic but not over the top
- Use their first name naturally throughout

Write ONLY the welcome message, no additional commentary.`;

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
    return data.content[0]?.text || 'Error generating message';
}

// Edit welcome message using Claude with full member context
async function editWelcomeMessage(originalMessage, editRequest, memberData = {}) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY not set');
    }

    const fullName = [memberData.firstName, memberData.lastName].filter(Boolean).join(' ') || 'the member';

    const prompt = `You are editing a welcome message for a CA Pro member.

MEMBER INFORMATION (all available context):
- Name: ${fullName}
- Business Name: ${memberData.businessName || 'Not provided'}
- Business Description: ${memberData.typeformBusinessDescription || 'Not provided'}
- Bio: ${memberData.bio || 'Not provided'}
- Revenue Level: ${memberData.typeformAnnualRevenue || 'Not provided'}
- Revenue Trend: ${memberData.typeformRevenueTrend || 'Not provided'}
- Team Size: ${memberData.teamCount || 'Not provided'}
- Has Team: ${memberData.typeformHasTeam || 'Not provided'}
- Traffic Sources: ${memberData.trafficSources || 'Not provided'}
- Main Challenge: ${memberData.typeformMainChallenge || 'Not provided'}
- What they want to achieve: ${memberData.massiveWin || 'Not provided'}
- Why they joined CA Pro: ${memberData.typeformWhyCaPro || 'Not provided'}
- Investment Readiness: ${memberData.typeformInvestmentReadiness || 'Not provided'}
- Decision Timeline: ${memberData.typeformDecisionTimeline || 'Not provided'}
- Additional Info: ${memberData.typeformAnythingElse || 'Not provided'}
- Referral Source: ${memberData.typeformReferralSource || 'Not provided'}

CURRENT WELCOME MESSAGE:
"${originalMessage}"

REQUESTED CHANGE:
"${editRequest}"

IMPORTANT RULES:
1. NEVER include specific revenue numbers or dollar amounts. Only use general terms like "7 figures", "8 figures", etc.
2. NEVER include email addresses or phone numbers.
3. Keep the warm, professional tone.
4. Apply ONLY the requested change - don't rewrite the entire message unless asked.

Please provide the updated welcome message with the requested change applied. Write ONLY the updated welcome message, no additional commentary or explanation.`;

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
    return data.content[0]?.text || 'Error generating message';
}

// Send Slack message with blocks
async function sendSlackMessage(channel, welcomeMessage, memberData) {
    const memberName = `${memberData.firstName || ''} ${memberData.lastName || ''}`.trim();

    const blocks = [
        {
            type: 'header',
            text: {
                type: 'plain_text',
                text: `Welcome Message for ${memberName}`,
                emoji: true
            }
        },
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: welcomeMessage
            }
        },
        {
            type: 'divider'
        },
        {
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: {
                        type: 'plain_text',
                        text: '📋 Copy Message',
                        emoji: true
                    },
                    action_id: 'copy_message',
                    style: 'primary'
                },
                {
                    type: 'button',
                    text: {
                        type: 'plain_text',
                        text: '✏️ Edit Message',
                        emoji: true
                    },
                    action_id: 'edit_message'
                }
            ]
        }
    ];

    const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
        },
        body: JSON.stringify({
            channel,
            blocks,
            text: `Welcome message for ${memberName}`, // Fallback text
            metadata: {
                event_type: 'welcome_message',
                event_payload: {
                    welcome_message: welcomeMessage,
                    member_name: memberName
                }
            }
        })
    });

    const data = await response.json();
    if (!data.ok) {
        throw new Error(`Slack API error: ${data.error}`);
    }
    return data;
}

// Send message to DM a specific user
async function sendDMToUser(userId, welcomeMessage, memberData) {
    // Open DM channel with user
    const openResponse = await fetch('https://slack.com/api/conversations.open', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
        },
        body: JSON.stringify({ users: userId })
    });

    const openData = await openResponse.json();
    if (!openData.ok) {
        throw new Error(`Failed to open DM: ${openData.error}`);
    }

    const channelId = openData.channel.id;
    return sendSlackMessage(channelId, welcomeMessage, memberData);
}

// Handle Slack interactions (button clicks)
router.post('/interactions', verifySlackSignature, async (req, res) => {
    try {
        // Slack sends interactions as application/x-www-form-urlencoded with a 'payload' field
        const payload = req.body.payload ? JSON.parse(req.body.payload) : req.body;

        // Handle URL verification
        if (payload.type === 'url_verification') {
            return res.json({ challenge: payload.challenge });
        }

        // Handle message shortcuts (works in threads; slash commands do not)
        if ((payload.type === 'message_action' || payload.type === 'shortcut') && payload.callback_id === 'add_application_note') {
            const pool = req.app.locals.pool;
            const triggerId = payload.trigger_id;
            const channelId = payload.channel?.id;
            const message = payload.message || null;

            if (!channelId || !message?.ts) {
                return res.status(200).send();
            }

            const applicationChannelId = process.env.CA_PRO_APPLICATION_SLACK_CHANNEL_ID;
            if (applicationChannelId && channelId !== applicationChannelId) {
                // Shortcuts are allowed anywhere, but we only support attaching notes from the application channel.
                // Acknowledge silently to avoid noisy errors in other channels.
                return res.status(200).send();
            }

            // If invoked on a thread reply, Slack includes `thread_ts` (root). Otherwise use the message ts.
            const threadTs = message.thread_ts || message.ts;

            let applicationId = null;
            let applicationEmail = null;

            try {
                const appResult = await pool.query(
                    'SELECT id, email FROM typeform_applications WHERE slack_thread_ts = $1 AND slack_channel_id = $2 LIMIT 1',
                    [threadTs, channelId]
                );
                applicationId = appResult.rows[0]?.id || null;
                applicationEmail = appResult.rows[0]?.email || null;
            } catch (dbErr) {
                console.error('Error resolving application for add_application_note shortcut:', dbErr.message);
            }

            let fallbackEmail = applicationEmail || extractEmailFromSlackMessage(message);

            if (!fallbackEmail && threadTs) {
                try {
                    const historyResponse = await fetch(`https://slack.com/api/conversations.replies?channel=${channelId}&ts=${threadTs}&limit=1`, {
                        headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` }
                    });
                    const historyData = await historyResponse.json();
                    if (historyData.ok && Array.isArray(historyData.messages) && historyData.messages.length > 0) {
                        fallbackEmail = extractEmailFromSlackMessage(historyData.messages[0]);
                    }
                } catch (fetchErr) {
                    console.error('Error fetching thread root for add_application_note shortcut:', fetchErr.message);
                }
            }

            if (!applicationId && fallbackEmail) {
                try {
                    const appResult = await pool.query(
                        'SELECT id, email FROM typeform_applications WHERE LOWER(email) = LOWER($1) ORDER BY created_at DESC LIMIT 1',
                        [fallbackEmail]
                    );
                    applicationId = appResult.rows[0]?.id || null;
                    applicationEmail = appResult.rows[0]?.email || fallbackEmail;
                } catch (dbErr) {
                    console.error('Error resolving application by email for add_application_note shortcut:', dbErr.message);
                }
            }

            if (!applicationId && !fallbackEmail) {
                await openModal(triggerId, {
                    type: 'modal',
                    title: { type: 'plain_text', text: 'Add Note' },
                    close: { type: 'plain_text', text: 'Close' },
                    blocks: [
                        {
                            type: 'section',
                            text: {
                                type: 'mrkdwn',
                                text: 'I couldn’t determine which application this thread belongs to. Try running this shortcut on the top application message, or use `/note email@example.com <text>`.'
                            }
                        }
                    ]
                });
                return res.status(200).send();
            }

            const view = {
                type: 'modal',
                callback_id: 'add_application_note_modal',
                title: { type: 'plain_text', text: 'Add Note' },
                submit: { type: 'plain_text', text: 'Save' },
                close: { type: 'plain_text', text: 'Cancel' },
                private_metadata: JSON.stringify({
                    channelId,
                    threadTs,
                    applicationId,
                    fallbackEmail: fallbackEmail || null
                }),
                blocks: [
                    {
                        type: 'context',
                        elements: [
                            {
                                type: 'mrkdwn',
                                text: `Adding a note for *${applicationEmail || fallbackEmail || 'this application'}*`
                            }
                        ]
                    },
                    {
                        type: 'input',
                        block_id: 'note_text_block',
                        label: { type: 'plain_text', text: 'Note' },
                        element: {
                            type: 'plain_text_input',
                            action_id: 'note_text',
                            multiline: true,
                            placeholder: { type: 'plain_text', text: 'Type your note…' }
                        }
                    }
                ]
            };

            await openModal(triggerId, view);
            return res.status(200).send();
        }

        if ((payload.type === 'message_action' || payload.type === 'shortcut') && payload.callback_id === 'add_cancel_reason') {
            const pool = req.app.locals.pool;
            const triggerId = payload.trigger_id;
            const channelId = payload.channel?.id;
            const message = payload.message || null;

            if (!channelId || !message?.ts) {
                return res.status(200).send();
            }

            const notificationsChannelId = process.env.CA_PRO_NOTIFICATIONS_SLACK_CHANNEL;
            if (notificationsChannelId && channelId !== notificationsChannelId) {
                return res.status(200).send();
            }

            const threadTs = message.thread_ts || message.ts;

            let memberEmail = null;
            let memberName = null;
            let memberThreadId = null;

            try {
                const threadResult = await pool.query(
                    'SELECT id, member_email, member_name FROM member_threads WHERE slack_channel_id = $1 AND slack_thread_ts = $2 LIMIT 1',
                    [channelId, threadTs]
                );
                if (threadResult.rows[0]) {
                    memberThreadId = threadResult.rows[0].id;
                    memberEmail = threadResult.rows[0].member_email;
                    memberName = threadResult.rows[0].member_name;
                }
            } catch (dbErr) {
                console.error('Error resolving member thread for cancel reason shortcut:', dbErr.message);
            }

            if (!memberEmail) {
                memberEmail = extractEmailFromSlackMessage(message);
            }

            if (!memberEmail && threadTs) {
                try {
                    const historyResponse = await fetch(`https://slack.com/api/conversations.replies?channel=${channelId}&ts=${threadTs}&limit=1`, {
                        headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` }
                    });
                    const historyData = await historyResponse.json();
                    if (historyData.ok && Array.isArray(historyData.messages) && historyData.messages.length > 0) {
                        memberEmail = extractEmailFromSlackMessage(historyData.messages[0]);
                    }
                } catch (fetchErr) {
                    console.error('Error fetching thread root for cancel reason shortcut:', fetchErr.message);
                }
            }

            const view = {
                type: 'modal',
                callback_id: 'add_cancel_reason_modal',
                title: { type: 'plain_text', text: 'Cancel Reason' },
                submit: { type: 'plain_text', text: 'Save' },
                close: { type: 'plain_text', text: 'Cancel' },
                private_metadata: JSON.stringify({
                    channelId,
                    threadTs,
                    memberEmail,
                    memberName,
                    memberThreadId
                }),
                blocks: [
                    {
                        type: 'context',
                        elements: [
                            {
                                type: 'mrkdwn',
                                text: `Adding a cancellation reason for *${memberName || memberEmail || 'this member'}*`
                            }
                        ]
                    },
                    {
                        type: 'input',
                        block_id: 'cancel_reason_block',
                        label: { type: 'plain_text', text: 'Reason' },
                        element: {
                            type: 'plain_text_input',
                            action_id: 'cancel_reason',
                            multiline: true,
                            placeholder: { type: 'plain_text', text: 'Why are they canceling?' }
                        }
                    }
                ]
            };

            await openModal(triggerId, view);
            return res.status(200).send();
        }

        // Handle block actions (button clicks)
        if (payload.type === 'block_actions') {
            const action = payload.actions[0];
            const triggerId = payload.trigger_id;
            const messageTs = payload.message.ts;
            const channelId = payload.channel.id;

            // Extract welcome message from the original message blocks
            const welcomeMessage = payload.message.blocks
                .find(b => b.type === 'section')?.text?.text || '';

            if (action.action_id === 'copy_message') {
                // Open modal with copyable text
                await fetch('https://slack.com/api/views.open', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
                    },
                    body: JSON.stringify({
                        trigger_id: triggerId,
                        view: {
                            type: 'modal',
                            title: {
                                type: 'plain_text',
                                text: 'Copy Welcome Message'
                            },
                            close: {
                                type: 'plain_text',
                                text: 'Close'
                            },
                            blocks: [
                                {
                                    type: 'section',
                                    text: {
                                        type: 'mrkdwn',
                                        text: '*Select all and copy the message below:*'
                                    }
                                },
                                {
                                    type: 'input',
                                    element: {
                                        type: 'plain_text_input',
                                        multiline: true,
                                        initial_value: welcomeMessage,
                                        action_id: 'copy_text'
                                    },
                                    label: {
                                        type: 'plain_text',
                                        text: 'Welcome Message'
                                    }
                                }
                            ]
                        }
                    })
                });
                return res.status(200).send();
            }

            if (action.action_id === 'edit_message') {
                // Start a thread for editing
                await fetch('https://slack.com/api/chat.postMessage', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
                    },
                    body: JSON.stringify({
                        channel: channelId,
                        thread_ts: messageTs,
                        text: "What would you like to change about this welcome message? Just describe the edit you want (e.g., \"make it shorter\", \"add that they have 5 years of experience\", \"change the tone to be more casual\").",
                        metadata: {
                            event_type: 'edit_thread',
                            event_payload: {
                                original_message: welcomeMessage,
                                parent_ts: messageTs
                            }
                        }
                    })
                });
                return res.status(200).send();
            }

            // Handle "Send Reply" button click - open modal
            if (action.action_id === 'open_send_message_modal') {
                const actionData = JSON.parse(action.value);
                const contextType = actionData.contextType || (actionData.applicationId ? 'typeform_application' : null) || 'typeform_application';
                const contextId = actionData.contextId || actionData.applicationId || null;
                const modal = slackBlocks.createSendMessageModal(
                    actionData.recipientName,
                    actionData.recipientEmail,
                    actionData.threadId,
                    contextType,
                    contextId
                );
                await openModal(triggerId, modal);
                return res.status(200).send();
            }

            // Handle "Cancel" button click - cancel pending email and delete message
            if (action.action_id === 'cancel_pending_email') {
                const pendingEmailId = action.value;
                const pool = req.app.locals.pool;

                // Cancel the pending email and get the sending_message_ts
                const result = await pool.query(`
                    UPDATE pending_email_sends
                    SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP
                    WHERE id = $1 AND status = 'pending'
                    RETURNING *
                `, [pendingEmailId]);

                if (result.rows.length > 0) {
                    const pending = result.rows[0];

                    // Delete the "Sending..." message
                    if (pending.channel_id && pending.sending_message_ts) {
                        try {
                            await deleteMessage(pending.channel_id, pending.sending_message_ts);
                        } catch (delErr) {
                            console.log('[Slack] Could not delete sending message:', delErr.message);
                        }
                    }

                    console.log(`[Email] Cancelled pending email to ${pending.to_email}`);
                }
                return res.status(200).send();
            }

            // Handle "Copy WhatsApp Template" button
            if (action.action_id === 'copy_whatsapp_template') {
                const data = JSON.parse(action.value);
                // Open modal with copyable text
                await fetch('https://slack.com/api/views.open', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
                    },
                    body: JSON.stringify({
                        trigger_id: triggerId,
                        view: {
                            type: 'modal',
                            title: {
                                type: 'plain_text',
                                text: 'Copy WhatsApp Message'
                            },
                            close: {
                                type: 'plain_text',
                                text: 'Close'
                            },
                            blocks: [
                                {
                                    type: 'section',
                                    text: {
                                        type: 'mrkdwn',
                                        text: '*Select all and copy the message below:*'
                                    }
                                },
                                {
                                    type: 'input',
                                    element: {
                                        type: 'plain_text_input',
                                        multiline: true,
                                        initial_value: data.message,
                                        action_id: 'copy_text'
                                    },
                                    label: {
                                        type: 'plain_text',
                                        text: 'WhatsApp Message'
                                    }
                                }
                            ]
                        }
                    })
                });
                return res.status(200).send();
            }
        }

        // Handle modal submissions
        if (payload.type === 'view_submission' && payload.view.callback_id === 'send_email_modal') {
            const pool = req.app.locals.pool;
            const privateMetadata = JSON.parse(payload.view.private_metadata);
            const messageText = payload.view.state.values.message_block.message_input.value;
            const userId = payload.user.id;
            const contextType = privateMetadata.contextType || (privateMetadata.applicationId ? 'typeform_application' : null);
            const contextId = privateMetadata.contextId || privateMetadata.applicationId || null;
            const typeformApplicationId = contextType === 'typeform_application' ? contextId : null;

            let replySubject = 'Re: Thanks for applying to CA Pro';
            if (privateMetadata.threadId) {
                try {
                    const subjectResult = await pool.query(
                        'SELECT subject FROM email_threads WHERE gmail_thread_id = $1 ORDER BY created_at DESC LIMIT 1',
                        [privateMetadata.threadId]
                    );
                    const threadSubject = subjectResult.rows[0]?.subject;
                    if (threadSubject) {
                        replySubject = threadSubject.toLowerCase().startsWith('re:') ? threadSubject : `Re: ${threadSubject}`;
                    }
                } catch (err) {
                    console.error('Error fetching email thread subject:', err.message);
                }
            }

            // Insert pending email with 10-second delay
            const UNDO_DELAY_MS = 10000; // 10 seconds
            const sendAt = new Date(Date.now() + UNDO_DELAY_MS);

            const result = await pool.query(`
                INSERT INTO pending_email_sends (
                    to_email, subject, body, gmail_thread_id, typeform_application_id,
                    context_type, context_id,
                    user_id, channel_id, thread_ts, send_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                RETURNING id
            `, [
                privateMetadata.recipientEmail,
                replySubject,
                messageText,
                privateMetadata.threadId,
                typeformApplicationId,
                contextType,
                contextId,
                userId,
                '', // We'll update with channel from application
                null, // thread_ts
                sendAt
            ]);

            const pendingEmailId = result.rows[0].id;

            // Get the application's slack thread info
            let appResult = null;
            if (contextType === 'typeform_application' && typeformApplicationId) {
                appResult = await pool.query(
                    'SELECT slack_channel_id, slack_thread_ts FROM typeform_applications WHERE id = $1',
                    [typeformApplicationId]
                );
            } else if (contextType === 'yearly_renewal' && contextId) {
                appResult = await pool.query(
                    'SELECT slack_channel_id, slack_thread_ts FROM member_threads WHERE id = $1',
                    [contextId]
                );
            }

            let sendingMessageTs = null;
            let channelId = null;
            let threadTs = null;

            if (appResult?.rows?.[0]?.slack_channel_id) {
                channelId = appResult.rows[0].slack_channel_id;
                threadTs = appResult.rows[0].slack_thread_ts;

                // Update the pending email with channel info
                await pool.query(
                    'UPDATE pending_email_sends SET channel_id = $1, thread_ts = $2 WHERE id = $3',
                    [channelId, threadTs, pendingEmailId]
                );

                // Post regular "Sending..." message with Undo button (can be deleted later)
                const sendingBlock = slackBlocks.createSendingEphemeralBlock(
                    privateMetadata.recipientEmail,
                    sendAt.toISOString(),
                    pendingEmailId
                );

                const sendingMsg = await postMessage(
                    channelId,
                    sendingBlock.text,
                    sendingBlock.blocks,
                    threadTs
                );
                sendingMessageTs = sendingMsg.ts;

                // Store the sending message ts so we can delete it later
                await pool.query(
                    'UPDATE pending_email_sends SET sending_message_ts = $1 WHERE id = $2',
                    [sendingMessageTs, pendingEmailId]
                );
            }

            // Schedule email send with setTimeout (runs in main service)
            setTimeout(async () => {
                try {
                    // Re-check if the email was cancelled
                    const pendingCheck = await pool.query(
                        'SELECT * FROM pending_email_sends WHERE id = $1',
                        [pendingEmailId]
                    );

                    const pending = pendingCheck.rows[0];
                    if (!pending || pending.status !== 'pending') {
                        console.log(`[Email] Pending email ${pendingEmailId} was cancelled or already processed`);
                        return;
                    }

                    // Get the existing thread to reply to
                    let gmailThreadId = pending.gmail_thread_id;
                    let messageId = null;

                    if (gmailThreadId) {
                        try {
                            const thread = await gmailService.getThread(gmailThreadId);
                            if (thread.messages && thread.messages.length > 0) {
                                const lastMessage = thread.messages[thread.messages.length - 1];
                                messageId = lastMessage.payload.headers.find(h => h.name.toLowerCase() === 'message-id')?.value;
                            }
                        } catch (e) {
                            console.log('[Email] Could not get thread for reply:', e.message);
                        }
                    }

                    // Send the email
                    const subject = pending.subject || 'Re: Thanks for applying to CA Pro';
                    const emailResult = await gmailService.sendEmail(
                        pending.to_email,
                        subject,
                        pending.body,
                        gmailThreadId,
                        messageId
                    );

                    // Update pending email status
                    await pool.query(`
                        UPDATE pending_email_sends SET
                            status = 'sent',
                            sent_at = CURRENT_TIMESTAMP,
                            gmail_thread_id = $1
                        WHERE id = $2
                    `, [emailResult.threadId, pendingEmailId]);

                    // Log activity
                    await pool.query(`
                        INSERT INTO activity_log (action, entity_type, entity_id, details)
                        VALUES ($1, $2, $3, $4)
                    `, ['email_reply_sent', pending.context_type || 'typeform_application', pending.context_id || pending.typeform_application_id, JSON.stringify({
                        email: pending.to_email,
                        gmail_thread_id: emailResult.threadId,
                        user_id: pending.user_id
                    })]);

                    // Delete the "Sending..." message and post confirmation
                    if (pending.channel_id && pending.sending_message_ts) {
                        try {
                            await deleteMessage(pending.channel_id, pending.sending_message_ts);
                        } catch (delErr) {
                            console.log('[Email] Could not delete sending message:', delErr.message);
                        }
                    }

                    // Post confirmation to thread
                    if (pending.channel_id && pending.thread_ts) {
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
                    }

                    console.log(`[Email] Sent email to ${pending.to_email} (immediate)`);

                } catch (error) {
                    console.error(`[Email] Error sending email ${pendingEmailId}:`, error.message);

                    // Mark as failed
                    await pool.query(`
                        UPDATE pending_email_sends SET
                            status = 'failed',
                            error_message = $1
                        WHERE id = $2
                    `, [error.message, pendingEmailId]);

                    // Post error to thread
                    if (channelId && threadTs) {
                        const errorBlock = slackBlocks.createEmailFailedBlock(
                            privateMetadata.recipientEmail,
                            error.message
                        );
                        await postMessage(channelId, errorBlock.text, errorBlock.blocks, threadTs);
                    }
                }
            }, UNDO_DELAY_MS + 1000); // Add 1 second buffer

            // Return empty response to close modal
            return res.status(200).send();
        }

        if (payload.type === 'view_submission' && payload.view.callback_id === 'add_application_note_modal') {
            const pool = req.app.locals.pool;

            let privateMetadata = {};
            try {
                privateMetadata = JSON.parse(payload.view.private_metadata || '{}') || {};
            } catch {
                privateMetadata = {};
            }

            const userId = payload.user?.id;
            const userName = payload.user?.username || payload.user?.name || 'unknown';
            const createdBy = `${userName} (<@${userId}>)`;

            const noteText = payload.view.state.values?.note_text_block?.note_text?.value?.trim() || '';
            if (!noteText) {
                return res.json({
                    response_action: 'errors',
                    errors: {
                        note_text_block: 'Please enter a note.'
                    }
                });
            }

            const channelId = privateMetadata.channelId;
            const threadTs = privateMetadata.threadTs;
            let applicationId = privateMetadata.applicationId || null;

            // Try resolving from thread context first (best case for auto-created application threads)
            if (!applicationId && channelId && threadTs) {
                try {
                    const appResult = await pool.query(
                        'SELECT id FROM typeform_applications WHERE slack_thread_ts = $1 AND slack_channel_id = $2 LIMIT 1',
                        [threadTs, channelId]
                    );
                    applicationId = appResult.rows[0]?.id || null;
                } catch (dbErr) {
                    console.error('Error resolving application by thread for note modal:', dbErr.message);
                }
            }

            // Fallback: resolve by email parsed from the thread (captured at modal-open time)
            const identifier = privateMetadata.fallbackEmail || '';

            if (!applicationId && identifier) {
                try {
                    if (looksLikeUuid(identifier)) {
                        const appResult = await pool.query(
                            'SELECT id FROM typeform_applications WHERE id = $1 LIMIT 1',
                            [identifier]
                        );
                        applicationId = appResult.rows[0]?.id || null;
                    } else if (looksLikeEmail(identifier)) {
                        const appResult = await pool.query(
                            'SELECT id FROM typeform_applications WHERE LOWER(email) = LOWER($1) ORDER BY created_at DESC LIMIT 1',
                            [identifier]
                        );
                        applicationId = appResult.rows[0]?.id || null;
                    }
                } catch (dbErr) {
                    console.error('Error resolving application by identifier for note modal:', dbErr.message);
                }
            }

            if (!applicationId) {
                return res.json({
                    response_action: 'errors',
                    errors: {
                        note_text_block: 'Could not determine which application this note is for. Make sure you ran this shortcut in an application thread.'
                    }
                });
            }

            // Create DB note; sync to Slack threads in the background.
            const { note, applicationEmail } = await createApplicationNote({
                pool,
                applicationId,
                noteText,
                createdBy
            });

            res.status(200).send();

            setImmediate(async () => {
                const syncStatus = {
                    slack_application_synced: false,
                    slack_application_message_ts: null,
                    slack_purchase_synced: false,
                    slack_purchase_message_ts: null
                };

                try {
                    if (channelId && threadTs) {
                        const noteBlock = slackBlocks.createNoteAddedBlock(note.note_text, note.created_by, note.created_at);
                        const slackResponse = await postMessage(channelId, noteBlock.text, noteBlock.blocks, threadTs);
                        if (slackResponse?.ts) {
                            await pool.query(
                                'UPDATE application_notes SET slack_synced = true, slack_message_ts = $1 WHERE id = $2',
                                [slackResponse.ts, note.id]
                            );
                            syncStatus.slack_application_synced = true;
                            syncStatus.slack_application_message_ts = slackResponse.ts;
                        }
                    }
                } catch (slackError) {
                    console.error('Failed to sync note to Slack application thread (shortcut):', slackError.message);
                }

                try {
                    const purchaseResponse = await postNoteToPurchaseThread(pool, applicationEmail, note.note_text, note.created_by, note.created_at);
                    if (purchaseResponse?.ts) {
                        syncStatus.slack_purchase_synced = true;
                        syncStatus.slack_purchase_message_ts = purchaseResponse.ts;
                    }
                } catch (slackError) {
                    console.error('Failed to sync note to Slack purchase thread (shortcut):', slackError.message);
                }

                try {
                    await pool.query(
                        'INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4)',
                        ['note_added', 'typeform_application', applicationId, JSON.stringify({
                            note_id: note.id,
                            created_by: createdBy,
                            source: 'slack_shortcut',
                            ...syncStatus
                        })]
                    );
                } catch (logError) {
                    console.error('Failed to log note_added activity (slack shortcut):', logError.message);
                }
            });

            return;
        }

        if (payload.type === 'view_submission' && payload.view.callback_id === 'add_cancel_reason_modal') {
            const pool = req.app.locals.pool;

            let privateMetadata = {};
            try {
                privateMetadata = JSON.parse(payload.view.private_metadata || '{}') || {};
            } catch {
                privateMetadata = {};
            }

            const userId = payload.user?.id;
            const userName = payload.user?.username || payload.user?.name || 'unknown';
            const createdBy = `${userName} (<@${userId}>)`;

            const reasonText = payload.view.state.values?.cancel_reason_block?.cancel_reason?.value?.trim() || '';
            if (!reasonText) {
                return res.json({
                    response_action: 'errors',
                    errors: {
                        cancel_reason_block: 'Please enter a reason.'
                    }
                });
            }

            const memberEmail = (privateMetadata.memberEmail || '').toLowerCase();
            const memberName = privateMetadata.memberName || null;
            const channelId = privateMetadata.channelId || null;
            const threadTs = privateMetadata.threadTs || null;
            const memberThreadId = privateMetadata.memberThreadId || null;

            if (!memberEmail) {
                return res.json({
                    response_action: 'errors',
                    errors: {
                        cancel_reason_block: 'Could not determine which member this cancellation is for.'
                    }
                });
            }

            let cancellationId = null;

            try {
                const existing = await pool.query(
                    `
                      SELECT id
                      FROM cancellations
                      WHERE member_email = $1 AND reason IS NULL
                      ORDER BY created_at DESC
                      LIMIT 1
                    `,
                    [memberEmail]
                );

                if (existing.rows[0]) {
                    const updateResult = await pool.query(
                        `
                          UPDATE cancellations
                          SET reason = $2,
                              source = $3,
                              created_by = $4
                          WHERE id = $1
                          RETURNING id
                        `,
                        [existing.rows[0].id, reasonText, 'slack_shortcut', createdBy]
                    );
                    cancellationId = updateResult.rows[0]?.id || existing.rows[0].id;
                } else {
                    const insertResult = await pool.query(
                        `
                          INSERT INTO cancellations (member_email, member_name, reason, source, created_by, slack_channel_id, slack_thread_ts, member_thread_id)
                          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                          RETURNING id
                        `,
                        [memberEmail, memberName, reasonText, 'slack_shortcut', createdBy, channelId, threadTs, memberThreadId]
                    );
                    cancellationId = insertResult.rows[0]?.id || null;
                }
            } catch (dbErr) {
                console.error('Error saving cancel reason:', dbErr.message);
            }

            res.status(200).send();

            setImmediate(async () => {
                try {
                    if (channelId && threadTs) {
                        const reasonBlock = slackBlocks.createCancellationReasonBlock(
                            memberName || memberEmail,
                            reasonText,
                            createdBy
                        );
                        await postMessage(channelId, reasonBlock.text, reasonBlock.blocks, threadTs);
                    }
                } catch (slackError) {
                    console.error('Failed to post cancellation reason to Slack thread:', slackError.message);
                }

                try {
                    await pool.query(
                        'INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4)',
                        ['cancellation_reason_added', 'cancellation', cancellationId, JSON.stringify({
                            email: memberEmail,
                            created_by: createdBy,
                            source: 'slack_shortcut'
                        })]
                    );
                } catch (logError) {
                    console.error('Failed to log cancellation_reason_added:', logError.message);
                }
            });

            return;
        }

        // Handle message events (for edit thread replies)
        if (payload.type === 'event_callback' && payload.event.type === 'message') {
            // This will be handled by the events endpoint
            return res.status(200).send();
        }

        res.status(200).send();
    } catch (error) {
        console.error('Slack interaction error:', error);
        res.status(500).send('Error processing interaction');
    }
});

// Handle Slack slash commands
// Currently supported:
// - /note <email|applicationId> <text>
// Note: Slack does not allow custom slash commands to be invoked from message threads.
// For thread-based note entry, use the Slack message shortcut "Add Note" (callback_id: add_application_note).
router.post('/commands', verifySlackSignature, async (req, res) => {
    const pool = req.app.locals.pool;

    try {
        const command = req.body.command;
        if (command !== '/note') {
            return res.status(200).send();
        }

        const applicationChannelId = process.env.CA_PRO_APPLICATION_SLACK_CHANNEL_ID;
        const channelId = req.body.channel_id;

        if (applicationChannelId && channelId !== applicationChannelId) {
            return res.json({
                response_type: 'ephemeral',
                text: `Please use /note inside the application threads in <#${applicationChannelId}>.`
            });
        }

        const userId = req.body.user_id;
        const userName = req.body.user_name || 'unknown';
        const createdBy = `${userName} (<@${userId}>)`;

        const fullText = (req.body.text || '').trim();

        // If Slack includes thread_ts, we can resolve the application from the thread root.
        // (Slack custom slash commands generally cannot be invoked from thread replies, but keep this for safety.)
        const threadTs = req.body.thread_ts || null;

        let applicationId = null;
        let noteText = fullText;
        let resolveMode = 'thread';

        if (threadTs) {
            const appResult = await pool.query(
                'SELECT id FROM typeform_applications WHERE slack_thread_ts = $1 AND slack_channel_id = $2 LIMIT 1',
                [threadTs, channelId]
            );
            applicationId = appResult.rows[0]?.id || null;
        }

        // Fallback: allow "/note email@example.com note..." or "/note <applicationId> note..."
        if (!applicationId) {
            resolveMode = 'argument';

            const parts = fullText.split(/\s+/);
            const identifier = parts.shift();
            noteText = parts.join(' ').trim();

            if (looksLikeUuid(identifier)) {
                const appResult = await pool.query(
                    'SELECT id FROM typeform_applications WHERE id = $1',
                    [identifier]
                );
                applicationId = appResult.rows[0]?.id || null;
            } else if (looksLikeEmail(identifier)) {
                const appResult = await pool.query(
                    'SELECT id FROM typeform_applications WHERE LOWER(email) = LOWER($1) ORDER BY created_at DESC LIMIT 1',
                    [identifier]
                );
                applicationId = appResult.rows[0]?.id || null;
            } else {
                // If we don't have thread context and no identifier, treat the whole text as a note but fail with usage.
                noteText = fullText;
            }
        }

        if (!applicationId) {
            return res.json({
                response_type: 'ephemeral',
                text: 'Could not determine which application this note is for. Try `/note email@example.com <text>`.'
            });
        }

        if (!noteText || !noteText.trim()) {
            return res.json({
                response_type: 'ephemeral',
                text: 'Note text is required. Usage: `/note <text>`.'
            });
        }

        const { note, applicationEmail } = await createApplicationNote({
            pool,
            applicationId,
            noteText,
            createdBy
        });

        // Respond quickly to avoid Slack slash command timeouts; sync to Slack threads in the background.
        res.json({
            response_type: 'ephemeral',
            text: `✅ Note saved${applicationEmail ? ` for ${applicationEmail}` : ''}. Syncing to threads... (${resolveMode})`
        });

        setImmediate(async () => {
            const syncStatus = await syncApplicationNoteToSlack({
                pool,
                applicationId,
                applicationEmail,
                noteId: note.id,
                noteText: note.note_text,
                createdBy: note.created_by,
                createdAt: note.created_at
            });

            try {
                await pool.query(
                    'INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4)',
                    ['note_added', 'typeform_application', applicationId, JSON.stringify({
                        note_id: note.id,
                        created_by: createdBy,
                        source: 'slack_command',
                        ...syncStatus
                    })]
                );
            } catch (logError) {
                console.error('Failed to log note_added activity (slack command):', logError.message);
            }
        });
    } catch (error) {
        console.error('Slack command error:', error);
        return res.json({
            response_type: 'ephemeral',
            text: `Error creating note: ${error.message}`
        });
    }
});

// Handle Slack events (for thread replies)
router.post('/events', verifySlackSignature, async (req, res) => {
    try {
        const payload = req.body;
        const pool = req.app.locals.pool;

        // Handle URL verification
        if (payload.type === 'url_verification') {
            return res.json({ challenge: payload.challenge });
        }

        // Acknowledge immediately
        res.status(200).send();

        // Handle direct-message member lookup requests
        if (payload.event?.type === 'message' &&
            payload.event.channel_type === 'im' &&
            !payload.event.bot_id &&
            !payload.event.subtype) {
            const event = payload.event;
            const channelId = event.channel;

            try {
                await handleMemberLookupDM(pool, channelId, event.text || '');
            } catch (lookupError) {
                console.error('[Slack Events] DM lookup error:', lookupError);
                try {
                    await postMessage(channelId, 'Sorry, I hit an error while looking that up.');
                } catch (postError) {
                    console.error('[Slack Events] Failed to post DM lookup error message:', postError.message);
                }
            }
            return;
        }

        // Handle message events in threads
        console.log('[Slack Events] Received event:', payload.event?.type, 'subtype:', payload.event?.subtype);

        if (payload.event?.type === 'message' &&
            payload.event.thread_ts &&
            !payload.event.bot_id &&
            !payload.event.subtype) { // Ignore message_changed, message_deleted, etc.

            const event = payload.event;
            const editRequest = event.text;
            const threadTs = event.thread_ts;
            const channelId = event.channel;

            console.log(`[Slack Events] Thread reply in ${channelId}, thread ${threadTs}: "${editRequest?.substring(0, 50)}..."`);

            // Only allow welcome-message editing in the #notifications-capro purchase+welcome threads
            // (prevents the bot from responding in other channels/threads like #ca-pro-application).
            const notificationsChannelId = process.env.CA_PRO_NOTIFICATIONS_SLACK_CHANNEL;
            if (!notificationsChannelId) {
                console.log('[Slack Events] CA_PRO_NOTIFICATIONS_SLACK_CHANNEL not set - skipping welcome edit handling');
                return;
            }
            if (channelId !== notificationsChannelId) {
                console.log(`[Slack Events] Skipping thread reply - channel ${channelId} is not notifications channel ${notificationsChannelId}`);
                return;
            }

            // Get the full thread to find the welcome message
            const historyResponse = await fetch(`https://slack.com/api/conversations.replies?channel=${channelId}&ts=${threadTs}&include_all_metadata=true`, {
                headers: {
                    'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
                }
            });

            const historyData = await historyResponse.json();
            if (!historyData.ok) {
                console.error('Failed to get thread history:', historyData.error);
                return;
            }

            // Try to get member data from multiple sources
            let memberData = {};

            // 1. First check if this is a SamCart order thread (for #notifications-capro welcome messages)
            const orderResult = await pool.query(`
                SELECT so.*, bo.first_name, bo.last_name, bo.business_name, bo.bio,
                       bo.annual_revenue, bo.team_count, bo.traffic_sources, bo.landing_pages,
                       bo.ai_skill_level, bo.massive_win, bo.pain_point
                FROM samcart_orders so
                LEFT JOIN business_owners bo ON LOWER(bo.email) = LOWER(so.email)
                WHERE so.slack_thread_ts = $1 AND so.slack_channel_id = $2
                LIMIT 1
            `, [threadTs, channelId]);

            if (orderResult.rows.length > 0) {
                const order = orderResult.rows[0];
                console.log(`[Slack Events] Found SamCart order for thread: ${order.email}`);

                // Also get Typeform data if available
                const typeformResult = await pool.query(
                    'SELECT * FROM typeform_applications WHERE LOWER(email) = LOWER($1) ORDER BY created_at DESC LIMIT 1',
                    [order.email]
                );
                const typeformData = typeformResult.rows[0] || {};

                // Also get onboarding data if available
                const onboardingResult = await pool.query(`
                    SELECT os.data FROM onboarding_submissions os
                    JOIN business_owners bo ON os.business_owner_id = bo.id
                    WHERE LOWER(bo.email) = LOWER($1)
                    ORDER BY os.created_at DESC LIMIT 1
                `, [order.email]);
                const onboardingData = onboardingResult.rows[0]?.data || {};

                // Build comprehensive member data from all sources
                memberData = {
                    firstName: order.first_name || typeformData.first_name || onboardingData.firstName || '',
                    lastName: order.last_name || typeformData.last_name || onboardingData.lastName || '',
                    email: order.email || '',
                    phone: typeformData.phone || onboardingData.phone || '',
                    businessName: order.business_name || onboardingData.businessName || '',
                    businessOverview: order.bio || onboardingData.bio || '',
                    massiveWin: order.massive_win || onboardingData.massiveWin || '',
                    teamCount: order.team_count || onboardingData.teamCount || '',
                    trafficSources: order.traffic_sources || onboardingData.trafficSources || '',
                    landingPages: order.landing_pages || onboardingData.landingPages || '',
                    aiSkillLevel: order.ai_skill_level || onboardingData.aiSkillLevel || '',
                    bio: order.bio || onboardingData.bio || '',
                    // Typeform-specific fields
                    typeformBusinessDescription: typeformData.business_description || '',
                    typeformAnnualRevenue: typeformData.annual_revenue || order.annual_revenue || '',
                    typeformRevenueTrend: typeformData.revenue_trend || '',
                    typeformMainChallenge: typeformData.main_challenge || '',
                    typeformWhyCaPro: typeformData.why_ca_pro || '',
                    typeformContactPreference: typeformData.contact_preference || '',
                    typeformInvestmentReadiness: typeformData.investment_readiness || '',
                    typeformDecisionTimeline: typeformData.decision_timeline || '',
                    typeformHasTeam: typeformData.has_team || '',
                    typeformAnythingElse: typeformData.anything_else || typeformData.additional_info || '',
                    typeformReferralSource: typeformData.referral_source || ''
                };
            } else {
                const threadRoot = historyData.messages?.[0] || null;
                const fallbackEmail = extractEmailFromSlackMessage(threadRoot) || extractEmailFromSlackMessage(message);

                if (!fallbackEmail) {
                    console.log('[Slack Events] No matching SamCart order and no email found for this thread');
                    await fetch('https://slack.com/api/chat.postMessage', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
                        },
                        body: JSON.stringify({
                            channel: channelId,
                            thread_ts: threadTs,
                            text: "I couldn't find a member email for this thread. Please make sure the thread includes the member's email."
                        })
                    });
                    return;
                }

                console.log(`[Slack Events] No SamCart order for thread; falling back to email ${fallbackEmail}`);

                const boResult = await pool.query(
                    `
                      SELECT first_name, last_name, business_name, bio, annual_revenue, team_count,
                             traffic_sources, landing_pages, ai_skill_level, massive_win, pain_point
                      FROM business_owners
                      WHERE LOWER(email) = LOWER($1)
                      LIMIT 1
                    `,
                    [fallbackEmail]
                );
                const bo = boResult.rows[0] || {};

                const typeformResult = await pool.query(
                    'SELECT * FROM typeform_applications WHERE LOWER(email) = LOWER($1) ORDER BY created_at DESC LIMIT 1',
                    [fallbackEmail]
                );
                const typeformData = typeformResult.rows[0] || {};

                const onboardingResult = await pool.query(`
                    SELECT os.data FROM onboarding_submissions os
                    JOIN business_owners bo ON os.business_owner_id = bo.id
                    WHERE LOWER(bo.email) = LOWER($1)
                    ORDER BY os.created_at DESC LIMIT 1
                `, [fallbackEmail]);
                const onboardingData = onboardingResult.rows[0]?.data || {};

                memberData = {
                    firstName: bo.first_name || typeformData.first_name || onboardingData.firstName || '',
                    lastName: bo.last_name || typeformData.last_name || onboardingData.lastName || '',
                    email: fallbackEmail,
                    phone: typeformData.phone || onboardingData.phone || '',
                    businessName: bo.business_name || onboardingData.businessName || '',
                    businessOverview: bo.bio || onboardingData.bio || '',
                    massiveWin: bo.massive_win || onboardingData.massiveWin || '',
                    teamCount: bo.team_count || onboardingData.teamCount || '',
                    trafficSources: bo.traffic_sources || onboardingData.trafficSources || '',
                    landingPages: bo.landing_pages || onboardingData.landingPages || '',
                    aiSkillLevel: bo.ai_skill_level || onboardingData.aiSkillLevel || '',
                    bio: bo.bio || onboardingData.bio || '',
                    // Typeform-specific fields
                    typeformBusinessDescription: typeformData.business_description || '',
                    typeformAnnualRevenue: typeformData.annual_revenue || bo.annual_revenue || '',
                    typeformRevenueTrend: typeformData.revenue_trend || '',
                    typeformMainChallenge: typeformData.main_challenge || '',
                    typeformWhyCaPro: typeformData.why_ca_pro || '',
                    typeformContactPreference: typeformData.contact_preference || '',
                    typeformInvestmentReadiness: typeformData.investment_readiness || '',
                    typeformDecisionTimeline: typeformData.decision_timeline || '',
                    typeformHasTeam: typeformData.has_team || '',
                    typeformAnythingElse: typeformData.anything_else || typeformData.additional_info || '',
                    typeformReferralSource: typeformData.referral_source || ''
                };
            }

            // Find the MOST RECENT welcome message from the bot (for iterative editing)
            // We need to get the last edited version, not the original
            let latestWelcome = null;

            // Iterate in reverse to find the last bot message with welcome content
            for (let i = historyData.messages.length - 1; i >= 0; i--) {
                const msg = historyData.messages[i];

                // Skip user messages (only look at bot messages)
                if (!msg.bot_id && msg.user !== 'USLACKBOT') continue;

                // Check if this is a welcome message (has section with text that looks like a welcome)
                const sectionBlock = msg.blocks?.find(b => b.type === 'section' && b.text?.text);
                if (sectionBlock) {
                    const text = sectionBlock.text.text;

                    // Skip non-welcome messages (system notes, notifications, etc.)
                    if (text.includes('⚠️') ||
                        text.includes('Note:') ||
                        text.includes('Email sent') ||
                        text.includes('Call booked') ||
                        text.includes('WhatsApp') ||
                        text.includes('replied') ||
                        text.length < 100) continue;

                    // This is likely a welcome message (long text with welcome content)
                    latestWelcome = text;
                    console.log(`[Slack Events] Found latest welcome message (message ${i + 1} of ${historyData.messages.length})`);
                    break;
                }
            }

            // If still not found, check the header for "Welcome Message" indicator
            if (!latestWelcome) {
                for (let i = historyData.messages.length - 1; i >= 0; i--) {
                    const msg = historyData.messages[i];
                    if (!msg.bot_id && msg.user !== 'USLACKBOT') continue;

                    const hasWelcomeHeader = msg.blocks?.find(b =>
                        b.type === 'header' &&
                        b.text?.text?.toLowerCase().includes('welcome')
                    );
                    if (hasWelcomeHeader) {
                        const sectionBlock = msg.blocks?.find(b => b.type === 'section' && b.text?.text);
                        if (sectionBlock) {
                            latestWelcome = sectionBlock.text.text;
                            console.log(`[Slack Events] Found welcome message by header (message ${i + 1})`);
                            break;
                        }
                    }
                }
            }

            if (!latestWelcome) {
                console.error('[Slack Events] Could not find any welcome message in thread');
                // Post a helpful message back
                await fetch('https://slack.com/api/chat.postMessage', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
                    },
                    body: JSON.stringify({
                        channel: channelId,
                        thread_ts: threadTs,
                        text: "I couldn't find a welcome message to edit in this thread. Make sure there's a generated welcome message above before requesting edits."
                    })
                });
                return;
            }

            console.log('[Slack Events] Editing welcome message with context:', Object.keys(memberData).filter(k => memberData[k]).length, 'fields');
            console.log('[Slack Events] Edit request:', editRequest);

            // Generate edited message with full member context
            let editedMessage;
            try {
                editedMessage = await editWelcomeMessage(latestWelcome, editRequest, memberData);
                console.log('[Slack Events] Claude returned edited message');
            } catch (claudeError) {
                console.error('[Slack Events] Claude API error:', claudeError.message);
                await fetch('https://slack.com/api/chat.postMessage', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
                    },
                    body: JSON.stringify({
                        channel: channelId,
                        thread_ts: threadTs,
                        text: `Sorry, I encountered an error generating the edit: ${claudeError.message}`
                    })
                });
                return;
            }

            // Strip leading/trailing quotes if Claude wrapped the message in them
            editedMessage = editedMessage.replace(/^["']|["']$/g, '').trim();

            // Create copy URL for the button
            const BASE_URL = process.env.BASE_URL || 'https://onboarding.copyaccelerator.com';
            const copyUrl = `${BASE_URL}/copy.html?text=${encodeURIComponent(editedMessage)}`;

            // Post the edited version in the thread
            await fetch('https://slack.com/api/chat.postMessage', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
                },
                body: JSON.stringify({
                    channel: channelId,
                    thread_ts: threadTs,
                    blocks: [
                        {
                            type: 'section',
                            text: {
                                type: 'mrkdwn',
                                text: editedMessage
                            }
                        },
                        {
                            type: 'divider'
                        },
                        {
                            type: 'actions',
                            elements: [
                                {
                                    type: 'button',
                                    text: {
                                        type: 'plain_text',
                                        text: '📋 Copy This Version',
                                        emoji: true
                                    },
                                    url: copyUrl,
                                    style: 'primary'
                                }
                            ]
                        },
                        {
                            type: 'context',
                            elements: [
                                {
                                    type: 'mrkdwn',
                                    text: '_Reply in this thread if you want more changes._'
                                }
                            ]
                        }
                    ],
                    text: editedMessage
                })
            });

            console.log('[Slack Events] Posted edited welcome message');
        }
    } catch (error) {
        console.error('Slack event error:', error);
    }
});

// API endpoint to trigger welcome message (called from admin or after onboarding)
router.post('/send-welcome', async (req, res) => {
    try {
        const { userId, memberData } = req.body;

        if (!memberData) {
            return res.status(400).json({ error: 'Missing memberData' });
        }

        // Use provided userId or fall back to default
        const targetUserId = userId || SLACK_WELCOME_USER_ID;

        // Generate welcome message
        const welcomeMessage = await generateWelcomeMessage(memberData);

        // Send DM to the specified user
        const result = await sendDMToUser(targetUserId, welcomeMessage, memberData);

        res.json({
            success: true,
            message: 'Welcome message sent',
            channel: result.channel,
            ts: result.ts
        });
    } catch (error) {
        console.error('Error sending welcome:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get list of users (for admin to select who to send to)
router.get('/users', async (req, res) => {
    try {
        const response = await fetch('https://slack.com/api/users.list', {
            headers: {
                'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
            }
        });

        const data = await response.json();
        if (!data.ok) {
            throw new Error(data.error);
        }

        // Filter out bots and deactivated users
        const users = data.members
            .filter(u => !u.is_bot && !u.deleted && u.id !== 'USLACKBOT')
            .map(u => ({
                id: u.id,
                name: u.real_name || u.name,
                username: u.name,
                avatar: u.profile.image_48
            }));

        res.json({ users });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
