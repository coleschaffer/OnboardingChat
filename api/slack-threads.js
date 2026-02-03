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
 * Find the Zapier message for a CA Pro application in the channel
 * Searches messages from the last 30 minutes that contain "Product: CA Pro" and the applicant's email
 *
 * @param {string} email - Applicant's email to search for
 * @param {string} channelId - Channel to search in (defaults to CA_PRO_APPLICATION_SLACK_CHANNEL_ID)
 * @returns {Object|null} - Slack message object or null if not found
 */
async function findZapierMessage(email, channelId = CA_PRO_CHANNEL_ID) {
    if (!channelId) {
        console.error('CA_PRO_APPLICATION_SLACK_CHANNEL_ID not set');
        return null;
    }

    try {
        // Search last 30 minutes of channel history
        const thirtyMinutesAgo = Math.floor((Date.now() - 30 * 60 * 1000) / 1000);

        const response = await slackRequest('GET', `conversations.history?channel=${channelId}&oldest=${thirtyMinutesAgo}&limit=50`);

        if (!response.ok) {
            console.error('Failed to fetch channel history:', response.error);
            return null;
        }

        // Look for message containing "Product: CA Pro" and the applicant's email
        const zapierMessage = response.messages?.find(msg => {
            const text = msg.text || '';
            return text.includes('Product: CA Pro') && text.toLowerCase().includes(email.toLowerCase());
        });

        return zapierMessage || null;
    } catch (error) {
        console.error('Error finding Zapier message:', error);
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
 * Create a thread on a Zapier message with WhatsApp template and email info
 *
 * @param {Object} pool - Database pool
 * @param {string} applicationId - Typeform application ID
 * @param {string} email - Applicant email
 * @param {string} firstName - Applicant first name
 * @param {string} emailSubject - Subject of sent email
 * @param {string} emailBody - Body of sent email
 * @param {string} channelId - Channel ID (defaults to CA_PRO_APPLICATION_SLACK_CHANNEL_ID)
 * @returns {Object} - { channelId, threadTs } or null if failed
 */
async function createApplicationThread(pool, applicationId, email, firstName, emailSubject, emailBody, channelId = CA_PRO_CHANNEL_ID) {
    const slackBlocks = require('../lib/slack-blocks');

    // Find the Zapier message
    const zapierMessage = await findZapierMessage(email, channelId);

    if (!zapierMessage) {
        console.log(`No Zapier message found for ${email}`);
        return null;
    }

    const threadTs = zapierMessage.ts;

    // Post WhatsApp template as first thread reply
    const whatsappBlock = slackBlocks.createWhatsAppTemplateBlock(firstName);
    await postMessage(channelId, whatsappBlock.text, whatsappBlock.blocks, threadTs);

    // Post the sent email as second thread reply
    const emailBlock = slackBlocks.createEmailSentBlock(email, emailSubject, emailBody);
    await postMessage(channelId, emailBlock.text, emailBlock.blocks, threadTs);

    // Update the application with slack thread info
    await pool.query(
        'UPDATE typeform_applications SET slack_channel_id = $1, slack_thread_ts = $2 WHERE id = $3',
        [channelId, threadTs, applicationId]
    );

    // Log activity
    await pool.query(
        'INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4)',
        ['slack_thread_created', 'typeform_application', applicationId, JSON.stringify({
            channel_id: channelId,
            thread_ts: threadTs,
            email: email
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
    createApplicationThread,
    postReplyNotification,
    postCallBookedNotification,
    postNoteToThread,
    slackRequest
};
