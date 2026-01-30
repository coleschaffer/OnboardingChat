const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// Typeform webhook handler
router.post('/typeform', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const pool = req.app.locals.pool;

    // Verify webhook signature if secret is configured
    const signature = req.headers['typeform-signature'];
    const webhookSecret = process.env.TYPEFORM_WEBHOOK_SECRET;

    if (webhookSecret && signature) {
      const hash = crypto
        .createHmac('sha256', webhookSecret)
        .update(req.body)
        .digest('base64');

      const expectedSignature = `sha256=${hash}`;

      if (signature !== expectedSignature) {
        console.warn('Invalid Typeform webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    // Parse the body
    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { event_type, form_response } = payload;

    // Only process form_response events
    if (event_type !== 'form_response') {
      return res.status(200).json({ message: 'Event type ignored' });
    }

    const responseId = form_response.token;
    const answers = form_response.answers || [];

    // Map Typeform field IDs to our fields
    // You'll need to update these field IDs based on your Typeform form
    const fieldMapping = {
      // Example mappings - update these with actual field IDs from your form
      'first_name': findAnswer(answers, 'short_text', 0),
      'last_name': findAnswer(answers, 'short_text', 1),
      'email': findAnswer(answers, 'email', 0),
      'phone': findAnswer(answers, 'phone_number', 0),
      'business_description': findAnswer(answers, 'long_text', 0),
      'annual_revenue': findChoice(answers, 'multiple_choice', 0),
      'main_challenge': findAnswer(answers, 'long_text', 1),
      'why_ca_pro': findAnswer(answers, 'long_text', 2)
    };

    // Check if response already exists
    const existing = await pool.query(
      'SELECT id FROM typeform_applications WHERE typeform_response_id = $1',
      [responseId]
    );

    if (existing.rows.length > 0) {
      return res.status(200).json({ message: 'Response already processed' });
    }

    // Insert new application
    const result = await pool.query(`
      INSERT INTO typeform_applications (
        typeform_response_id,
        first_name,
        last_name,
        email,
        phone,
        business_description,
        annual_revenue,
        main_challenge,
        why_ca_pro,
        raw_data,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id
    `, [
      responseId,
      fieldMapping.first_name,
      fieldMapping.last_name,
      fieldMapping.email,
      fieldMapping.phone,
      fieldMapping.business_description,
      fieldMapping.annual_revenue,
      fieldMapping.main_challenge,
      fieldMapping.why_ca_pro,
      JSON.stringify(form_response),
      'new'
    ]);

    // Log activity
    await pool.query(`
      INSERT INTO activity_log (action, entity_type, entity_id, details)
      VALUES ($1, $2, $3, $4)
    `, ['new_application', 'application', result.rows[0].id, JSON.stringify({
      name: `${fieldMapping.first_name} ${fieldMapping.last_name}`,
      source: 'typeform_webhook'
    })]);

    console.log(`New Typeform application received: ${result.rows[0].id}`);

    res.status(200).json({
      success: true,
      application_id: result.rows[0].id
    });
  } catch (error) {
    console.error('Error processing Typeform webhook:', error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

// Helper functions to extract answers from Typeform response
function findAnswer(answers, type, index) {
  const filtered = answers.filter(a => a.type === type);
  if (filtered[index]) {
    switch (type) {
      case 'short_text':
      case 'long_text':
        return filtered[index].text;
      case 'email':
        return filtered[index].email;
      case 'phone_number':
        return filtered[index].phone_number;
      case 'number':
        return filtered[index].number;
      default:
        return filtered[index].text || null;
    }
  }
  return null;
}

function findChoice(answers, type, index) {
  const filtered = answers.filter(a => a.type === type);
  if (filtered[index] && filtered[index].choice) {
    return filtered[index].choice.label;
  }
  return null;
}

// Test endpoint for webhook
router.get('/typeform/test', (req, res) => {
  res.json({ message: 'Typeform webhook endpoint is active' });
});

module.exports = router;
