/**
 * Gmail API Service
 * Handles OAuth2 token management, sending emails, and checking for replies
 */

const https = require('https');

class GmailService {
    constructor() {
        this.clientId = process.env.STEF_GOOGLE_CLIENT_ID;
        this.clientSecret = process.env.STEF_GOOGLE_CLIENT_SECRET;
        this.refreshToken = process.env.STEF_GOOGLE_REFRESH_TOKEN;
        this.accessToken = null;
        this.tokenExpiry = null;
    }

    /**
     * Get a valid access token, refreshing if necessary
     */
    async getAccessToken() {
        // Check if we have a valid token
        if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
            return this.accessToken;
        }

        // Refresh the token
        const params = new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            refresh_token: this.refreshToken,
            grant_type: 'refresh_token'
        });

        const response = await this.makeRequest('POST', 'oauth2.googleapis.com', '/token', params.toString(), {
            'Content-Type': 'application/x-www-form-urlencoded'
        });

        this.accessToken = response.access_token;
        // Set expiry 5 minutes before actual expiry for safety
        this.tokenExpiry = Date.now() + ((response.expires_in - 300) * 1000);

        return this.accessToken;
    }

    /**
     * Make an HTTPS request
     */
    makeRequest(method, host, path, body = null, headers = {}) {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: host,
                path: path,
                method: method,
                headers: {
                    ...headers
                }
            };

            if (body) {
                options.headers['Content-Length'] = Buffer.byteLength(body);
            }

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (res.statusCode >= 400) {
                            reject(new Error(`Gmail API error: ${res.statusCode} - ${JSON.stringify(parsed)}`));
                        } else {
                            resolve(parsed);
                        }
                    } catch (e) {
                        if (res.statusCode >= 400) {
                            reject(new Error(`Gmail API error: ${res.statusCode} - ${data}`));
                        } else {
                            resolve(data);
                        }
                    }
                });
            });

            req.on('error', reject);

            if (body) {
                req.write(body);
            }
            req.end();
        });
    }

    /**
     * Make an authenticated Gmail API request
     */
    async gmailRequest(method, endpoint, body = null) {
        const accessToken = await this.getAccessToken();
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        };

        return this.makeRequest(
            method,
            'gmail.googleapis.com',
            `/gmail/v1/users/me${endpoint}`,
            body ? JSON.stringify(body) : null,
            headers
        );
    }

    /**
     * Convert plain text to simple HTML (preserves line breaks, no wrapping)
     */
    textToHtml(text) {
        // Escape HTML entities
        let html = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

        // Convert URLs to clickable links
        html = html.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1">$1</a>');

        // Convert line breaks to <br>
        html = html.replace(/\n/g, '<br>\n');

        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
body { font-family: Arial, sans-serif; font-size: 14px; line-height: 1.5; color: #333; }
a { color: #1a73e8; }
</style>
</head>
<body>
${html}
</body>
</html>`;
    }

    /**
     * Create a raw email message in RFC 2822 format
     * Uses HTML to prevent Gmail from wrapping lines
     */
    createRawEmail(to, subject, body, replyToMessageId = null, replyToThreadId = null) {
        const fromEmail = 'stefanpaulgeorgi@gmail.com';
        const fromName = 'Stefan Georgi';

        // Convert plain text body to HTML to prevent line wrapping
        const htmlBody = this.textToHtml(body);

        let headers = [
            `From: ${fromName} <${fromEmail}>`,
            `To: ${to}`,
            `Subject: ${subject}`,
            'MIME-Version: 1.0',
            'Content-Type: text/html; charset=UTF-8'
        ];

        // Add reply headers if this is a reply
        if (replyToMessageId) {
            headers.push(`In-Reply-To: ${replyToMessageId}`);
            headers.push(`References: ${replyToMessageId}`);
        }

        const email = headers.join('\r\n') + '\r\n\r\n' + htmlBody;

        // Base64 URL encode the email
        return Buffer.from(email)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    }

    /**
     * Send an email
     * @param {string} to - Recipient email
     * @param {string} subject - Email subject
     * @param {string} body - Email body (plain text)
     * @param {string} threadId - Optional thread ID to reply to
     * @param {string} messageId - Optional message ID to reply to (for In-Reply-To header)
     * @returns {Object} - { messageId, threadId }
     */
    async sendEmail(to, subject, body, threadId = null, messageId = null) {
        const raw = this.createRawEmail(to, subject, body, messageId, threadId);

        const requestBody = { raw };
        if (threadId) {
            requestBody.threadId = threadId;
        }

        const response = await this.gmailRequest('POST', '/messages/send', requestBody);

        return {
            messageId: response.id,
            threadId: response.threadId
        };
    }

    /**
     * Get a specific thread with all messages
     * @param {string} threadId - The Gmail thread ID
     * @returns {Object} - Thread with messages
     */
    async getThread(threadId) {
        return this.gmailRequest('GET', `/threads/${threadId}?format=full`);
    }

    /**
     * Get a specific message
     * @param {string} messageId - The Gmail message ID
     * @returns {Object} - Message details
     */
    async getMessage(messageId) {
        return this.gmailRequest('GET', `/messages/${messageId}?format=full`);
    }

    /**
     * Check if a thread has new replies since our initial email
     * @param {string} threadId - The Gmail thread ID
     * @param {string} ourMessageId - Our original message ID
     * @returns {Object} - { hasReply, replyCount, latestReply }
     */
    async checkForReplies(threadId, ourMessageId) {
        try {
            const thread = await this.getThread(threadId);

            if (!thread.messages || thread.messages.length <= 1) {
                return { hasReply: false, replyCount: 0, latestReply: null };
            }

            // Find messages that are not from us (replies from the recipient)
            const replies = thread.messages.filter(msg => {
                // Check the From header
                const fromHeader = msg.payload.headers.find(h => h.name.toLowerCase() === 'from');
                if (!fromHeader) return false;

                // If it's from stefanpaulgeorgi@gmail.com, it's our message
                const isFromUs = fromHeader.value.toLowerCase().includes('stefanpaulgeorgi@gmail.com');
                return !isFromUs;
            });

            if (replies.length === 0) {
                return { hasReply: false, replyCount: 0, latestReply: null };
            }

            // Get the latest reply
            const latestReply = replies[replies.length - 1];
            const replyBody = this.extractMessageBody(latestReply);
            const replySnippet = latestReply.snippet;
            const replyDate = new Date(parseInt(latestReply.internalDate));

            return {
                hasReply: true,
                replyCount: replies.length,
                latestReply: {
                    messageId: latestReply.id,
                    snippet: replySnippet,
                    body: replyBody,
                    date: replyDate
                }
            };
        } catch (error) {
            console.error('Error checking for replies:', error);
            throw error;
        }
    }

    /**
     * Extract the text body from a message
     */
    extractMessageBody(message) {
        const payload = message.payload;

        // Try to find plain text part
        if (payload.mimeType === 'text/plain' && payload.body.data) {
            return this.decodeBase64(payload.body.data);
        }

        // If multipart, look for text/plain part
        if (payload.parts) {
            for (const part of payload.parts) {
                if (part.mimeType === 'text/plain' && part.body.data) {
                    return this.decodeBase64(part.body.data);
                }
                // Check nested parts
                if (part.parts) {
                    for (const subpart of part.parts) {
                        if (subpart.mimeType === 'text/plain' && subpart.body.data) {
                            return this.decodeBase64(subpart.body.data);
                        }
                    }
                }
            }
            // Fall back to HTML if no plain text
            for (const part of payload.parts) {
                if (part.mimeType === 'text/html' && part.body.data) {
                    return this.stripHtml(this.decodeBase64(part.body.data));
                }
            }
        }

        // Last resort: use snippet
        return message.snippet || '';
    }

    /**
     * Decode base64 URL encoded string
     */
    decodeBase64(data) {
        const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
        return Buffer.from(base64, 'base64').toString('utf8');
    }

    /**
     * Strip HTML tags from text
     */
    stripHtml(html) {
        return html
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .trim();
    }

    /**
     * Get link to open thread in Gmail
     */
    getGmailThreadUrl(threadId) {
        return `https://mail.google.com/mail/u/0/#inbox/${threadId}`;
    }
}

// Export singleton instance
const gmailService = new GmailService();

module.exports = {
    gmailService,
    GmailService
};
