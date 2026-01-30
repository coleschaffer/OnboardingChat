const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

// Helper to send Slack welcome message
async function sendSlackWelcome(answers) {
  // Skip if Slack is not configured
  if (!process.env.SLACK_BOT_TOKEN) {
    console.log('Slack not configured, skipping welcome message');
    return;
  }

  const memberData = {
    firstName: answers.firstName || '',
    lastName: answers.lastName || '',
    businessName: answers.businessName || '',
    businessOverview: answers.businessOverview || '',
    massiveWin: answers.massiveWin || '',
    teamCount: answers.teamCount || '',
    trafficSources: answers.trafficSources || ''
  };

  // Call our own Slack endpoint
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const response = await fetch(`${baseUrl}/api/slack/send-welcome`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberData })
  });

  if (!response.ok) {
    throw new Error(`Slack API returned ${response.status}`);
  }

  console.log('Slack welcome message sent successfully');
}

// Save progress (partial or complete)
router.post('/save-progress', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { sessionId, answers, teamMembers, cLevelPartners, currentQuestion, totalQuestions, isComplete } = req.body;

    // Generate session ID if not provided
    const session = sessionId || uuidv4();
    const progress = Math.round((currentQuestion / totalQuestions) * 100);

    // Check if session exists
    const existing = await pool.query(
      'SELECT id, business_owner_id FROM onboarding_submissions WHERE session_id = $1',
      [session]
    );

    let submissionId;
    let businessOwnerId = null;

    if (existing.rows.length > 0) {
      // Update existing submission
      submissionId = existing.rows[0].id;
      businessOwnerId = existing.rows[0].business_owner_id;

      await pool.query(`
        UPDATE onboarding_submissions SET
          data = $1,
          progress_percentage = $2,
          last_question = $3,
          is_complete = $4,
          completed_at = $5
        WHERE session_id = $6
      `, [
        JSON.stringify({ answers, teamMembers, cLevelPartners }),
        progress,
        answers.lastQuestionId || null,
        isComplete || false,
        isComplete ? new Date() : null,
        session
      ]);
    } else {
      // Create new submission
      const result = await pool.query(`
        INSERT INTO onboarding_submissions (
          session_id, data, progress_percentage, last_question, is_complete, completed_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [
        session,
        JSON.stringify({ answers, teamMembers, cLevelPartners }),
        progress,
        answers.lastQuestionId || null,
        isComplete || false,
        isComplete ? new Date() : null
      ]);
      submissionId = result.rows[0].id;
    }

    // If complete, create/update business owner and team members
    if (isComplete) {
      businessOwnerId = await createOrUpdateBusinessOwner(pool, answers, teamMembers, cLevelPartners, session, submissionId);

      // Send Slack welcome message (async, don't wait)
      sendSlackWelcome(answers).catch(err => {
        console.error('Failed to send Slack welcome:', err);
      });
    }

    res.json({
      success: true,
      sessionId: session,
      submissionId,
      businessOwnerId,
      progress,
      isComplete: isComplete || false
    });
  } catch (error) {
    console.error('Error saving progress:', error);
    res.status(500).json({ error: 'Failed to save progress' });
  }
});

// Helper function to create/update business owner
async function createOrUpdateBusinessOwner(pool, answers, teamMembers, cLevelPartners, sessionId, submissionId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let businessOwnerId;

    // Try to find existing member by email if provided
    if (answers.email) {
      const existingMember = await client.query(
        'SELECT id FROM business_owners WHERE email = $1',
        [answers.email]
      );

      if (existingMember.rows.length > 0) {
        businessOwnerId = existingMember.rows[0].id;

        // Update existing member
        await client.query(`
          UPDATE business_owners SET
            business_name = COALESCE($1, business_name),
            business_overview = COALESCE($2, business_overview),
            team_count = COALESCE($3, team_count),
            traffic_sources = COALESCE($4, traffic_sources),
            landing_pages = COALESCE($5, landing_pages),
            massive_win = COALESCE($6, massive_win),
            ai_skill_level = COALESCE($7, ai_skill_level),
            bio = COALESCE($8, bio),
            headshot_url = COALESCE($9, headshot_url),
            whatsapp_number = COALESCE($10, whatsapp_number),
            whatsapp_joined = COALESCE($11, whatsapp_joined),
            anything_else = COALESCE($12, anything_else),
            onboarding_status = 'completed',
            onboarding_progress = 100
          WHERE id = $13
        `, [
          answers.businessName,
          answers.businessOverview,
          answers.teamCount,
          answers.trafficSources,
          answers.landingPages,
          answers.massiveWin,
          answers.aiSkillLevel,
          answers.bio,
          answers.headshotLink,
          answers.whatsappNumber,
          answers.whatsappJoined === 'done',
          answers.anythingElse,
          businessOwnerId
        ]);
      }
    }

    // Create new business owner if needed
    if (!businessOwnerId) {
      const memberResult = await client.query(`
        INSERT INTO business_owners (
          first_name, last_name, email, phone, business_name, business_overview,
          team_count, traffic_sources, landing_pages, massive_win, ai_skill_level,
          bio, headshot_url, whatsapp_number, whatsapp_joined, anything_else,
          source, onboarding_status, onboarding_progress
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        RETURNING id
      `, [
        answers.firstName || null,
        answers.lastName || null,
        answers.email || null,
        answers.phone || null,
        answers.businessName,
        answers.businessOverview,
        answers.teamCount,
        answers.trafficSources,
        answers.landingPages,
        answers.massiveWin,
        answers.aiSkillLevel,
        answers.bio,
        answers.headshotLink,
        answers.whatsappNumber,
        answers.whatsappJoined === 'done',
        answers.anythingElse,
        'chat_onboarding',
        'completed',
        100
      ]);
      businessOwnerId = memberResult.rows[0].id;
    }

    // Link submission to business owner
    await client.query(
      'UPDATE onboarding_submissions SET business_owner_id = $1 WHERE session_id = $2',
      [businessOwnerId, sessionId]
    );

    // Add team members
    if (teamMembers && teamMembers.length > 0) {
      for (const member of teamMembers) {
        // Handle both old format (firstName/lastName) and new format (name)
        const firstName = member.firstName || member.name || '';
        const lastName = member.lastName || '';

        await client.query(`
          INSERT INTO team_members (
            business_owner_id, first_name, last_name, email, phone, role, source
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          businessOwnerId,
          firstName,
          lastName,
          member.email,
          member.phone,
          member.role || null,
          'chat_onboarding'
        ]);
      }
    }

    // Add C-level partners
    if (cLevelPartners && cLevelPartners.length > 0) {
      for (const partner of cLevelPartners) {
        // Handle both old format (firstName/lastName) and new format (name)
        const firstName = partner.firstName || partner.name || '';
        const lastName = partner.lastName || '';

        await client.query(`
          INSERT INTO c_level_partners (
            business_owner_id, first_name, last_name, email, phone, source
          ) VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          businessOwnerId,
          firstName,
          lastName,
          partner.email,
          partner.phone,
          'chat_onboarding'
        ]);
      }
    }

    // Log activity
    await client.query(`
      INSERT INTO activity_log (action, entity_type, entity_id, details)
      VALUES ($1, $2, $3, $4)
    `, ['onboarding_completed', 'business_owner', businessOwnerId, JSON.stringify({ business: answers.businessName })]);

    await client.query('COMMIT');
    return businessOwnerId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Legacy submit endpoint (for backwards compatibility)
router.post('/submit', async (req, res) => {
  try {
    const { answers, teamMembers, cLevelPartners } = req.body;

    // Forward to save-progress with isComplete=true
    req.body = {
      sessionId: uuidv4(),
      answers,
      teamMembers,
      cLevelPartners,
      currentQuestion: 100,
      totalQuestions: 100,
      isComplete: true
    };

    // Call save-progress logic
    const pool = req.app.locals.pool;
    const session = req.body.sessionId;

    const result = await pool.query(`
      INSERT INTO onboarding_submissions (
        session_id, data, progress_percentage, is_complete, completed_at
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `, [
      session,
      JSON.stringify({ answers, teamMembers, cLevelPartners }),
      100,
      true,
      new Date()
    ]);

    const businessOwnerId = await createOrUpdateBusinessOwner(
      pool, answers, teamMembers, cLevelPartners, session, result.rows[0].id
    );

    res.status(201).json({
      success: true,
      message: 'Onboarding completed successfully',
      business_owner_id: businessOwnerId
    });
  } catch (error) {
    console.error('Error submitting onboarding:', error);
    res.status(500).json({ error: 'Failed to submit onboarding data' });
  }
});

// Get all onboarding submissions with filters
router.get('/submissions', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { limit = 50, offset = 0, complete, search } = req.query;

    let query = `
      SELECT
        os.*,
        bo.first_name,
        bo.last_name,
        bo.email,
        bo.business_name
      FROM onboarding_submissions os
      LEFT JOIN business_owners bo ON os.business_owner_id = bo.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    // Filter by completion status
    if (complete !== undefined) {
      query += ` AND os.is_complete = $${paramIndex++}`;
      params.push(complete === 'true');
    }

    // Search
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

    query += ` ORDER BY os.updated_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    // Get counts
    const countsResult = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_complete = true) as complete_count,
        COUNT(*) FILTER (WHERE is_complete = false) as incomplete_count,
        COUNT(*) as total_count
      FROM onboarding_submissions
    `);

    res.json({
      submissions: result.rows,
      counts: {
        complete: parseInt(countsResult.rows[0].complete_count),
        incomplete: parseInt(countsResult.rows[0].incomplete_count),
        total: parseInt(countsResult.rows[0].total_count)
      },
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Error fetching submissions:', error);
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
});

// Get single submission by ID
router.get('/submissions/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    const result = await pool.query(`
      SELECT
        os.*,
        bo.first_name,
        bo.last_name,
        bo.email,
        bo.business_name
      FROM onboarding_submissions os
      LEFT JOIN business_owners bo ON os.business_owner_id = bo.id
      WHERE os.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching submission:', error);
    res.status(500).json({ error: 'Failed to fetch submission' });
  }
});

// Get submission by session ID (for resuming)
router.get('/session/:sessionId', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { sessionId } = req.params;

    const result = await pool.query(
      'SELECT * FROM onboarding_submissions WHERE session_id = $1',
      [sessionId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching session:', error);
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

// Mark submission as complete and create member
router.post('/submissions/:id/complete', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    // Get the submission
    const subResult = await pool.query(
      'SELECT * FROM onboarding_submissions WHERE id = $1',
      [id]
    );

    if (subResult.rows.length === 0) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    const submission = subResult.rows[0];
    const data = submission.data || {};

    // Create business owner from submission data
    const businessOwnerId = await createOrUpdateBusinessOwner(
      pool,
      data.answers || {},
      data.teamMembers || [],
      data.cLevelPartners || [],
      submission.session_id,
      id
    );

    // Mark submission as complete
    await pool.query(`
      UPDATE onboarding_submissions SET
        is_complete = true,
        progress_percentage = 100,
        completed_at = CURRENT_TIMESTAMP,
        business_owner_id = $1
      WHERE id = $2
    `, [businessOwnerId, id]);

    res.json({
      success: true,
      message: 'Submission marked as complete',
      businessOwnerId
    });
  } catch (error) {
    console.error('Error marking submission complete:', error);
    res.status(500).json({ error: 'Failed to mark submission as complete' });
  }
});

// Delete submission
router.delete('/submissions/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM onboarding_submissions WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    res.json({ success: true, message: 'Submission deleted' });
  } catch (error) {
    console.error('Error deleting submission:', error);
    res.status(500).json({ error: 'Failed to delete submission' });
  }
});

// Get onboarding status summary
router.get('/status', async (req, res) => {
  try {
    const pool = req.app.locals.pool;

    const result = await pool.query(`
      SELECT
        onboarding_status as status,
        COUNT(*) as count
      FROM business_owners
      GROUP BY onboarding_status
    `);

    const statusMap = result.rows.reduce((acc, row) => {
      acc[row.status] = parseInt(row.count);
      return acc;
    }, { pending: 0, in_progress: 0, completed: 0 });

    // Also get submission completion stats
    const submissionStats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_complete = true) as complete,
        COUNT(*) FILTER (WHERE is_complete = false) as incomplete
      FROM onboarding_submissions
    `);

    res.json({
      member_status: statusMap,
      submissions: {
        complete: parseInt(submissionStats.rows[0].complete),
        incomplete: parseInt(submissionStats.rows[0].incomplete)
      }
    });
  } catch (error) {
    console.error('Error fetching onboarding status:', error);
    res.status(500).json({ error: 'Failed to fetch onboarding status' });
  }
});

module.exports = router;
