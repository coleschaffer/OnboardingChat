/**
 * Slack Thread Management
 * Functions to find Zapier messages, create threads, and post to threads
 */

const https = require('https');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const CA_PRO_CHANNEL_ID = process.env.CA_PRO_APPLICATION_SLACK_CHANNEL_ID;

/**
 * Make a Slack API request
 */
function slackRequest(method, endpoint, body = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'slack.com',
            path: `/api/${endpoint}`,
            method: method,
            headers: {
                'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
                'Content-Type': 'application/json; charset=utf-8'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed);
                } catch (e) {
                    reject(new Error(`Failed to parse Slack response: ${data}`));
                }
            });
        });

        req.on('error', reject);

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

/**
 * Post Typeform application notification to #ca-pro-applications
 * This replaces the Zapier integration - we post directly and store the message_ts
 *
 * @param {Object} pool - Database pool
 * @param {string} applicationId - Typeform application ID
 * @param {Object} application - Application data (all 15 fields)
 * @param {string} channelId - Channel to post to (defaults to CA_PRO_APPLICATION_SLACK_CHANNEL_ID)
 * @returns {Object} - { channelId, messageTs } or null if failed
 */
async function postApplicationNotification(pool, applicationId, application, channelId = CA_PRO_CHANNEL_ID) {
    const slackBlocks = require('../lib/slack-blocks');
    const stefanSlackId = process.env.STEF_SLACK_MEMBER_ID;

    if (!channelId) {
        console.error('[Slack] CA_PRO_APPLICATION_SLACK_CHANNEL_ID not set');
        return null;
    }

    console.log(`[Slack] Posting application notification for ${application.email}`);

    try {
        const appBlock = slackBlocks.createTypeformApplicationBlock(application, stefanSlackId);
        const response = await postMessage(channelId, appBlock.text, appBlock.blocks);

        if (!response.ok) {
            console.error('[Slack] Failed to post application notification:', response.error);
            return null;
        }

        const messageTs = response.ts;

        // Store the thread info in typeform_applications
        await pool.query(
            'UPDATE typeform_applications SET slack_channel_id = $1, slack_thread_ts = $2 WHERE id = $3',
            [channelId, messageTs, applicationId]
        );

        // Log activity
        await pool.query(
            'INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4)',
            ['slack_application_posted', 'typeform_application', applicationId, JSON.stringify({
                channel_id: channelId,
                message_ts: messageTs,
                email: application.email
            })]
        );

        console.log(`[Slack] Posted application notification with ts: ${messageTs}`);
        return { channelId, messageTs };
    } catch (error) {
        console.error('[Slack] Error posting application notification:', error);
        return null;
    }
}

/**
 * Find the Zapier message for a CA Pro application in the channel
 * @deprecated Use postApplicationNotification instead - we now post our own messages
 */
async function findZapierMessage(email, channelId = CA_PRO_CHANNEL_ID) {
    if (!channelId) {
        console.error('[Slack] CA_PRO_APPLICATION_SLACK_CHANNEL_ID not set');
        return null;
    }

    console.log(`[Slack] Searching for Zapier message for email: ${email} in channel: ${channelId}`);

    try {
        // Search last 2 hours of channel history (extended from 30 minutes)
        const twoHoursAgo = Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 1000);

        const response = await slackRequest('GET', `conversations.history?channel=${channelId}&oldest=${twoHoursAgo}&limit=100`);

        if (!response.ok) {
            console.error('[Slack] Failed to fetch channel history:', response.error);
            return null;
        }

        console.log(`[Slack] Found ${response.messages?.length || 0} messages in channel history`);

        // Messages are returned newest-first, so find() returns the most recent match
        const zapierMessage = response.messages?.find(msg => {
            const text = msg.text || '';
            const matches = text.includes('Product: CA Pro') && text.toLowerCase().includes(email.toLowerCase());
            if (matches) {
                console.log(`[Slack] Found matching Zapier message with ts: ${msg.ts}`);
            }
            return matches;
        });

        if (!zapierMessage) {
            console.log(`[Slack] No Zapier message found for ${email} - searched ${response.messages?.length || 0} messages`);
        }

        return zapierMessage || null;
    } catch (error) {
        console.error('[Slack] Error finding Zapier message:', error);
        return null;
    }
}

/**
 * Post a message to a channel or thread
 *
 * @param {string} channelId - Channel to post to
 * @param {string} text - Fallback text
 * @param {Array} blocks - Block Kit blocks
 * @param {string} threadTs - Optional thread timestamp to reply to
 * @returns {Object} - Slack response with ts (message timestamp)
 */
async function postMessage(channelId, text, blocks = null, threadTs = null) {
    const body = {
        channel: channelId,
        text: text,
        unfurl_links: false,
        unfurl_media: false
    };

    if (blocks) {
        body.blocks = blocks;
    }

    if (threadTs) {
        body.thread_ts = threadTs;
    }

    const response = await slackRequest('POST', 'chat.postMessage', body);

    if (!response.ok) {
        throw new Error(`Failed to post message: ${response.error}`);
    }

    return response;
}

/**
 * Post an ephemeral message (only visible to one user)
 */
async function postEphemeral(channelId, userId, text, blocks = null, threadTs = null) {
    const body = {
        channel: channelId,
        user: userId,
        text: text
    };

    if (blocks) {
        body.blocks = blocks;
    }

    if (threadTs) {
        body.thread_ts = threadTs;
    }

    const response = await slackRequest('POST', 'chat.postEphemeral', body);

    if (!response.ok) {
        throw new Error(`Failed to post ephemeral: ${response.error}`);
    }

    return response;
}

/**
 * Update an existing message
 */
async function updateMessage(channelId, ts, text, blocks = null) {
    const body = {
        channel: channelId,
        ts: ts,
        text: text
    };

    if (blocks) {
        body.blocks = blocks;
    }

    const response = await slackRequest('POST', 'chat.update', body);

    if (!response.ok) {
        throw new Error(`Failed to update message: ${response.error}`);
    }

    return response;
}

/**
 * Delete a message
 */
async function deleteMessage(channelId, ts) {
    const response = await slackRequest('POST', 'chat.delete', {
        channel: channelId,
        ts: ts
    });

    if (!response.ok) {
        throw new Error(`Failed to delete message: ${response.error}`);
    }

    return response;
}

/**
 * Open a modal view
 */
async function openModal(triggerId, view) {
    const response = await slackRequest('POST', 'views.open', {
        trigger_id: triggerId,
        view: view
    });

    if (!response.ok) {
        throw new Error(`Failed to open modal: ${response.error}`);
    }

    return response;
}

/**
 * Add WhatsApp template and email info to an existing application thread
 * The thread should already exist from postApplicationNotification
 *
 * @param {Object} pool - Database pool
 * @param {string} applicationId - Typeform application ID
 * @param {string} email - Applicant email
 * @param {string} firstName - Applicant first name
 * @param {string} emailSubject - Subject of sent email
 * @param {string} emailBody - Body of sent email
 * @returns {Object} - { channelId, threadTs } or null if failed
 */
async function createApplicationThread(pool, applicationId, email, firstName, emailSubject, emailBody) {
    const slackBlocks = require('../lib/slack-blocks');

    // Get the stored thread info from typeform_applications
    const result = await pool.query(
        'SELECT slack_channel_id, slack_thread_ts FROM typeform_applications WHERE id = $1',
        [applicationId]
    );

    if (!result.rows[0] || !result.rows[0].slack_thread_ts) {
        console.log(`[Slack] No thread found for application ${applicationId}`);
        return null;
    }

    const { slack_channel_id: channelId, slack_thread_ts: threadTs } = result.rows[0];

    console.log(`[Slack] Adding email info to thread ${threadTs} for ${email}`);

    // Post WhatsApp template as first thread reply
    const whatsappBlock = slackBlocks.createWhatsAppTemplateBlock(firstName);
    await postMessage(channelId, whatsappBlock.text, whatsappBlock.blocks, threadTs);

    // Post the sent email as second thread reply
    const emailBlock = slackBlocks.createEmailSentBlock(email, emailSubject, emailBody);
    await postMessage(channelId, emailBlock.text, emailBlock.blocks, threadTs);

    // Log activity
    await pool.query(
        'INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4)',
        ['slack_thread_updated', 'typeform_application', applicationId, JSON.stringify({
            channel_id: channelId,
            thread_ts: threadTs,
            email: email,
            added: 'whatsapp_template,email_sent'
        })]
    );

    return { channelId, threadTs };
}

/**
 * Post email reply notification to an existing thread
 */
async function postReplyNotification(pool, applicationId, recipientName, recipientEmail, replySnippet, replyBody, threadId) {
    const slackBlocks = require('../lib/slack-blocks');
    const stefanSlackId = process.env.STEF_SLACK_MEMBER_ID;

    // Get the application's slack thread info
    const result = await pool.query(
        'SELECT slack_channel_id, slack_thread_ts FROM typeform_applications WHERE id = $1',
        [applicationId]
    );

    if (!result.rows[0] || !result.rows[0].slack_thread_ts) {
        console.log(`No Slack thread found for application ${applicationId}`);
        return null;
    }

    const { slack_channel_id, slack_thread_ts } = result.rows[0];

    const replyBlock = slackBlocks.createEmailReplyBlock({
        recipientName,
        recipientEmail,
        replySnippet,
        replyBody,
        threadId,
        contextType: 'typeform_application',
        contextId: applicationId,
        stefanSlackId
    });

    const response = await postMessage(slack_channel_id, replyBlock.text, replyBlock.blocks, slack_thread_ts);

    return response;
}

/**
 * Post email reply notification to a specific Slack thread (non-Typeform context)
 */
async function postReplyNotificationToThread({
    channelId,
    threadTs,
    recipientName,
    recipientEmail,
    replySnippet,
    replyBody,
    threadId,
    contextType,
    contextId
}) {
    const slackBlocks = require('../lib/slack-blocks');
    const stefanSlackId = process.env.STEF_SLACK_MEMBER_ID;

    if (!channelId || !threadTs) return null;

    const replyBlock = slackBlocks.createEmailReplyBlock({
        recipientName,
        recipientEmail,
        replySnippet,
        replyBody,
        threadId,
        contextType,
        contextId,
        stefanSlackId
    });

    const response = await postMessage(channelId, replyBlock.text, replyBlock.blocks, threadTs);
    return response;
}

/**
 * Post call booked notification to an existing thread
 */
async function postCallBookedNotification(pool, applicationId, applicantName, applicantEmail, eventTime, meetingNotes = '') {
    const slackBlocks = require('../lib/slack-blocks');
    const stefanSlackId = process.env.STEF_SLACK_MEMBER_ID;

    // Get the application's slack thread info
    const result = await pool.query(
        'SELECT slack_channel_id, slack_thread_ts FROM typeform_applications WHERE id = $1',
        [applicationId]
    );

    if (!result.rows[0] || !result.rows[0].slack_thread_ts) {
        console.log(`No Slack thread found for application ${applicationId}`);
        return null;
    }

    const { slack_channel_id, slack_thread_ts } = result.rows[0];

    const callBookedBlock = slackBlocks.createCallBookedBlock(
        applicantName,
        applicantEmail,
        eventTime,
        stefanSlackId,
        meetingNotes
    );

    const response = await postMessage(slack_channel_id, callBookedBlock.text, callBookedBlock.blocks, slack_thread_ts);

    return response;
}

/**
 * Post onboarding update to an existing welcome thread
 * Called when user completes onboarding AFTER a delayed welcome was already sent
 *
 * @param {Object} pool - Database pool
 * @param {string} email - User's email to find the SamCart order
 * @param {Object} onboardingData - Onboarding chat data (answers, teamMembers, cLevelPartners)
 * @returns {boolean} - True if update was posted
 */
async function postOnboardingUpdateToWelcomeThread(pool, email, onboardingData) {
    const { generateWelcomeMessage } = require('./jobs');
    const BASE_URL = process.env.BASE_URL || 'https://onboarding.copyaccelerator.com';

    if (!email) return false;

    // Find SamCart order with welcome already sent
    const orderResult = await pool.query(`
        SELECT id, slack_channel_id, slack_thread_ts, welcome_sent,
               welcome_note_message_ts, welcome_message_ts, typeform_message_ts
        FROM samcart_orders
        WHERE LOWER(email) = LOWER($1)
          AND welcome_sent = true
          AND slack_thread_ts IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1
    `, [email]);

    if (orderResult.rows.length === 0) {
        console.log(`[Slack] No welcome thread found for ${email} - onboarding update not needed`);
        return false;
    }

    const order = orderResult.rows[0];
    const { slack_channel_id, slack_thread_ts, welcome_note_message_ts, welcome_message_ts, typeform_message_ts } = order;

    console.log(`[Slack] Updating welcome message in thread ${slack_thread_ts}`);

    // Look up Typeform data for combined welcome message
    let typeformData = null;
    const tfResult = await pool.query(
        'SELECT * FROM typeform_applications WHERE LOWER(email) = LOWER($1) ORDER BY created_at DESC LIMIT 1',
        [email]
    );
    typeformData = tfResult.rows[0] || null;

    try {
        const answers = onboardingData.answers || onboardingData;
        const businessName = answers.businessName || onboardingData.businessName;

        // Build combined memberData from Typeform + Onboarding
        const memberData = {
            firstName: typeformData?.first_name || answers.firstName || '',
            lastName: typeformData?.last_name || answers.lastName || '',
            email: typeformData?.email || email || '',
            phone: typeformData?.phone || answers.phone || '',
            businessName: businessName || '',
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

        // Generate NEW welcome message with full data
        const welcomeMessage = await generateWelcomeMessage(memberData);
        const copyUrl = `${BASE_URL}/copy.html?text=${encodeURIComponent(welcomeMessage)}`;

        // Delete the "Note: OnboardingChat not completed" message if we have its timestamp
        if (welcome_note_message_ts) {
            try {
                await deleteMessage(slack_channel_id, welcome_note_message_ts);
                console.log(`[Slack] Deleted note message ${welcome_note_message_ts}`);
            } catch (delError) {
                console.log(`[Slack] Could not delete note message: ${delError.message}`);
            }
        }

        // Update the existing welcome message with the new content
        if (welcome_message_ts) {
            try {
                await updateMessage(slack_channel_id, welcome_message_ts, `Welcome message for ${businessName}`, [
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
                            { type: 'mrkdwn', text: '_Updated with Typeform + OnboardingChat data. Reply in thread to request changes._' }
                        ]
                    }
                ]);
                console.log(`[Slack] Updated welcome message ${welcome_message_ts}`);
            } catch (updateError) {
                console.log(`[Slack] Could not update welcome message: ${updateError.message}`);
                // Fall back to posting a new message if update fails
                await postMessage(slack_channel_id, `Updated welcome for ${businessName}`, [
                    {
                        type: 'header',
                        text: { type: 'plain_text', text: '✨ Updated Welcome Message', emoji: true }
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
                            { type: 'mrkdwn', text: '_Updated with Typeform + OnboardingChat data._' }
                        ]
                    }
                ], slack_thread_ts);
            }
        } else {
            // No stored message timestamp - post new message (fallback for old orders)
            await postMessage(slack_channel_id, `Updated welcome for ${businessName}`, [
                {
                    type: 'header',
                    text: { type: 'plain_text', text: '✨ Updated Welcome Message', emoji: true }
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
                        { type: 'mrkdwn', text: '_Updated with Typeform + OnboardingChat data._' }
                    ]
                }
            ], slack_thread_ts);
        }

        // Update the Typeform Application message to include OnboardingChat data
        if (typeform_message_ts) {
            try {
                const fullName = [typeformData?.first_name || answers.firstName, typeformData?.last_name || answers.lastName].filter(Boolean).join(' ') || 'N/A';

                // Build combined fields from Typeform + OnboardingChat
                const combinedFields = [
                    `*--- Contact Info ---*`,
                    `*Name:* ${fullName}`,
                    `*Email:* ${typeformData?.email || email || 'N/A'}`,
                    `*Phone:* ${typeformData?.phone || answers.phone || 'N/A'}`,
                    `*Best Way to Reach:* ${typeformData?.contact_preference || 'N/A'}`,
                    ``,
                    `*--- Business Info ---*`,
                    `*Business Name:* ${businessName || 'N/A'}`,
                    `*Business Description:* ${typeformData?.business_description || 'N/A'}`,
                    `*Annual Revenue:* ${typeformData?.annual_revenue || 'N/A'}`,
                    `*Revenue Trend:* ${typeformData?.revenue_trend || 'N/A'}`,
                    ``,
                    `*--- Goals & Challenges ---*`,
                    `*#1 Challenge:* ${typeformData?.main_challenge || 'N/A'}`,
                    `*Why CA Pro:* ${typeformData?.why_ca_pro || 'N/A'}`,
                    ``,
                    `*--- Readiness ---*`,
                    `*Investment Ready:* ${typeformData?.investment_readiness || 'N/A'}`,
                    `*Timeline:* ${typeformData?.decision_timeline || 'N/A'}`,
                    `*Has Team:* ${typeformData?.has_team || 'N/A'}`,
                    ``,
                    `*--- Additional ---*`,
                    `*Anything Else:* ${typeformData?.anything_else || typeformData?.additional_info || 'N/A'}`,
                    `*Referral Source:* ${typeformData?.referral_source || 'N/A'}`,
                    ``,
                    `*--- OnboardingChat Data ---*`,
                    `*Business Name:* ${businessName || 'N/A'}`,
                    `*Bio/Overview:* ${answers.bio || 'N/A'}`,
                    `*Massive Win:* ${answers.massiveWin || 'N/A'}`,
                    `*Pain Point:* ${answers.painPoint || 'N/A'}`,
                    `*Team Count:* ${answers.teamCount || 'N/A'}`,
                    `*Traffic Sources:* ${answers.trafficSources || 'N/A'}`,
                    `*Landing Pages:* ${answers.landingPages || 'N/A'}`,
                    `*AI Skill Level:* ${answers.aiSkillLevel || 'N/A'}`
                ];

                await updateMessage(slack_channel_id, typeform_message_ts, `Application data for ${fullName}`, [
                    {
                        type: 'header',
                        text: { type: 'plain_text', text: `📝 Typeform + OnboardingChat Data`, emoji: true }
                    },
                    {
                        type: 'section',
                        text: { type: 'mrkdwn', text: combinedFields.join('\n') }
                    }
                ]);
                console.log(`[Slack] Updated Typeform message with OnboardingChat data ${typeform_message_ts}`);
            } catch (tfUpdateError) {
                console.log(`[Slack] Could not update Typeform message: ${tfUpdateError.message}`);
            }
        }

        // Log activity
        await pool.query(`
            INSERT INTO activity_log (action, entity_type, entity_id, details)
            VALUES ($1, $2, $3, $4)
        `, ['slack_welcome_updated', 'samcart_order', order.id, JSON.stringify({
            email: email,
            business_name: businessName,
            thread_ts: slack_thread_ts,
            welcome_updated: !!welcome_message_ts,
            typeform_updated: !!typeform_message_ts,
            note_deleted: !!welcome_note_message_ts
        })]);

        console.log(`[Slack] Welcome message updated for ${email}`);
        return true;
    } catch (error) {
        console.error(`[Slack] Error updating welcome message: ${error.message}`);
        return false;
    }
}

/**
 * Post a note to an application's Slack thread
 */
async function postNoteToThread(pool, applicationId, noteText, createdBy, createdAt) {
    const slackBlocks = require('../lib/slack-blocks');

    // Get the application's slack thread info
    const result = await pool.query(
        'SELECT slack_channel_id, slack_thread_ts FROM typeform_applications WHERE id = $1',
        [applicationId]
    );

    if (!result.rows[0] || !result.rows[0].slack_thread_ts) {
        console.log(`No Slack thread found for application ${applicationId}`);
        return null;
    }

    const { slack_channel_id, slack_thread_ts } = result.rows[0];

    const noteBlock = slackBlocks.createNoteAddedBlock(noteText, createdBy, createdAt);

    const response = await postMessage(slack_channel_id, noteBlock.text, noteBlock.blocks, slack_thread_ts);

    return response;
}

/**
 * Post a note to a member's Purchase/Welcome Slack thread (if it exists)
 *
 * This is intended to mirror application notes into the SamCart purchase thread
 * in #notifications-capro so the team has context in both places.
 */
async function postNoteToPurchaseThread(pool, email, noteText, createdBy, createdAt) {
    if (!email) return null;

    const slackBlocks = require('../lib/slack-blocks');

    // Find the most recent SamCart thread for this email
    const orderResult = await pool.query(`
        SELECT slack_channel_id, slack_thread_ts
        FROM samcart_orders
        WHERE LOWER(email) = LOWER($1)
          AND slack_channel_id IS NOT NULL
          AND slack_thread_ts IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1
    `, [email]);

    if (orderResult.rows.length === 0) {
        return null;
    }

    const { slack_channel_id, slack_thread_ts } = orderResult.rows[0];
    const noteBlock = slackBlocks.createNoteAddedBlock(noteText, createdBy, createdAt);

    const response = await postMessage(slack_channel_id, noteBlock.text, noteBlock.blocks, slack_thread_ts);
    return response;
}

module.exports = {
    findZapierMessage,
    postMessage,
    postEphemeral,
    updateMessage,
    deleteMessage,
    openModal,
    postApplicationNotification,
    createApplicationThread,
    postReplyNotification,
    postReplyNotificationToThread,
    postCallBookedNotification,
    postOnboardingUpdateToWelcomeThread,
    postNoteToThread,
    postNoteToPurchaseThread,
    slackRequest
};
