const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

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

// Edit welcome message using Claude
async function editWelcomeMessage(originalMessage, editRequest) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY not set');
    }

    const prompt = `Here is a welcome message for a new CA Pro member:

"${originalMessage}"

The user wants to make this change: "${editRequest}"

Please provide the updated welcome message with that change applied. Write ONLY the updated message, no additional commentary.`;

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

        // Handle URL verification
        if (payload.type === 'url_verification') {
            return res.json({ challenge: payload.challenge });
        }

        // Acknowledge immediately
        res.status(200).send();

        // Handle message events in threads
        if (payload.event?.type === 'message' &&
            payload.event.thread_ts &&
            !payload.event.bot_id) {

            const event = payload.event;
            const editRequest = event.text;
            const threadTs = event.thread_ts;
            const channelId = event.channel;

            // Get the parent message to find the original welcome message
            const historyResponse = await fetch(`https://slack.com/api/conversations.replies?channel=${channelId}&ts=${threadTs}`, {
                headers: {
                    'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
                }
            });

            const historyData = await historyResponse.json();
            if (!historyData.ok) {
                console.error('Failed to get thread history:', historyData.error);
                return;
            }

            // Find the original welcome message (first message in thread with welcome text)
            const parentMessage = historyData.messages[0];
            const originalWelcome = parentMessage?.blocks
                ?.find(b => b.type === 'section')?.text?.text;

            if (!originalWelcome) {
                console.error('Could not find original welcome message');
                return;
            }

            // Generate edited message
            const editedMessage = await editWelcomeMessage(originalWelcome, editRequest);

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
                                text: '*Here\'s the updated message:*'
                            }
                        },
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
                                    action_id: 'copy_message',
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
        }
    } catch (error) {
        console.error('Slack event error:', error);
    }
});

// API endpoint to trigger welcome message (called from admin or after onboarding)
router.post('/send-welcome', async (req, res) => {
    try {
        const { userId, memberData } = req.body;

        if (!userId || !memberData) {
            return res.status(400).json({ error: 'Missing userId or memberData' });
        }

        // Generate welcome message
        const welcomeMessage = await generateWelcomeMessage(memberData);

        // Send DM to the specified user
        const result = await sendDMToUser(userId, welcomeMessage, memberData);

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
