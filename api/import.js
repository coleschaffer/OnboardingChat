const express = require('express');
const router = express.Router();
const multer = require('multer');
const { parse } = require('csv-parse');
const { Readable } = require('stream');

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

// Import business owners from CSV
router.post('/business-owners', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const pool = req.app.locals.pool;
  const records = [];
  const errors = [];
  let imported = 0;

  try {
    // Parse CSV
    const parser = Readable.from(req.file.buffer).pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        trim: true
      })
    );

    for await (const row of parser) {
      records.push(row);
    }

    // Process each record
    for (let i = 0; i < records.length; i++) {
      const row = records[i];

      try {
        // Map CSV columns to database fields
        // These column names match the Google Form CSV export
        const firstName = row['Business Owner First Name'] || '';
        const lastName = row['Business Owner Last Name'] || '';
        const email = row['Business Owner Best Email Address \n(For Communications and Important Updates)'] ||
                      row['Business Owner Best Email Address'] || '';
        const businessName = row["What's The Name of Your Business?"] || '';
        const businessOverview = row['Please Provide an Overview Of Your Business '] ||
                                  row['Please Provide an Overview Of Your Business'] || '';
        const annualRevenue = row["What's The Current Annual Revenue of Your Business?"] || '';
        const teamCount = row['How Many Team Members Do You Have?'] || '';
        const trafficSources = row['What Traffic Sources Do You Typically Employ to Acquire Customers?'] || '';
        const landingPages = row['Please Link All Relevant Landing Pages or Product Pages for Your Brand/Offer(s). \nFeel Free to Also Link to Any Ads or Creative Assets as Well.'] ||
                             row['Please Link All Relevant Landing Pages'] || '';
        const painPoint = row['What Is The #1 Pain Point For You In Your Business Right Now? '] ||
                          row['What Is The #1 Pain Point For You In Your Business Right Now?'] || '';
        const massiveWin = row['What Is The #1 Thing That, If CA PRO Were To Help You, It Would Be A Massive Win?'] || '';
        const aiSkillLevel = row['On a Scale of 1 to 10, how would you rate your business\' knowledge and skill level when it comes to leveraging AI for writing copy, launching funnels, and automating marketing processes?\n'] ||
                              row['AI Skill Level'] || '';

        if (!email) {
          errors.push({ row: i + 2, error: 'Missing email address' });
          continue;
        }

        // Check if email already exists
        const existing = await pool.query(
          'SELECT id FROM business_owners WHERE email = $1',
          [email.toLowerCase().trim()]
        );

        if (existing.rows.length > 0) {
          // Update existing record - mark as complete since CSV data is final
          await pool.query(`
            UPDATE business_owners SET
              first_name = COALESCE(NULLIF($1, ''), first_name),
              last_name = COALESCE(NULLIF($2, ''), last_name),
              business_name = COALESCE(NULLIF($3, ''), business_name),
              business_overview = COALESCE(NULLIF($4, ''), business_overview),
              annual_revenue = COALESCE(NULLIF($5, ''), annual_revenue),
              team_count = COALESCE(NULLIF($6, ''), team_count),
              traffic_sources = COALESCE(NULLIF($7, ''), traffic_sources),
              landing_pages = COALESCE(NULLIF($8, ''), landing_pages),
              pain_point = COALESCE(NULLIF($9, ''), pain_point),
              massive_win = COALESCE(NULLIF($10, ''), massive_win),
              ai_skill_level = COALESCE(NULLIF($11::int, 0), ai_skill_level),
              onboarding_status = 'completed',
              onboarding_progress = 100
            WHERE email = $12
          `, [
            firstName,
            lastName,
            businessName,
            businessOverview,
            annualRevenue,
            teamCount,
            trafficSources,
            landingPages,
            painPoint,
            massiveWin,
            parseInt(aiSkillLevel) || null,
            email.toLowerCase().trim()
          ]);
        } else {
          // Insert new record - mark as complete since CSV data is final
          await pool.query(`
            INSERT INTO business_owners (
              first_name, last_name, email, business_name, business_overview,
              annual_revenue, team_count, traffic_sources, landing_pages,
              pain_point, massive_win, ai_skill_level, source, onboarding_status, onboarding_progress
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          `, [
            firstName,
            lastName,
            email.toLowerCase().trim(),
            businessName,
            businessOverview,
            annualRevenue,
            teamCount,
            trafficSources,
            landingPages,
            painPoint,
            massiveWin,
            parseInt(aiSkillLevel) || null,
            'csv_import',
            'completed',
            100
          ]);
        }

        imported++;
      } catch (err) {
        errors.push({ row: i + 2, error: err.message });
      }
    }

    // Log import history
    await pool.query(`
      INSERT INTO import_history (filename, import_type, records_imported, records_failed, errors)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      req.file.originalname,
      'business_owners',
      imported,
      errors.length,
      JSON.stringify(errors)
    ]);

    // Log activity
    await pool.query(`
      INSERT INTO activity_log (action, entity_type, entity_id, details)
      VALUES ($1, $2, $3, $4)
    `, ['csv_import', 'import', null, JSON.stringify({
      filename: req.file.originalname,
      type: 'business_owners',
      imported,
      failed: errors.length
    })]);

    res.json({
      success: true,
      total: records.length,
      imported,
      failed: errors.length,
      errors: errors.slice(0, 10) // Return first 10 errors
    });
  } catch (error) {
    console.error('Error importing business owners:', error);
    res.status(500).json({ error: 'Failed to import CSV' });
  }
});

// Import team members from CSV
router.post('/team-members', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const pool = req.app.locals.pool;
  const records = [];
  const errors = [];
  let imported = 0;

  try {
    // Parse CSV
    const parser = Readable.from(req.file.buffer).pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        trim: true
      })
    );

    for await (const row of parser) {
      records.push(row);
    }

    // Process each record
    for (let i = 0; i < records.length; i++) {
      const row = records[i];

      try {
        // Map CSV columns to database fields
        const firstName = row['Your First Name'] || '';
        const lastName = row['Your Last Name'] || '';
        const email = row['Your Best Email Address \n(For Communications and Important Updates)'] ||
                      row['Your Best Email Address'] || '';
        const title = row["What's Your Title/Role In The Business?"] || '';
        const businessSummary = row['Please Provide a Summary of The Business You Work For (As You Understand It). What do you sell? Who do you serve? How is the business doing? What are the big opportunities? '] ||
                                row['Business Summary'] || '';
        const responsibilities = row['What Are Your Primary Roles and Responsibilities Within The Business \n(Be As Specific As You Can)'] ||
                                  row['Responsibilities'] || '';
        const copywritingSkill = row['How Would You Rate Your Copywriting Skills On A Scale From 1-10 \n(With 1 Being Terrible and 10 Being Perfect) '] ||
                                  row['Copywriting Skill'] || '';
        const croSkill = row['How Would You Rate Your Knowledge On CRO (Conversion Rate Optimization) On A Scale From 1-10. \n(1 = Terrible and 10 = I\'m The Best Ever)'] ||
                          row['CRO Skill'] || '';
        const aiSkill = row['How Would You Rate Your Knowledge and Skillset Around Leveraging AI In Copywriting and Marketing Currently? '] ||
                        row['AI Skill'] || '';

        if (!email) {
          errors.push({ row: i + 2, error: 'Missing email address' });
          continue;
        }

        // Check if team member already exists
        const existing = await pool.query(
          'SELECT id FROM team_members WHERE email = $1',
          [email.toLowerCase().trim()]
        );

        if (existing.rows.length > 0) {
          // Update existing record
          await pool.query(`
            UPDATE team_members SET
              first_name = COALESCE(NULLIF($1, ''), first_name),
              last_name = COALESCE(NULLIF($2, ''), last_name),
              title = COALESCE(NULLIF($3, ''), title),
              business_summary = COALESCE(NULLIF($4, ''), business_summary),
              responsibilities = COALESCE(NULLIF($5, ''), responsibilities),
              copywriting_skill = COALESCE(NULLIF($6::int, 0), copywriting_skill),
              cro_skill = COALESCE(NULLIF($7::int, 0), cro_skill),
              ai_skill = COALESCE(NULLIF($8::int, 0), ai_skill)
            WHERE email = $9
          `, [
            firstName,
            lastName,
            title,
            businessSummary,
            responsibilities,
            parseInt(copywritingSkill) || null,
            parseInt(croSkill) || null,
            parseInt(aiSkill) || null,
            email.toLowerCase().trim()
          ]);
        } else {
          // Insert new record
          await pool.query(`
            INSERT INTO team_members (
              first_name, last_name, email, title, role, business_summary,
              responsibilities, copywriting_skill, cro_skill, ai_skill, source
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `, [
            firstName,
            lastName,
            email.toLowerCase().trim(),
            title,
            title, // Use title as role too
            businessSummary,
            responsibilities,
            parseInt(copywritingSkill) || null,
            parseInt(croSkill) || null,
            parseInt(aiSkill) || null,
            'csv_import'
          ]);
        }

        imported++;
      } catch (err) {
        errors.push({ row: i + 2, error: err.message });
      }
    }

    // Log import history
    await pool.query(`
      INSERT INTO import_history (filename, import_type, records_imported, records_failed, errors)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      req.file.originalname,
      'team_members',
      imported,
      errors.length,
      JSON.stringify(errors)
    ]);

    // Log activity
    await pool.query(`
      INSERT INTO activity_log (action, entity_type, entity_id, details)
      VALUES ($1, $2, $3, $4)
    `, ['csv_import', 'import', null, JSON.stringify({
      filename: req.file.originalname,
      type: 'team_members',
      imported,
      failed: errors.length
    })]);

    res.json({
      success: true,
      total: records.length,
      imported,
      failed: errors.length,
      errors: errors.slice(0, 10)
    });
  } catch (error) {
    console.error('Error importing team members:', error);
    res.status(500).json({ error: 'Failed to import CSV' });
  }
});

// Get import history
router.get('/history', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { limit = 20, offset = 0 } = req.query;

    const result = await pool.query(`
      SELECT * FROM import_history
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `, [parseInt(limit), parseInt(offset)]);

    const countResult = await pool.query('SELECT COUNT(*) FROM import_history');

    res.json({
      imports: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Error fetching import history:', error);
    res.status(500).json({ error: 'Failed to fetch import history' });
  }
});

module.exports = router;
