const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const slackBlocks = require('../lib/slack-blocks');
const { openModal, postMessage, deleteMessage } = require('./slack-threads');
const { gmailService } = require('../lib/gmail');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_WELCOME_USER_ID = process.env.SLACK_WELCOME_USER_ID || 'U0ABG2G4Q2G';

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
                const modal = slackBlocks.createSendMessageModal(
                    actionData.recipientName,
                    actionData.recipientEmail,
                    actionData.threadId,
                    actionData.applicationId
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

            // Insert pending email with 10-second delay
            const UNDO_DELAY_MS = 10000; // 10 seconds
            const sendAt = new Date(Date.now() + UNDO_DELAY_MS);

            const result = await pool.query(`
                INSERT INTO pending_email_sends (
                    to_email, subject, body, gmail_thread_id, typeform_application_id,
                    user_id, channel_id, thread_ts, send_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING id
            `, [
                privateMetadata.recipientEmail,
                'Re: Thanks for applying to CA Pro',
                messageText,
                privateMetadata.threadId,
                privateMetadata.applicationId,
                userId,
                '', // We'll update with channel from application
                null, // thread_ts
                sendAt
            ]);

            const pendingEmailId = result.rows[0].id;

            // Get the application's slack thread info
            const appResult = await pool.query(
                'SELECT slack_channel_id, slack_thread_ts FROM typeform_applications WHERE id = $1',
                [privateMetadata.applicationId]
            );

            let sendingMessageTs = null;
            let channelId = null;
            let threadTs = null;

            if (appResult.rows[0]?.slack_channel_id) {
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
                    `, ['email_reply_sent', 'typeform_application', pending.typeform_application_id, JSON.stringify({
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
                // 2. Fallback: Try to get member data from message metadata (original welcome message flow)
                for (const msg of historyData.messages) {
                    const hasWelcomeMetadata = msg.metadata?.event_type === 'welcome_message';
                    if (hasWelcomeMetadata && msg.metadata?.event_payload) {
                        memberData = msg.metadata.event_payload;
                        console.log('[Slack Events] Found member data from message metadata');
                        break;
                    }
                }
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
