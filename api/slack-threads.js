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
        text: text
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

    const replyBlock = slackBlocks.createEmailReplyBlock(
        recipientName,
        recipientEmail,
        replySnippet,
        replyBody,
        threadId,
        applicationId,
        stefanSlackId
    );

    const response = await postMessage(slack_channel_id, replyBlock.text, replyBlock.blocks, slack_thread_ts);

    return response;
}

/**
 * Post call booked notification to an existing thread
 */
async function postCallBookedNotification(pool, applicationId, applicantName, applicantEmail, eventTime) {
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
        stefanSlackId
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
    const slackBlocks = require('../lib/slack-blocks');

    if (!email) return false;

    // Find SamCart order with welcome already sent
    const orderResult = await pool.query(`
        SELECT id, slack_channel_id, slack_thread_ts, welcome_sent
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
    const { slack_channel_id, slack_thread_ts } = order;

    console.log(`[Slack] Posting onboarding update to welcome thread ${slack_thread_ts}`);

    try {
        const businessName = onboardingData.answers?.businessName || onboardingData.businessName;
        const updateBlock = slackBlocks.createOnboardingUpdateBlock(onboardingData.answers || onboardingData, businessName);

        await postMessage(slack_channel_id, updateBlock.text, updateBlock.blocks, slack_thread_ts);

        // Log activity
        await pool.query(`
            INSERT INTO activity_log (action, entity_type, entity_id, details)
            VALUES ($1, $2, $3, $4)
        `, ['slack_onboarding_update_posted', 'samcart_order', order.id, JSON.stringify({
            email: email,
            business_name: businessName,
            thread_ts: slack_thread_ts
        })]);

        console.log(`[Slack] Onboarding update posted to welcome thread for ${email}`);
        return true;
    } catch (error) {
        console.error(`[Slack] Error posting onboarding update: ${error.message}`);
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
    postCallBookedNotification,
    postOnboardingUpdateToWelcomeThread,
    postNoteToThread,
    slackRequest
};
