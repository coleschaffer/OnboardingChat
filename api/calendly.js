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

        // Find matching typeform application
        const appResult = await pool.query(
            'SELECT id, first_name, last_name, email FROM typeform_applications WHERE LOWER(email) = $1',
            [email]
        );

        if (appResult.rows.length === 0) {
            console.log(`No matching typeform application for email: ${email}`);
            // Still return success - the booking is valid, just no matching application
            return res.json({ received: true, warning: 'no matching application', email });
        }

        const application = appResult.rows[0];
        const applicantName = `${application.first_name || ''} ${application.last_name || ''}`.trim() || name;

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
