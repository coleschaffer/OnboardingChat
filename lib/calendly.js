/**
 * Calendly API Client
 * Handles webhook subscription creation and signature verification
 */

const https = require('https');
const crypto = require('crypto');

const CALENDLY_TOKEN = process.env.STEF_CALENDLY_TOKEN;
const BASE_URL = process.env.BASE_URL || 'https://onboarding.copyaccelerator.com';

/**
 * Make a Calendly API request
 */
function calendlyRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.calendly.com',
            path: path,
            method: method,
            headers: {
                'Authorization': `Bearer ${CALENDLY_TOKEN}`,
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = data ? JSON.parse(data) : {};
                    if (res.statusCode >= 400) {
                        reject(new Error(`Calendly API error: ${res.statusCode} - ${JSON.stringify(parsed)}`));
                    } else {
                        resolve(parsed);
                    }
                } catch (e) {
                    if (res.statusCode >= 400) {
                        reject(new Error(`Calendly API error: ${res.statusCode} - ${data}`));
                    } else {
                        resolve(data);
                    }
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
 * Get current user info to retrieve organization URI
 */
async function getCurrentUser() {
    const response = await calendlyRequest('GET', '/users/me');
    return response.resource;
}

/**
 * List existing webhook subscriptions
 */
async function listWebhookSubscriptions(organizationUri) {
    const encodedOrg = encodeURIComponent(organizationUri);
    const response = await calendlyRequest('GET', `/webhook_subscriptions?organization=${encodedOrg}&scope=organization`);
    return response.collection || [];
}

/**
 * Create a webhook subscription
 *
 * @param {Object} pool - Database pool for storing subscription info
 * @returns {Object} - Subscription details including signing key
 */
async function createWebhookSubscription(pool) {
    // Get organization URI from current user
    const user = await getCurrentUser();
    const organizationUri = user.current_organization;

    // Check for existing subscription with our URL
    const existingSubscriptions = await listWebhookSubscriptions(organizationUri);
    const webhookUrl = `${BASE_URL}/api/webhooks/calendly`;

    const existing = existingSubscriptions.find(sub => sub.callback_url === webhookUrl);
    if (existing) {
        console.log('Found existing Calendly webhook subscription');
        // Store in database if not already there
        await pool.query(`
            INSERT INTO calendly_webhook_subscriptions (webhook_uri, signing_key, organization_uri, scope, state)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT DO NOTHING
        `, [existing.uri, existing.signing_key || '', organizationUri, existing.scope, existing.state]);

        return existing;
    }

    // Create new subscription
    const response = await calendlyRequest('POST', '/webhook_subscriptions', {
        url: webhookUrl,
        events: ['invitee.created'],
        organization: organizationUri,
        scope: 'organization'
    });

    const subscription = response.resource;

    // Store subscription in database
    await pool.query(`
        INSERT INTO calendly_webhook_subscriptions (webhook_uri, signing_key, organization_uri, scope, state)
        VALUES ($1, $2, $3, $4, $5)
    `, [subscription.uri, subscription.signing_key, organizationUri, subscription.scope, subscription.state]);

    console.log('Created new Calendly webhook subscription');

    return subscription;
}

/**
 * Delete a webhook subscription
 */
async function deleteWebhookSubscription(webhookUri) {
    // Extract the subscription ID from the URI
    const subscriptionId = webhookUri.split('/').pop();
    await calendlyRequest('DELETE', `/webhook_subscriptions/${subscriptionId}`);
}

/**
 * Verify Calendly webhook signature
 *
 * @param {string} payload - Raw request body as string
 * @param {string} signature - Calendly-Webhook-Signature header
 * @param {string} signingKey - The signing key from subscription
 * @returns {boolean} - True if signature is valid
 */
function verifyWebhookSignature(payload, signature, signingKey) {
    if (!signature || !signingKey) {
        return false;
    }

    // Parse the signature header: t=timestamp,v1=signature
    const elements = signature.split(',');
    const signatureMap = {};
    for (const element of elements) {
        const [key, value] = element.split('=');
        signatureMap[key] = value;
    }

    const timestamp = signatureMap['t'];
    const v1Signature = signatureMap['v1'];

    if (!timestamp || !v1Signature) {
        return false;
    }

    // Check if timestamp is within tolerance (5 minutes)
    const tolerance = 300; // 5 minutes in seconds
    const currentTime = Math.floor(Date.now() / 1000);
    if (Math.abs(currentTime - parseInt(timestamp)) > tolerance) {
        console.error('Calendly webhook timestamp too old');
        return false;
    }

    // Create the signature payload: timestamp.payload
    const signedPayload = `${timestamp}.${payload}`;

    // Compute the expected signature
    const expectedSignature = crypto
        .createHmac('sha256', signingKey)
        .update(signedPayload)
        .digest('hex');

    // Compare signatures
    return crypto.timingSafeEqual(
        Buffer.from(v1Signature),
        Buffer.from(expectedSignature)
    );
}

/**
 * Get stored signing key from database
 */
async function getSigningKey(pool) {
    const result = await pool.query(`
        SELECT signing_key FROM calendly_webhook_subscriptions
        WHERE state = 'active'
        ORDER BY created_at DESC
        LIMIT 1
    `);

    return result.rows[0]?.signing_key || null;
}

/**
 * Initialize Calendly webhook (call on server startup)
 */
async function initializeWebhook(pool) {
    if (!CALENDLY_TOKEN) {
        console.log('STEF_CALENDLY_TOKEN not set, skipping Calendly webhook setup');
        return null;
    }

    try {
        const subscription = await createWebhookSubscription(pool);
        console.log('Calendly webhook ready:', subscription.uri || 'existing');
        return subscription;
    } catch (error) {
        console.error('Failed to initialize Calendly webhook:', error.message);
        return null;
    }
}

module.exports = {
    calendlyRequest,
    getCurrentUser,
    listWebhookSubscriptions,
    createWebhookSubscription,
    deleteWebhookSubscription,
    verifyWebhookSignature,
    getSigningKey,
    initializeWebhook
};
