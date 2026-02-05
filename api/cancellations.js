const express = require('express');
const router = express.Router();

// Get cancellations with optional search
router.get('/', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { search, limit = 20, offset = 0 } = req.query;

    let query = `
      SELECT id, member_email, member_name, reason, source, created_by, created_at
      FROM cancellations
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (search) {
      query += ` AND (
        member_email ILIKE $${paramIndex} OR
        member_name ILIKE $${paramIndex} OR
        reason ILIKE $${paramIndex} OR
        source ILIKE $${paramIndex}
      )`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    let countQuery = `SELECT COUNT(*) FROM cancellations WHERE 1=1`;
    const countParams = [];
    let countIndex = 1;

    if (search) {
      countQuery += ` AND (
        member_email ILIKE $${countIndex} OR
        member_name ILIKE $${countIndex} OR
        reason ILIKE $${countIndex} OR
        source ILIKE $${countIndex}
      )`;
      countParams.push(`%${search}%`);
      countIndex++;
    }

    const countResult = await pool.query(countQuery, countParams);

    res.json({
      cancellations: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Error fetching cancellations:', error);
    res.status(500).json({ error: 'Failed to fetch cancellations' });
  }
});

module.exports = router;
