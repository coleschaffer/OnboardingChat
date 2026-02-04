/**
 * Slack Block Kit Templates
 * Templates for WhatsApp copy button, email display, reply notifications, and modals
 */

/**
 * WhatsApp template message with Copy button
 */
function createWhatsAppTemplateBlock(firstName, calendlyUrl = 'https://calendly.com/stefanpaulgeorgi/ca-pro-1-1-with-stefan', baseUrl = null) {
    const whatsappMessage = `Hey ${firstName}, hope you're doing well. I saw your application for CA Pro come in and shot you an email with a calendar link.

I know emails can go to spam sometimes as well though, so reaching out here as well.

When you're ready to chat more about the mastermind you can book a call with me here: ${calendlyUrl}`;

    // Use URL button that opens copy page (Slack buttons can't copy to clipboard directly)
    const copyUrl = `${baseUrl || process.env.BASE_URL || 'https://onboarding.copyaccelerator.com'}/copy.html?text=${encodeURIComponent(whatsappMessage)}`;

    return {
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: '*💬 WhatsApp Follow Up:*'
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
                        url: copyUrl,
                        action_id: 'copy_whatsapp_template'
                    }
                ]
            }
        ],
        text: `WhatsApp Follow Up for ${firstName}`
    };
}

/**
 * Email failed notification block
 */
function createEmailFailedBlock(recipientEmail, errorMessage) {
    return {
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*:x: Email Failed to ${recipientEmail}*`
                }
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `\`\`\`${errorMessage}\`\`\``
                }
            },
            {
                type: 'context',
                elements: [
                    {
                        type: 'mrkdwn',
                        text: '_Email will need to be sent manually_'
                    }
                ]
            }
        ],
        text: `Email failed to ${recipientEmail}: ${errorMessage}`
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
                    text: `*✉️ Email Sent to ${recipientEmail}*`
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
 * Strip quoted email content from reply body
 * Removes "On [date] [name] wrote:" and everything after
 */
function stripQuotedContent(text) {
    if (!text) return text;

    // Pattern 1: "On [date] at [time] [name] <email> wrote:" (Gmail style)
    const gmailPattern = /\r?\n\r?\nOn .+wrote:\r?\n?[\s\S]*/i;

    // Pattern 2: "On [date], [name] wrote:" (alternative Gmail style)
    const gmailPattern2 = /\r?\n\r?\nOn .+wrote:\r?\n?[\s\S]*/i;

    // Pattern 3: Lines starting with ">" (quoted text)
    const quotedLinePattern = /\r?\n\r?\n>[\s\S]*/;

    // Pattern 4: "From: [email]" header (forwarded/reply style)
    const fromPattern = /\r?\n\r?\nFrom: .+[\s\S]*/i;

    // Pattern 5: Dashed separator line
    const dashedPattern = /\r?\n\r?\n-{3,}[\s\S]*/;

    let result = text;
    result = result.replace(gmailPattern, '');
    result = result.replace(gmailPattern2, '');
    result = result.replace(quotedLinePattern, '');
    result = result.replace(fromPattern, '');
    result = result.replace(dashedPattern, '');

    return result.trim();
}

/**
 * Email reply notification block with action buttons
 */
function createEmailReplyBlock(recipientName, recipientEmail, replySnippet, replyBody, threadId, applicationId, stefanSlackId) {
    const gmailUrl = `https://mail.google.com/mail/u/0/#inbox/${threadId}`;

    // Strip quoted content from the reply
    const cleanReply = stripQuotedContent(replyBody) || stripQuotedContent(replySnippet) || replySnippet;

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
                    text: '```' + cleanReply + '```'
                }
            },
            {
                type: 'actions',
                elements: [
                    {
                        type: 'button',
                        text: {
                            type: 'plain_text',
                            text: '📧 Open Gmail',
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
                    text: `⏳ *Email to ${recipientEmail} sending in 10 seconds...*`
                }
            },
            {
                type: 'actions',
                elements: [
                    {
                        type: 'button',
                        text: {
                            type: 'plain_text',
                            text: '✖️ Cancel',
                            emoji: true
                        },
                        action_id: 'cancel_pending_email',
                        value: pendingEmailId,
                        style: 'danger'
                    }
                ]
            }
        ],
        text: `Email to ${recipientEmail} queued...`
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

/**
 * Typeform application notification block (replaces Zapier message)
 * Posts all 15 questions to #ca-pro-applications
 */
function createTypeformApplicationBlock(application, stefanSlackId) {
    const fullName = [application.first_name, application.last_name].filter(Boolean).join(' ') || 'Unknown';

    const fields = [
        `*--- Contact Info ---*`,
        `*Name:* ${fullName}`,
        `*Email:* ${application.email || 'N/A'}`,
        `*Phone:* ${application.phone || 'N/A'}`,
        `*Best Way to Reach:* ${application.contact_preference || 'N/A'}`,
        ``,
        `*--- Business Info ---*`,
        `*Business:* ${application.business_description || 'N/A'}`,
        `*Annual Revenue:* ${application.annual_revenue || 'N/A'}`,
        `*Revenue Trend:* ${application.revenue_trend || 'N/A'}`,
        ``,
        `*--- Goals & Challenges ---*`,
        `*#1 Challenge:* ${application.main_challenge || 'N/A'}`,
        `*Why CA Pro:* ${application.why_ca_pro || 'N/A'}`,
        ``,
        `*--- Readiness ---*`,
        `*Investment Ready:* ${application.investment_readiness || 'N/A'}`,
        `*Timeline:* ${application.decision_timeline || 'N/A'}`,
        `*Has Team:* ${application.has_team || 'N/A'}`,
        ``,
        `*--- Additional ---*`,
        `*Anything Else:* ${application.anything_else || 'N/A'}`,
        `*Referral Source:* ${application.referral_source || 'N/A'}`
    ];

    return {
        blocks: [
            {
                type: 'header',
                text: {
                    type: 'plain_text',
                    text: `New CA Pro Application: ${fullName}`,
                    emoji: true
                }
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: fields.join('\n')
                }
            },
            {
                type: 'context',
                elements: [
                    {
                        type: 'mrkdwn',
                        text: `${stefanSlackId ? `<@${stefanSlackId}> ` : ''}_View thread for WhatsApp template, emails, and call bookings_`
                    }
                ]
            }
        ],
        text: `New CA Pro Application: ${fullName} (${application.email})`
    };
}

/**
 * Onboarding data update block (posted to welcome thread when onboarding completes late)
 */
function createOnboardingUpdateBlock(onboardingData, businessName) {
    const fields = [
        `*Business Name:* ${businessName || 'N/A'}`,
        `*Team Size:* ${onboardingData.teamCount || 'N/A'}`,
        `*Traffic Sources:* ${onboardingData.trafficSources || 'N/A'}`,
        `*Landing Pages:* ${onboardingData.landingPages || 'N/A'}`,
        `*Massive Win Goal:* ${onboardingData.massiveWin || 'N/A'}`,
        `*AI Skill Level:* ${onboardingData.aiSkillLevel || 'N/A'}/10`,
        `*Bio:* ${onboardingData.bio || 'N/A'}`
    ];

    if (onboardingData.teamMembers && onboardingData.teamMembers.length > 0) {
        const teamList = onboardingData.teamMembers.map(tm => `  • ${tm.name || tm.firstName} (${tm.email})`).join('\n');
        fields.push(`*Team Members:*\n${teamList}`);
    }

    if (onboardingData.cLevelPartners && onboardingData.cLevelPartners.length > 0) {
        const partnerList = onboardingData.cLevelPartners.map(p => `  • ${p.name || p.firstName} (${p.email})`).join('\n');
        fields.push(`*C-Level Partners:*\n${partnerList}`);
    }

    return {
        blocks: [
            {
                type: 'header',
                text: {
                    type: 'plain_text',
                    text: '📋 Onboarding Chat Completed (Update)',
                    emoji: true
                }
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `_Member completed onboarding after initial welcome was sent. Here's the additional data:_`
                }
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: fields.join('\n\n')
                }
            }
        ],
        text: `Onboarding update for ${businessName}`
    };
}

module.exports = {
    createWhatsAppTemplateBlock,
    createEmailFailedBlock,
    createEmailSentBlock,
    createEmailReplyBlock,
    createCallBookedBlock,
    createSendMessageModal,
    createSendingEphemeralBlock,
    createNoteAddedBlock,
    createEmailSentConfirmationBlock,
    createTypeformApplicationBlock,
    createOnboardingUpdateBlock
};
