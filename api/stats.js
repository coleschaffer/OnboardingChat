const express = require('express');
const router = express.Router();

// Get dashboard statistics
router.get('/', async (req, res) => {
  try {
    const pool = req.app.locals.pool;

    // Get total counts
    const membersCount = await pool.query('SELECT COUNT(*) FROM business_owners');
    const teamMembersCount = await pool.query('SELECT COUNT(*) FROM team_members');
    const applicationsCount = await pool.query('SELECT COUNT(*) FROM typeform_applications');

    // Get pending onboardings
    const pendingOnboardings = await pool.query(
      "SELECT COUNT(*) FROM business_owners WHERE onboarding_status != 'completed'"
    );

    // Get new applications in last 7 days
    const recentApplications = await pool.query(
      "SELECT COUNT(*) FROM typeform_applications WHERE created_at > NOW() - INTERVAL '7 days'"
    );

    // Get onboarding status breakdown
    const onboardingStatus = await pool.query(`
      SELECT onboarding_status as status, COUNT(*) as count
      FROM business_owners
      GROUP BY onboarding_status
    `);

    // Get application status breakdown
    const applicationStatus = await pool.query(`
      SELECT status, COUNT(*) as count
      FROM typeform_applications
      GROUP BY status
    `);

    // Get count of truly new applications (new status AND no matching onboarding)
    const trulyNewApplications = await pool.query(`
      SELECT COUNT(*) as count
      FROM typeform_applications ta
      WHERE ta.status = 'new'
        AND NOT EXISTS (
          SELECT 1 FROM onboarding_submissions os
          JOIN business_owners bo ON os.business_owner_id = bo.id
          WHERE LOWER(bo.email) = LOWER(ta.email)
        )
    `);

    // Get source breakdown
    const sourceBreakdown = await pool.query(`
      SELECT source, COUNT(*) as count
      FROM business_owners
      GROUP BY source
    `);

    // Get recent activity
    const recentActivity = await pool.query(`
      SELECT * FROM activity_log
      ORDER BY created_at DESC
      LIMIT 10
    `);

    // Get members added over time (last 30 days)
    const membersTimeline = await pool.query(`
      SELECT
        DATE(created_at) as date,
        COUNT(*) as count
      FROM business_owners
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date
    `);

    // Get revenue tier distribution
    const revenueTiers = await pool.query(`
      SELECT annual_revenue, COUNT(*) as count
      FROM business_owners
      WHERE annual_revenue IS NOT NULL AND annual_revenue != ''
      GROUP BY annual_revenue
      ORDER BY count DESC
      LIMIT 10
    `);

    res.json({
      totals: {
        members: parseInt(membersCount.rows[0].count),
        team_members: parseInt(teamMembersCount.rows[0].count),
        applications: parseInt(applicationsCount.rows[0].count),
        pending_onboardings: parseInt(pendingOnboardings.rows[0].count),
        recent_applications: parseInt(recentApplications.rows[0].count)
      },
      onboarding_status: onboardingStatus.rows.reduce((acc, row) => {
        acc[row.status] = parseInt(row.count);
        return acc;
      }, {}),
      application_status: applicationStatus.rows.reduce((acc, row) => {
        acc[row.status] = parseInt(row.count);
        return acc;
      }, {}),
      truly_new_applications: parseInt(trulyNewApplications.rows[0].count),
      source_breakdown: sourceBreakdown.rows.reduce((acc, row) => {
        acc[row.source] = parseInt(row.count);
        return acc;
      }, {}),
      recent_activity: recentActivity.rows,
      members_timeline: membersTimeline.rows,
      revenue_tiers: revenueTiers.rows
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Get activity feed
router.get('/activity', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { limit = 20, offset = 0 } = req.query;

    const result = await pool.query(`
      SELECT * FROM activity_log
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `, [parseInt(limit), parseInt(offset)]);

    const countResult = await pool.query('SELECT COUNT(*) FROM activity_log');

    res.json({
      activities: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Error fetching activity:', error);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

module.exports = router;
