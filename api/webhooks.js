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
    const definition = form_response.definition || {};
    const fields = definition.fields || [];

    console.log('Typeform answers received:', JSON.stringify(answers, null, 2));

    // Build a map of field ID to field title for better matching
    const fieldTitleMap = {};
    fields.forEach(f => {
      fieldTitleMap[f.id] = f.title?.toLowerCase() || '';
    });

    // Extract answers by looking at field titles/types
    const fieldMapping = {
      first_name: null,
      last_name: null,
      email: null,
      phone: null,
      business_description: null,
      annual_revenue: null,
      main_challenge: null,
      why_ca_pro: null
    };

    // Process each answer and map to our fields
    for (const answer of answers) {
      const fieldId = answer.field?.id;
      const fieldTitle = fieldTitleMap[fieldId] || '';
      const value = extractAnswerValue(answer);

      // Match by field type first
      if (answer.type === 'email' && !fieldMapping.email) {
        fieldMapping.email = value;
      } else if (answer.type === 'phone_number' && !fieldMapping.phone) {
        fieldMapping.phone = value;
      }
      // Then match by title keywords (order matters - more specific matches first)
      else if (fieldTitle.includes('first') && fieldTitle.includes('name')) {
        fieldMapping.first_name = value;
      } else if (fieldTitle.includes('last') && fieldTitle.includes('name')) {
        fieldMapping.last_name = value;
      } else if ((fieldTitle.includes('full') && fieldTitle.includes('name')) || fieldTitle === 'name') {
        // Split full name into first/last
        const parts = (value || '').trim().split(/\s+/);
        if (parts.length >= 2) {
          fieldMapping.first_name = parts[0];
          fieldMapping.last_name = parts.slice(1).join(' ');
        } else {
          fieldMapping.first_name = value;
        }
      }
      // Revenue question (MC): "What's your current annual revenue?"
      else if (fieldTitle.includes('revenue') || fieldTitle.includes('sales')) {
        fieldMapping.annual_revenue = value;
      }
      // Main challenge (SA): "What's the #1 thing holding your business back from scaling right now?"
      else if (fieldTitle.includes('holding') || fieldTitle.includes('scaling') ||
               fieldTitle.includes('#1') || fieldTitle.includes('challenge') ||
               fieldTitle.includes('struggle') || fieldTitle.includes('problem')) {
        fieldMapping.main_challenge = value;
      }
      // Why CA Pro (SA): "what specifically about CA Pro made you want to apply?"
      else if (fieldTitle.includes('ca pro') || fieldTitle.includes('made you want') ||
               fieldTitle.includes('specifically') || fieldTitle.includes('apply') ||
               fieldTitle.includes('why') || fieldTitle.includes('goal') ||
               fieldTitle.includes('hope') || fieldTitle.includes('expect')) {
        fieldMapping.why_ca_pro = value;
      }
      // Business description (SA): "Tell me about your business. What do you sell..."
      // Check this AFTER main_challenge to avoid matching "holding your business back"
      else if ((fieldTitle.includes('tell') && fieldTitle.includes('business')) ||
               fieldTitle.includes('what do you sell') || fieldTitle.includes('who do you sell') ||
               (fieldTitle.includes('about') && fieldTitle.includes('business')) ||
               fieldTitle.includes('company') || fieldTitle.includes('describe')) {
        fieldMapping.business_description = value;
      }
    }

    console.log('Parsed Typeform fields:', fieldMapping);

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

// Helper function to extract value from any Typeform answer type
function extractAnswerValue(answer) {
  if (!answer) return null;

  switch (answer.type) {
    case 'text':
    case 'short_text':
    case 'long_text':
      return answer.text;
    case 'email':
      return answer.email;
    case 'phone_number':
      return answer.phone_number;
    case 'number':
      return answer.number?.toString();
    case 'boolean':
      return answer.boolean ? 'Yes' : 'No';
    case 'choice':
      return answer.choice?.label || answer.choice?.other;
    case 'choices':
      return (answer.choices?.labels || []).join(', ');
    case 'date':
      return answer.date;
    case 'url':
      return answer.url;
    case 'file_url':
      return answer.file_url;
    default:
      // Try common properties
      return answer.text || answer.email || answer.phone_number ||
             answer.number?.toString() || answer.choice?.label || null;
  }
}

// Test endpoint for webhook
router.get('/typeform/test', (req, res) => {
  res.json({ message: 'Typeform webhook endpoint is active' });
});

// SamCart webhook handler
router.post('/samcart', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const payload = req.body;

    console.log('SamCart webhook received:', JSON.stringify(payload, null, 2));

    // SamCart sends different event types
    const eventType = payload.type || 'order'; // order, refund, subscription, etc.

    // Extract customer data from SamCart payload
    // SamCart typically sends: customer object with email, name, phone
    const customer = payload.customer || {};
    const order = payload.order || payload;

    const orderData = {
      samcart_order_id: order.id || order.order_id || null,
      event_type: eventType,
      email: customer.email || order.customer_email || order.email || null,
      first_name: customer.first_name || order.customer_first_name || order.first_name || null,
      last_name: customer.last_name || order.customer_last_name || order.last_name || null,
      phone: customer.phone || order.customer_phone || order.phone || null,
      product_name: order.product_name || order.product?.name || null,
      product_id: order.product_id || order.product?.id || null,
      order_total: order.total || order.order_total || null,
      currency: order.currency || 'USD',
      status: order.status || 'completed'
    };

    console.log('Parsed SamCart order:', orderData);

    // Skip if no email (required for linking)
    if (!orderData.email) {
      console.warn('SamCart webhook missing email, storing anyway');
    }

    // Check if order already exists
    if (orderData.samcart_order_id) {
      const existing = await pool.query(
        'SELECT id FROM samcart_orders WHERE samcart_order_id = $1',
        [orderData.samcart_order_id]
      );

      if (existing.rows.length > 0) {
        // Update existing order (e.g., status change)
        await pool.query(`
          UPDATE samcart_orders SET
            event_type = $1,
            status = $2,
            raw_data = $3,
            updated_at = CURRENT_TIMESTAMP
          WHERE samcart_order_id = $4
        `, [eventType, orderData.status, JSON.stringify(payload), orderData.samcart_order_id]);

        console.log(`Updated SamCart order: ${orderData.samcart_order_id}`);
        return res.status(200).json({ success: true, message: 'Order updated' });
      }
    }

    // Insert new order
    const result = await pool.query(`
      INSERT INTO samcart_orders (
        samcart_order_id, event_type, email, first_name, last_name, phone,
        product_name, product_id, order_total, currency, status, raw_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id
    `, [
      orderData.samcart_order_id,
      orderData.event_type,
      orderData.email,
      orderData.first_name,
      orderData.last_name,
      orderData.phone,
      orderData.product_name,
      orderData.product_id,
      orderData.order_total,
      orderData.currency,
      orderData.status,
      JSON.stringify(payload)
    ]);

    // Try to link to Typeform application by email
    if (orderData.email) {
      await pool.query(`
        UPDATE typeform_applications
        SET status = 'approved', updated_at = CURRENT_TIMESTAMP
        WHERE LOWER(email) = LOWER($1) AND status = 'new'
      `, [orderData.email]);
    }

    // Log activity - payment notification
    const customerName = [orderData.first_name, orderData.last_name].filter(Boolean).join(' ') || orderData.email || 'Unknown';
    await pool.query(`
      INSERT INTO activity_log (action, entity_type, entity_id, details)
      VALUES ($1, $2, $3, $4)
    `, ['new_payment', 'order', result.rows[0].id, JSON.stringify({
      name: customerName,
      email: orderData.email,
      product: orderData.product_name,
      amount: orderData.order_total,
      currency: orderData.currency
    })]);

    console.log(`New SamCart order received: ${result.rows[0].id}`);

    res.status(200).json({
      success: true,
      order_id: result.rows[0].id
    });
  } catch (error) {
    console.error('Error processing SamCart webhook:', error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

// Test endpoint for SamCart webhook
router.get('/samcart/test', (req, res) => {
  res.json({ message: 'SamCart webhook endpoint is active' });
});

module.exports = router;
