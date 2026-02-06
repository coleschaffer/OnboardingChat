const express = require('express');
const router = express.Router();

// Get all team members with optional filters
router.get('/', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { business_owner_id, source, search, limit = 50, offset = 0 } = req.query;

    let query = `
      SELECT
        tm.*,
        bo.business_name,
        bo.first_name as owner_first_name,
        bo.last_name as owner_last_name
      FROM team_members tm
      LEFT JOIN business_owners bo ON tm.business_owner_id = bo.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (business_owner_id) {
      query += ` AND tm.business_owner_id = $${paramIndex++}`;
      params.push(business_owner_id);
    }

    if (source) {
      query += ` AND tm.source = $${paramIndex++}`;
      params.push(source);
    }

    if (search) {
      query += ` AND (
        tm.first_name ILIKE $${paramIndex} OR
        tm.last_name ILIKE $${paramIndex} OR
        tm.email ILIKE $${paramIndex} OR
        tm.role ILIKE $${paramIndex} OR
        bo.business_name ILIKE $${paramIndex}
      )`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    query += ` ORDER BY tm.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = `
      SELECT COUNT(*) FROM team_members tm
      LEFT JOIN business_owners bo ON tm.business_owner_id = bo.id
      WHERE 1=1
    `;
    const countParams = [];
    let countIndex = 1;

    if (business_owner_id) {
      countQuery += ` AND tm.business_owner_id = $${countIndex++}`;
      countParams.push(business_owner_id);
    }
    if (source) {
      countQuery += ` AND tm.source = $${countIndex++}`;
      countParams.push(source);
    }
    if (search) {
      countQuery += ` AND (tm.first_name ILIKE $${countIndex} OR tm.last_name ILIKE $${countIndex} OR tm.email ILIKE $${countIndex} OR tm.role ILIKE $${countIndex} OR bo.business_name ILIKE $${countIndex})`;
      countParams.push(`%${search}%`);
    }

    const countResult = await pool.query(countQuery, countParams);

    res.json({
      team_members: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Error fetching team members:', error);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

// Get single team member by ID
router.get('/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    const result = await pool.query(`
      SELECT
        tm.*,
        bo.business_name,
        bo.first_name as owner_first_name,
        bo.last_name as owner_last_name,
        bo.email as owner_email
      FROM team_members tm
      LEFT JOIN business_owners bo ON tm.business_owner_id = bo.id
      WHERE tm.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team member not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching team member:', error);
    res.status(500).json({ error: 'Failed to fetch team member' });
  }
});

// Create new team member
router.post('/', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const {
      business_owner_id, first_name, last_name, email, phone, role, title,
      copywriting_skill, cro_skill, ai_skill, business_summary, responsibilities,
      source = 'chat_onboarding',
      request_sync = false
    } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    if (business_owner_id) {
      const existing = await pool.query(
        `SELECT id FROM team_members WHERE business_owner_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1`,
        [business_owner_id, email]
      );
      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'Team member already exists for this business owner' });
      }
    }

    const result = await pool.query(`
      INSERT INTO team_members (
        business_owner_id, first_name, last_name, email, phone, role, title,
        copywriting_skill, cro_skill, ai_skill, business_summary, responsibilities, source
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `, [
      business_owner_id || null, first_name, last_name, email, phone, role, title,
      copywriting_skill, cro_skill, ai_skill, business_summary, responsibilities, source
    ]);

    let created = result.rows[0];

    // Optionally flag this team member for cron-based sync to Circle/WhatsApp/Monday.
    // We keep this as a best-effort update so it won't break if migrations haven't run yet.
    if (request_sync) {
      try {
        const updated = await pool.query(
          `UPDATE team_members
           SET sync_requested_at = NOW(),
               sync_attempts = 0,
               last_sync_attempt_at = NULL,
               last_sync_error = NULL,
               circle_synced_at = NULL,
               whatsapp_synced_at = NULL,
               monday_synced_at = NULL
           WHERE id = $1
           RETURNING *`,
          [created.id]
        );
        if (updated.rows[0]) created = updated.rows[0];
      } catch (err) {
        console.error('[Team Members] Failed to set sync_requested_at:', err.message);
      }
    }

    // Log activity
    await pool.query(`
      INSERT INTO activity_log (action, entity_type, entity_id, details)
      VALUES ($1, $2, $3, $4)
    `, ['team_member_created', 'team_member', result.rows[0].id, JSON.stringify({ name: `${first_name} ${last_name}`, role })]);

    res.status(201).json(created);
  } catch (error) {
    console.error('Error creating team member:', error);
    res.status(500).json({ error: 'Failed to create team member' });
  }
});

// Update team member
router.put('/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;
    const updates = req.body;

    const fields = [];
    const values = [];
    let paramIndex = 1;

    const allowedFields = [
      'business_owner_id', 'first_name', 'last_name', 'email', 'phone',
      'role', 'title', 'copywriting_skill', 'cro_skill', 'ai_skill',
      'business_summary', 'responsibilities'
    ];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        fields.push(`${key} = $${paramIndex++}`);
        values.push(value);
      }
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE team_members SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team member not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating team member:', error);
    res.status(500).json({ error: 'Failed to update team member' });
  }
});

// Delete team member
router.delete('/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM team_members WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team member not found' });
    }

    res.json({ message: 'Team member deleted successfully' });
  } catch (error) {
    console.error('Error deleting team member:', error);
    res.status(500).json({ error: 'Failed to delete team member' });
  }
});

module.exports = router;
