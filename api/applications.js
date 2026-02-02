const express = require('express');
const router = express.Router();

// Get all applications with optional filters
router.get('/', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { status, search, limit = 50, offset = 0 } = req.query;

    // Query applications with a flag indicating if there's a matching onboarding submission
    let query = `
      SELECT ta.*,
        CASE WHEN EXISTS (
          SELECT 1 FROM onboarding_submissions os
          JOIN business_owners bo ON os.business_owner_id = bo.id
          WHERE LOWER(bo.email) = LOWER(ta.email)
        ) THEN true ELSE false END as has_onboarding
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

    const result = await pool.query(
      'SELECT * FROM typeform_applications WHERE id = $1',
      [id]
    );

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

// Delete application
router.delete('/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM typeform_applications WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }

    res.json({ message: 'Application deleted successfully' });
  } catch (error) {
    console.error('Error deleting application:', error);
    res.status(500).json({ error: 'Failed to delete application' });
  }
});

module.exports = router;
