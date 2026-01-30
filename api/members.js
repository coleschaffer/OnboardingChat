const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

// Get all business owners with optional filters
router.get('/', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { source, status, search, limit = 50, offset = 0 } = req.query;

    let query = `
      SELECT
        bo.*,
        COUNT(tm.id) as team_member_count
      FROM business_owners bo
      LEFT JOIN team_members tm ON tm.business_owner_id = bo.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (source) {
      query += ` AND bo.source = $${paramIndex++}`;
      params.push(source);
    }

    if (status) {
      query += ` AND bo.onboarding_status = $${paramIndex++}`;
      params.push(status);
    }

    if (search) {
      query += ` AND (
        bo.first_name ILIKE $${paramIndex} OR
        bo.last_name ILIKE $${paramIndex} OR
        bo.email ILIKE $${paramIndex} OR
        bo.business_name ILIKE $${paramIndex}
      )`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    query += ` GROUP BY bo.id ORDER BY bo.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) FROM business_owners WHERE 1=1';
    const countParams = [];
    let countIndex = 1;

    if (source) {
      countQuery += ` AND source = $${countIndex++}`;
      countParams.push(source);
    }
    if (status) {
      countQuery += ` AND onboarding_status = $${countIndex++}`;
      countParams.push(status);
    }
    if (search) {
      countQuery += ` AND (first_name ILIKE $${countIndex} OR last_name ILIKE $${countIndex} OR email ILIKE $${countIndex} OR business_name ILIKE $${countIndex})`;
      countParams.push(`%${search}%`);
    }

    const countResult = await pool.query(countQuery, countParams);

    res.json({
      members: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Error fetching members:', error);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

// Get single business owner by ID
router.get('/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    const memberResult = await pool.query(
      'SELECT * FROM business_owners WHERE id = $1',
      [id]
    );

    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Get team members
    const teamResult = await pool.query(
      'SELECT * FROM team_members WHERE business_owner_id = $1 ORDER BY created_at',
      [id]
    );

    // Get C-level partners
    const partnersResult = await pool.query(
      'SELECT * FROM c_level_partners WHERE business_owner_id = $1 ORDER BY created_at',
      [id]
    );

    // Get onboarding submissions
    const submissionsResult = await pool.query(
      'SELECT * FROM onboarding_submissions WHERE business_owner_id = $1 ORDER BY created_at DESC',
      [id]
    );

    res.json({
      ...memberResult.rows[0],
      team_members: teamResult.rows,
      c_level_partners: partnersResult.rows,
      onboarding_submissions: submissionsResult.rows
    });
  } catch (error) {
    console.error('Error fetching member:', error);
    res.status(500).json({ error: 'Failed to fetch member' });
  }
});

// Create new business owner
router.post('/', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const {
      first_name, last_name, email, phone, business_name, business_overview,
      annual_revenue, team_count, traffic_sources, landing_pages, pain_point,
      massive_win, ai_skill_level, bio, headshot_url, whatsapp_number,
      whatsapp_joined, mailing_address, apparel_sizes, anything_else, source = 'chat_onboarding'
    } = req.body;

    const result = await pool.query(`
      INSERT INTO business_owners (
        first_name, last_name, email, phone, business_name, business_overview,
        annual_revenue, team_count, traffic_sources, landing_pages, pain_point,
        massive_win, ai_skill_level, bio, headshot_url, whatsapp_number,
        whatsapp_joined, mailing_address, apparel_sizes, anything_else, source
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
      RETURNING *
    `, [
      first_name, last_name, email, phone, business_name, business_overview,
      annual_revenue, team_count, traffic_sources, landing_pages, pain_point,
      massive_win, ai_skill_level, bio, headshot_url, whatsapp_number,
      whatsapp_joined || false, JSON.stringify(mailing_address), JSON.stringify(apparel_sizes),
      anything_else, source
    ]);

    // Log activity
    await pool.query(`
      INSERT INTO activity_log (action, entity_type, entity_id, details)
      VALUES ($1, $2, $3, $4)
    `, ['member_created', 'business_owner', result.rows[0].id, JSON.stringify({ name: `${first_name} ${last_name}` })]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating member:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: 'Failed to create member' });
  }
});

// Update business owner
router.put('/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;
    const updates = req.body;

    // Build dynamic update query
    const fields = [];
    const values = [];
    let paramIndex = 1;

    const allowedFields = [
      'first_name', 'last_name', 'email', 'phone', 'business_name', 'business_overview',
      'annual_revenue', 'team_count', 'traffic_sources', 'landing_pages', 'pain_point',
      'massive_win', 'ai_skill_level', 'bio', 'headshot_url', 'whatsapp_number',
      'whatsapp_joined', 'mailing_address', 'apparel_sizes', 'anything_else', 'onboarding_status'
    ];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        fields.push(`${key} = $${paramIndex++}`);
        if (key === 'mailing_address' || key === 'apparel_sizes') {
          values.push(JSON.stringify(value));
        } else {
          values.push(value);
        }
      }
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE business_owners SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Log activity
    await pool.query(`
      INSERT INTO activity_log (action, entity_type, entity_id, details)
      VALUES ($1, $2, $3, $4)
    `, ['member_updated', 'business_owner', id, JSON.stringify({ fields: Object.keys(updates) })]);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating member:', error);
    res.status(500).json({ error: 'Failed to update member' });
  }
});

// Get unified profile with linked Typeform and SamCart data
router.get('/:id/unified', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    // Get the business owner
    const memberResult = await pool.query(
      'SELECT * FROM business_owners WHERE id = $1',
      [id]
    );

    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const member = memberResult.rows[0];

    // Get team members
    const teamResult = await pool.query(
      'SELECT * FROM team_members WHERE business_owner_id = $1 ORDER BY created_at',
      [id]
    );

    // Get C-level partners
    const partnersResult = await pool.query(
      'SELECT * FROM c_level_partners WHERE business_owner_id = $1 ORDER BY created_at',
      [id]
    );

    // Get onboarding submissions
    const submissionsResult = await pool.query(
      'SELECT * FROM onboarding_submissions WHERE business_owner_id = $1 ORDER BY created_at DESC',
      [id]
    );

    // Look up linked Typeform data by email, phone, or name
    let typeformData = null;
    try {
      let conditions = [];
      let params = [];

      if (member.email) {
        conditions.push(`LOWER(email) = LOWER($${params.length + 1})`);
        params.push(member.email);
      }
      if (member.phone) {
        const cleanPhone = member.phone.replace(/\D/g, '');
        if (cleanPhone.length >= 10) {
          conditions.push(`REPLACE(REPLACE(REPLACE(phone, '-', ''), ' ', ''), '+', '') LIKE '%' || $${params.length + 1}`);
          params.push(cleanPhone.slice(-10));
        }
      }
      if (member.first_name && member.last_name) {
        conditions.push(`(LOWER(first_name) = LOWER($${params.length + 1}) AND LOWER(last_name) = LOWER($${params.length + 2}))`);
        params.push(member.first_name, member.last_name);
      }

      if (conditions.length > 0) {
        const query = `SELECT * FROM typeform_applications WHERE ${conditions.join(' OR ')} ORDER BY created_at DESC LIMIT 1`;
        const result = await pool.query(query, params);
        if (result.rows.length > 0) {
          typeformData = result.rows[0];
        }
      }
    } catch (err) {
      console.error('Error looking up Typeform data:', err);
    }

    // Look up linked SamCart data
    let samcartData = null;
    try {
      let conditions = [];
      let params = [];

      if (member.email) {
        conditions.push(`LOWER(email) = LOWER($${params.length + 1})`);
        params.push(member.email);
      }
      if (member.phone) {
        const cleanPhone = member.phone.replace(/\D/g, '');
        if (cleanPhone.length >= 10) {
          conditions.push(`REPLACE(REPLACE(REPLACE(phone, '-', ''), ' ', ''), '+', '') LIKE '%' || $${params.length + 1}`);
          params.push(cleanPhone.slice(-10));
        }
      }
      if (member.first_name && member.last_name) {
        conditions.push(`(LOWER(first_name) = LOWER($${params.length + 1}) AND LOWER(last_name) = LOWER($${params.length + 2}))`);
        params.push(member.first_name, member.last_name);
      }

      if (conditions.length > 0) {
        const query = `SELECT * FROM samcart_orders WHERE ${conditions.join(' OR ')} ORDER BY created_at DESC LIMIT 1`;
        const result = await pool.query(query, params);
        if (result.rows.length > 0) {
          samcartData = result.rows[0];
        }
      }
    } catch (err) {
      console.error('Error looking up SamCart data:', err);
    }

    res.json({
      ...member,
      team_members: teamResult.rows,
      c_level_partners: partnersResult.rows,
      onboarding_submissions: submissionsResult.rows,
      typeform_application: typeformData,
      samcart_order: samcartData
    });
  } catch (error) {
    console.error('Error fetching unified profile:', error);
    res.status(500).json({ error: 'Failed to fetch unified profile' });
  }
});

// Delete business owner
router.delete('/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM business_owners WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Log activity
    await pool.query(`
      INSERT INTO activity_log (action, entity_type, entity_id, details)
      VALUES ($1, $2, $3, $4)
    `, ['member_deleted', 'business_owner', id, JSON.stringify({ name: `${result.rows[0].first_name} ${result.rows[0].last_name}` })]);

    res.json({ message: 'Member deleted successfully' });
  } catch (error) {
    console.error('Error deleting member:', error);
    res.status(500).json({ error: 'Failed to delete member' });
  }
});

module.exports = router;
