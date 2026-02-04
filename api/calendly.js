/**
 * Calendly Webhook Handler
 * Receives invitee.created events and updates application status
 */

const express = require('express');
const router = express.Router();
const { verifyWebhookSignature, getSigningKey } = require('../lib/calendly');
const { postCallBookedNotification } = require('./slack-threads');

/**
 * POST /api/webhooks/calendly
 * Handle Calendly webhook events
 */
router.post('/', async (req, res) => {
    const pool = req.app.locals.pool;

    try {
        // Get the raw body for signature verification
        const rawBody = req.rawBody || JSON.stringify(req.body);
        const signature = req.headers['calendly-webhook-signature'];

        // Get signing key from database
        const signingKey = await getSigningKey(pool);

        // Verify signature if we have a signing key
        if (signingKey && signature) {
            const isValid = verifyWebhookSignature(rawBody, signature, signingKey);
            if (!isValid) {
                console.error('Invalid Calendly webhook signature');
                return res.status(401).json({ error: 'Invalid signature' });
            }
        } else {
            console.log('Calendly webhook signature verification skipped (no signing key or signature)');
        }

        const event = req.body.event;
        const payload = req.body.payload;

        console.log('Calendly webhook received:', event);

        if (event !== 'invitee.created') {
            // We only care about new bookings
            return res.json({ received: true, event });
        }

        // Extract invitee info
        const invitee = payload.invitee;
        const email = invitee.email?.toLowerCase();
        const name = invitee.name;

        if (!email) {
            console.log('No email in Calendly invitee');
            return res.json({ received: true, warning: 'no email' });
        }

        // Extract scheduled event info
        const scheduledEvent = payload.scheduled_event;
        const eventStartTime = scheduledEvent?.start_time;
        const eventName = scheduledEvent?.name;

        // Format event time for display
        let eventTimeDisplay = '';
        if (eventStartTime) {
            const eventDate = new Date(eventStartTime);
            eventTimeDisplay = eventDate.toLocaleString('en-US', {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                timeZoneName: 'short'
            });
        }

        // Check if this person is already a paying member (has SamCart order)
        // If so, this is a member 1:1 call, not a qualification call - skip notification
        const samcartResult = await pool.query(
            'SELECT id FROM samcart_orders WHERE LOWER(email) = $1 LIMIT 1',
            [email]
        );

        if (samcartResult.rows.length > 0) {
            console.log(`[Calendly] ${email} is already a member (has SamCart order) - skipping notification`);
            return res.json({
                received: true,
                skipped: true,
                reason: 'existing_member',
                email
            });
        }

        // Find matching typeform application - try email first, then fall back to name
        let appResult = await pool.query(
            'SELECT id, first_name, last_name, email, call_booked_at FROM typeform_applications WHERE LOWER(email) = $1',
            [email]
        );

        // Fallback: try matching by name if email doesn't match
        // Only check recent applications (last 30 days) to reduce false positives
        if (appResult.rows.length === 0 && name) {
            console.log(`No email match for ${email}, trying name match: ${name}`);

            // Split the invitee name into parts
            const nameParts = name.trim().split(/\s+/);
            const firstName = nameParts[0];
            const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

            if (firstName && lastName) {
                appResult = await pool.query(`
                    SELECT id, first_name, last_name, email, call_booked_at
                    FROM typeform_applications
                    WHERE LOWER(first_name) = LOWER($1)
                      AND LOWER(last_name) = LOWER($2)
                      AND created_at > NOW() - INTERVAL '30 days'
                    ORDER BY created_at DESC
                    LIMIT 1
                `, [firstName, lastName]);

                if (appResult.rows.length > 0) {
                    console.log(`Found application by name match: ${name} -> ${appResult.rows[0].email}`);
                }
            }
        }

        if (appResult.rows.length === 0) {
            console.log(`No matching typeform application for email: ${email} or name: ${name}`);
            // Still return success - the booking is valid, just no matching application
            return res.json({ received: true, warning: 'no matching application', email, name });
        }

        const application = appResult.rows[0];
        const applicantName = `${application.first_name || ''} ${application.last_name || ''}`.trim() || name;

        // Also check if the application's email has a SamCart order
        // (handles case where Calendly email differs from purchase email)
        if (application.email && application.email.toLowerCase() !== email) {
            const appEmailSamcart = await pool.query(
                'SELECT id FROM samcart_orders WHERE LOWER(email) = $1 LIMIT 1',
                [application.email.toLowerCase()]
            );
            if (appEmailSamcart.rows.length > 0) {
                console.log(`[Calendly] ${application.email} (from app) is already a member - skipping notification`);
                return res.json({
                    received: true,
                    skipped: true,
                    reason: 'existing_member',
                    email,
                    application_email: application.email
                });
            }
        }

        // Check if we've already posted a call booked notification for this application
        // This prevents duplicate notifications if they book multiple calls
        if (application.call_booked_at) {
            console.log(`[Calendly] ${email} already has call_booked_at set - skipping duplicate notification`);
            return res.json({
                received: true,
                skipped: true,
                reason: 'already_notified',
                email,
                application_id: application.id
            });
        }

        // Update call_booked_at timestamp
        await pool.query(
            'UPDATE typeform_applications SET call_booked_at = CURRENT_TIMESTAMP WHERE id = $1',
            [application.id]
        );

        // Log activity
        await pool.query(
            'INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4)',
            ['call_booked', 'typeform_application', application.id, JSON.stringify({
                email: email,
                invitee_name: name,
                event_name: eventName,
                start_time: eventStartTime,
                calendly_event_uri: scheduledEvent?.uri
            })]
        );

        // Post notification to Slack thread
        try {
            await postCallBookedNotification(
                pool,
                application.id,
                applicantName,
                email,
                eventTimeDisplay
            );
            console.log(`Posted call booked notification for ${email}`);
        } catch (slackError) {
            console.error('Failed to post Slack notification:', slackError.message);
            // Don't fail the webhook - the booking is still valid
        }

        console.log(`Call booked for ${email} - ${eventTimeDisplay}`);

        res.json({
            success: true,
            application_id: application.id,
            email: email,
            event_time: eventTimeDisplay
        });

    } catch (error) {
        console.error('Calendly webhook error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/webhooks/calendly/test
 * Health check for Calendly webhook
 */
router.get('/test', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Calendly webhook endpoint is active',
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
