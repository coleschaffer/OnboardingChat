const express = require('express');
const crypto = require('crypto');
const router = express.Router();

function getSelfBaseUrl() {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}`;
}

async function postSamcartTestWebhook(payload) {
  const baseUrl = getSelfBaseUrl();
  const response = await fetch(`${baseUrl}/api/webhooks/samcart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    const error = new Error(data.error || 'Samcart webhook request failed');
    error.status = response.status;
    throw error;
  }

  return data;
}

// Get all applications with optional filters
router.get('/', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { status, search, limit = 50, offset = 0 } = req.query;

    // Query applications with computed display_status, has_onboarding flag, and note_count
    let query = `
      SELECT ta.*,
        CASE WHEN EXISTS (
          SELECT 1 FROM onboarding_submissions os
          JOIN business_owners bo ON os.business_owner_id = bo.id
          WHERE LOWER(bo.email) = LOWER(ta.email)
        ) THEN true ELSE false END as has_onboarding,
        CASE
          WHEN ta.whatsapp_joined_at IS NOT NULL THEN 'joined'
          WHEN ta.onboarding_completed_at IS NOT NULL THEN 'onboarding_complete'
          WHEN ta.onboarding_started_at IS NOT NULL THEN 'onboarding_started'
          WHEN ta.purchased_at IS NOT NULL THEN 'purchased'
          WHEN ta.call_booked_at IS NOT NULL THEN 'call_booked'
          WHEN ta.replied_at IS NOT NULL THEN 'replied'
          WHEN ta.emailed_at IS NOT NULL THEN 'emailed'
          ELSE 'new'
        END as display_status,
        COALESCE(ta.whatsapp_joined_at, ta.onboarding_completed_at, ta.onboarding_started_at, ta.purchased_at, ta.call_booked_at, ta.replied_at, ta.emailed_at) as status_timestamp,
        (SELECT COUNT(*) FROM application_notes WHERE application_id = ta.id) as note_count
      FROM typeform_applications ta
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND ta.status = $${paramIndex++}`;
      params.push(status);
    }

    if (search) {
      query += ` AND (
        ta.first_name ILIKE $${paramIndex} OR
        ta.last_name ILIKE $${paramIndex} OR
        ta.email ILIKE $${paramIndex} OR
        ta.business_description ILIKE $${paramIndex}
      )`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    query += ` ORDER BY ta.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) FROM typeform_applications WHERE 1=1';
    const countParams = [];
    let countIndex = 1;

    if (status) {
      countQuery += ` AND status = $${countIndex++}`;
      countParams.push(status);
    }
    if (search) {
      countQuery += ` AND (first_name ILIKE $${countIndex} OR last_name ILIKE $${countIndex} OR email ILIKE $${countIndex} OR business_description ILIKE $${countIndex})`;
      countParams.push(`%${search}%`);
    }

    const countResult = await pool.query(countQuery, countParams);

    // Get status counts
    const statusCounts = await pool.query(`
      SELECT status, COUNT(*) as count
      FROM typeform_applications
      GROUP BY status
    `);

    // Get count of truly new applications (new status AND no matching onboarding)
    const trulyNewCount = await pool.query(`
      SELECT COUNT(*) as count
      FROM typeform_applications ta
      WHERE ta.status = 'new'
        AND NOT EXISTS (
          SELECT 1 FROM onboarding_submissions os
          JOIN business_owners bo ON os.business_owner_id = bo.id
          WHERE LOWER(bo.email) = LOWER(ta.email)
        )
    `);

    res.json({
      applications: result.rows,
      total: parseInt(countResult.rows[0].count),
      status_counts: statusCounts.rows.reduce((acc, row) => {
        acc[row.status] = parseInt(row.count);
        return acc;
      }, {}),
      truly_new_count: parseInt(trulyNewCount.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Error fetching applications:', error);
    res.status(500).json({ error: 'Failed to fetch applications' });
  }
});

// Get single application by ID
router.get('/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    const result = await pool.query(`
      SELECT ta.*,
        CASE
          WHEN ta.whatsapp_joined_at IS NOT NULL THEN 'joined'
          WHEN ta.onboarding_completed_at IS NOT NULL THEN 'onboarding_complete'
          WHEN ta.onboarding_started_at IS NOT NULL THEN 'onboarding_started'
          WHEN ta.purchased_at IS NOT NULL THEN 'purchased'
          WHEN ta.call_booked_at IS NOT NULL THEN 'call_booked'
          WHEN ta.replied_at IS NOT NULL THEN 'replied'
          WHEN ta.emailed_at IS NOT NULL THEN 'emailed'
          ELSE 'new'
        END as display_status,
        COALESCE(ta.whatsapp_joined_at, ta.onboarding_completed_at, ta.onboarding_started_at, ta.purchased_at, ta.call_booked_at, ta.replied_at, ta.emailed_at) as status_timestamp,
        CASE WHEN os.id IS NOT NULL THEN true ELSE false END as has_onboarding,
        bo.id as business_owner_id,
        bo.first_name as bo_first_name,
        bo.last_name as bo_last_name,
        bo.business_name as bo_business_name,
        bo.onboarding_status as bo_onboarding_status,
        bo.whatsapp_joined as bo_whatsapp_joined,
        bo.whatsapp_joined_at as bo_whatsapp_joined_at,
        os.id as onboarding_submission_id,
        os.progress_percentage as onboarding_progress,
        os.is_complete as onboarding_is_complete,
        os.created_at as onboarding_created_at,
        os.updated_at as onboarding_updated_at,
        os.completed_at as onboarding_completed_at,
        os.data as onboarding_data,
        c.id as cancellation_id,
        c.reason as cancellation_reason,
        c.created_at as cancellation_created_at
      FROM typeform_applications ta
      LEFT JOIN LATERAL (
        SELECT bo.*
        FROM business_owners bo
        WHERE LOWER(bo.email) = LOWER(ta.email)
        ORDER BY bo.created_at DESC
        LIMIT 1
      ) bo ON true
      LEFT JOIN LATERAL (
        SELECT os.*
        FROM onboarding_submissions os
        WHERE os.business_owner_id = bo.id
        ORDER BY os.created_at DESC
        LIMIT 1
      ) os ON true
      LEFT JOIN LATERAL (
        SELECT id, reason, created_at
        FROM cancellations c
        WHERE LOWER(c.member_email) = LOWER(ta.email)
        ORDER BY c.created_at DESC
        LIMIT 1
      ) c ON true
      WHERE ta.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching application:', error);
    res.status(500).json({ error: 'Failed to fetch application' });
  }
});

// Update application status
router.put('/:id/status', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['new', 'reviewed', 'approved', 'rejected'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const result = await pool.query(
      'UPDATE typeform_applications SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }

    // Log activity
    await pool.query(`
      INSERT INTO activity_log (action, entity_type, entity_id, details)
      VALUES ($1, $2, $3, $4)
    `, ['application_status_changed', 'application', id, JSON.stringify({ status, name: `${result.rows[0].first_name} ${result.rows[0].last_name}` })]);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating application status:', error);
    res.status(500).json({ error: 'Failed to update application status' });
  }
});

// Convert approved application to business owner
router.post('/:id/convert', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    // Get application
    const appResult = await pool.query(
      'SELECT * FROM typeform_applications WHERE id = $1',
      [id]
    );

    if (appResult.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }

    const app = appResult.rows[0];

    // Check if email already exists
    const existingMember = await pool.query(
      'SELECT id FROM business_owners WHERE email = $1',
      [app.email]
    );

    if (existingMember.rows.length > 0) {
      return res.status(400).json({ error: 'A member with this email already exists' });
    }

    // Create business owner from application
    const memberResult = await pool.query(`
      INSERT INTO business_owners (
        first_name, last_name, email, phone, business_overview,
        annual_revenue, source, onboarding_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      app.first_name,
      app.last_name,
      app.email,
      app.phone,
      app.business_description,
      app.annual_revenue,
      'typeform',
      'pending'
    ]);

    // Update application status
    await pool.query(
      'UPDATE typeform_applications SET status = $1 WHERE id = $2',
      ['approved', id]
    );

    // Log activity
    await pool.query(`
      INSERT INTO activity_log (action, entity_type, entity_id, details)
      VALUES ($1, $2, $3, $4)
    `, ['application_converted', 'business_owner', memberResult.rows[0].id, JSON.stringify({ from_application: id })]);

    res.status(201).json({
      message: 'Application converted to member successfully',
      member: memberResult.rows[0]
    });
  } catch (error) {
    console.error('Error converting application:', error);
    res.status(500).json({ error: 'Failed to convert application' });
  }
});

// Test helper: simulate SamCart subscription charge failures for this application
router.post('/:id/test-subscription-failure', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;
    const requestedCount = parseInt(req.body?.count, 10);
    const count = Number.isFinite(requestedCount) ? Math.max(1, Math.min(requestedCount, 4)) : 1;

    const appResult = await pool.query(
      'SELECT id, email, first_name, last_name, phone FROM typeform_applications WHERE id = $1',
      [id]
    );
    if (appResult.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }

    const app = appResult.rows[0];
    if (!app.email) {
      return res.status(400).json({ error: 'Application missing email' });
    }

    const orderResult = await pool.query(
      `
        SELECT samcart_order_id, order_total, currency
        FROM samcart_orders
        WHERE LOWER(email) = LOWER($1)
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [app.email]
    );
    const order = orderResult.rows[0] || {};

    const results = [];
    for (let i = 0; i < count; i += 1) {
      const payload = {
        type: 'Subscription Charge Failed',
        event_id: `test-${crypto.randomUUID()}`,
        event_timestamp: new Date().toISOString(),
        customer: {
          email: app.email,
          first_name: app.first_name,
          last_name: app.last_name,
          phone: app.phone
        },
        subscription_id: order.samcart_order_id || `test-subscription-${app.id}`,
        order_id: order.samcart_order_id || `test-order-${app.id}`,
        amount: order.order_total || 5000,
        currency: order.currency || 'USD',
        status: 'failed'
      };

      const data = await postSamcartTestWebhook(payload);
      results.push(data);
    }

    res.json({ success: true, requested: count, results });
  } catch (error) {
    console.error('Error simulating subscription failure:', error);
    res.status(500).json({ error: error.message || 'Failed to simulate subscription failure' });
  }
});

// Test helper: simulate SamCart subscription canceled for this application
router.post('/:id/test-subscription-cancel', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    const appResult = await pool.query(
      'SELECT id, email, first_name, last_name, phone FROM typeform_applications WHERE id = $1',
      [id]
    );
    if (appResult.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }

    const app = appResult.rows[0];
    if (!app.email) {
      return res.status(400).json({ error: 'Application missing email' });
    }

    const orderResult = await pool.query(
      `
        SELECT samcart_order_id, order_total, currency
        FROM samcart_orders
        WHERE LOWER(email) = LOWER($1)
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [app.email]
    );
    const order = orderResult.rows[0] || {};

    const payload = {
      type: 'Subscription Canceled',
      event_id: `test-${crypto.randomUUID()}`,
      event_timestamp: new Date().toISOString(),
      customer: {
        email: app.email,
        first_name: app.first_name,
        last_name: app.last_name,
        phone: app.phone
      },
      subscription_id: order.samcart_order_id || `test-subscription-${app.id}`,
      order_id: order.samcart_order_id || `test-order-${app.id}`,
      amount: order.order_total || 5000,
      currency: order.currency || 'USD',
      status: 'canceled'
    };

    const data = await postSamcartTestWebhook(payload);
    res.json({ success: true, result: data });
  } catch (error) {
    console.error('Error simulating subscription cancel:', error);
    res.status(500).json({ error: error.message || 'Failed to simulate subscription cancel' });
  }
});

// Test helper: simulate SamCart subscription recovered for this application
router.post('/:id/test-subscription-recovered', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    const appResult = await pool.query(
      'SELECT id, email, first_name, last_name, phone FROM typeform_applications WHERE id = $1',
      [id]
    );
    if (appResult.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }

    const app = appResult.rows[0];
    if (!app.email) {
      return res.status(400).json({ error: 'Application missing email' });
    }

    const orderResult = await pool.query(
      `
        SELECT samcart_order_id, order_total, currency
        FROM samcart_orders
        WHERE LOWER(email) = LOWER($1)
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [app.email]
    );
    const order = orderResult.rows[0] || {};

    const payload = {
      type: 'Subscription Recovered',
      event_id: `test-${crypto.randomUUID()}`,
      event_timestamp: new Date().toISOString(),
      customer: {
        email: app.email,
        first_name: app.first_name,
        last_name: app.last_name,
        phone: app.phone
      },
      subscription_id: order.samcart_order_id || `test-subscription-${app.id}`,
      order_id: order.samcart_order_id || `test-order-${app.id}`,
      amount: order.order_total || 5000,
      currency: order.currency || 'USD',
      status: 'recovered'
    };

    const data = await postSamcartTestWebhook(payload);
    res.json({ success: true, result: data });
  } catch (error) {
    console.error('Error simulating subscription recovered:', error);
    res.status(500).json({ error: error.message || 'Failed to simulate subscription recovered' });
  }
});

// Delete application
router.delete('/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    // Delete all related records (foreign key constraints)
    await pool.query(
      'DELETE FROM email_threads WHERE typeform_application_id = $1',
      [id]
    );

    await pool.query(
      'DELETE FROM application_notes WHERE application_id = $1',
      [id]
    );

    await pool.query(
      'DELETE FROM pending_email_sends WHERE typeform_application_id = $1',
      [id]
    );

    // Now delete the application
    const result = await pool.query(
      'DELETE FROM typeform_applications WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }

    console.log(`[Admin] Deleted application ${id} (${result.rows[0].email})`);
    res.json({ message: 'Application deleted successfully' });
  } catch (error) {
    console.error('Error deleting application:', error);
    res.status(500).json({ error: 'Failed to delete application' });
  }
});

module.exports = router;
