/**
 * Slack Block Kit Templates
 * Templates for WhatsApp copy button, email display, reply notifications, and modals
 */

/**
 * WhatsApp template message with Copy button
 */
function createWhatsAppTemplateBlock(firstName, calendlyUrl = 'https://calendly.com/stefanpaulgeorgi/ca-pro-1-1-with-stefan') {
    const whatsappMessage = `Hey ${firstName}, hope you're doing well. I saw your application for CA Pro come in and shot you an email with a calendar link.

I know emails can go to spam sometimes as well though, so reaching out here as well.

When you're ready to chat more about the mastermind you can book a call with me here: ${calendlyUrl}`;

    return {
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: '*WhatsApp Template:*'
                }
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: '```' + whatsappMessage + '```'
                }
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
                        action_id: 'copy_whatsapp_template',
                        value: JSON.stringify({ message: whatsappMessage })
                    }
                ]
            }
        ],
        text: `WhatsApp Template for ${firstName}`
    };
}

/**
 * Email sent notification block
 */
function createEmailSentBlock(recipientEmail, subject, body) {
    return {
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*Email Sent to ${recipientEmail}*`
                }
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*Subject:* ${subject}`
                }
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: '```' + body + '```'
                }
            }
        ],
        text: `Email sent to ${recipientEmail}`
    };
}

/**
 * Email reply notification block with action buttons
 */
function createEmailReplyBlock(recipientName, recipientEmail, replySnippet, replyBody, threadId, applicationId, stefanSlackId) {
    const gmailUrl = `https://mail.google.com/mail/u/0/#inbox/${threadId}`;

    return {
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*Reply from ${recipientName}* <@${stefanSlackId}>`
                }
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: '```' + (replyBody || replySnippet) + '```'
                }
            },
            {
                type: 'actions',
                elements: [
                    {
                        type: 'button',
                        text: {
                            type: 'plain_text',
                            text: '📧 Open in Gmail',
                            emoji: true
                        },
                        url: gmailUrl,
                        action_id: 'open_gmail_thread'
                    },
                    {
                        type: 'button',
                        text: {
                            type: 'plain_text',
                            text: '✉️ Send Reply',
                            emoji: true
                        },
                        action_id: 'open_send_message_modal',
                        value: JSON.stringify({
                            threadId,
                            applicationId,
                            recipientEmail,
                            recipientName
                        }),
                        style: 'primary'
                    }
                ]
            }
        ],
        text: `Reply from ${recipientName}`
    };
}

/**
 * Call booked notification block
 */
function createCallBookedBlock(applicantName, applicantEmail, eventTime, stefanSlackId) {
    return {
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `📅 *Call Booked!* <@${stefanSlackId}>`
                }
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*${applicantName}* just booked a call!\n${applicantEmail}\n${eventTime ? `Scheduled: ${eventTime}` : ''}`
                }
            }
        ],
        text: `Call booked with ${applicantName}`
    };
}

/**
 * Send Message modal definition
 */
function createSendMessageModal(recipientName, recipientEmail, threadId, applicationId, previousText = '') {
    return {
        type: 'modal',
        callback_id: 'send_email_modal',
        private_metadata: JSON.stringify({
            threadId,
            applicationId,
            recipientEmail,
            recipientName
        }),
        title: {
            type: 'plain_text',
            text: 'Send Email Reply',
            emoji: true
        },
        submit: {
            type: 'plain_text',
            text: 'Send',
            emoji: true
        },
        close: {
            type: 'plain_text',
            text: 'Cancel',
            emoji: true
        },
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*To:* ${recipientName} <${recipientEmail}>`
                }
            },
            {
                type: 'input',
                block_id: 'message_block',
                element: {
                    type: 'plain_text_input',
                    action_id: 'message_input',
                    multiline: true,
                    placeholder: {
                        type: 'plain_text',
                        text: 'Type your reply...'
                    },
                    initial_value: previousText
                },
                label: {
                    type: 'plain_text',
                    text: 'Message',
                    emoji: true
                }
            }
        ]
    };
}

/**
 * Ephemeral "Sending..." message with Undo button
 */
function createSendingEphemeralBlock(recipientEmail, sendTime, pendingEmailId) {
    return {
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `⏳ *Sending email to ${recipientEmail} in 30 seconds...*`
                }
            },
            {
                type: 'actions',
                elements: [
                    {
                        type: 'button',
                        text: {
                            type: 'plain_text',
                            text: '↩️ Undo',
                            emoji: true
                        },
                        action_id: 'undo_pending_email',
                        value: pendingEmailId,
                        style: 'danger'
                    }
                ]
            }
        ],
        text: `Sending email to ${recipientEmail}...`
    };
}

/**
 * Note added to application block
 */
function createNoteAddedBlock(noteText, createdBy, createdAt) {
    const timestamp = new Date(createdAt).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });

    return {
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `📝 *Note added by ${createdBy}* (${timestamp})`
                }
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: noteText
                }
            }
        ],
        text: `Note: ${noteText.substring(0, 100)}`
    };
}

/**
 * Email sent confirmation (posted to thread after successful send)
 */
function createEmailSentConfirmationBlock(recipientEmail, body) {
    return {
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `✅ *Email sent to ${recipientEmail}*`
                }
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: '```' + body + '```'
                }
            }
        ],
        text: `Email sent to ${recipientEmail}`
    };
}

module.exports = {
    createWhatsAppTemplateBlock,
    createEmailSentBlock,
    createEmailReplyBlock,
    createCallBookedBlock,
    createSendMessageModal,
    createSendingEphemeralBlock,
    createNoteAddedBlock,
    createEmailSentConfirmationBlock
};
