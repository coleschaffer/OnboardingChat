#!/usr/bin/env node

// CLI script for importing CSV files into the database
// Usage: node db/import.js [--business-owners <file>] [--team-members <file>]

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { parse } = require('csv-parse/sync');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function importBusinessOwners(filePath) {
  console.log(`\nImporting business owners from: ${filePath}`);

  const content = fs.readFileSync(filePath, 'utf-8');
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

  console.log(`Found ${records.length} records`);

  let imported = 0;
  let updated = 0;
  let errors = 0;

  for (let i = 0; i < records.length; i++) {
    const row = records[i];

    try {
      // Map columns - handle various column name formats
      const firstName = row['Business Owner First Name'] || '';
      const lastName = row['Business Owner Last Name'] || '';

      // Handle email column with newline in header
      let email = '';
      for (const key of Object.keys(row)) {
        if (key.includes('Email Address') || key.includes('email')) {
          email = row[key];
          break;
        }
      }

      const businessName = row["What's The Name of Your Business?"] || '';

      // Handle overview column
      let businessOverview = '';
      for (const key of Object.keys(row)) {
        if (key.includes('Overview Of Your Business')) {
          businessOverview = row[key];
          break;
        }
      }

      const annualRevenue = row["What's The Current Annual Revenue of Your Business?"] || '';
      const teamCount = row['How Many Team Members Do You Have?'] || '';
      const trafficSources = row['What Traffic Sources Do You Typically Employ to Acquire Customers?'] || '';

      // Handle landing pages column
      let landingPages = '';
      for (const key of Object.keys(row)) {
        if (key.includes('Landing Pages') || key.includes('Product Pages')) {
          landingPages = row[key];
          break;
        }
      }

      // Handle pain point column
      let painPoint = '';
      for (const key of Object.keys(row)) {
        if (key.includes('Pain Point')) {
          painPoint = row[key];
          break;
        }
      }

      // Handle massive win column
      let massiveWin = '';
      for (const key of Object.keys(row)) {
        if (key.includes('Massive Win')) {
          massiveWin = row[key];
          break;
        }
      }

      // Handle AI skill level column
      let aiSkillLevel = null;
      for (const key of Object.keys(row)) {
        if (key.includes('Scale of 1 to 10') || key.includes('AI')) {
          const val = parseInt(row[key]);
          if (!isNaN(val) && val >= 1 && val <= 10) {
            aiSkillLevel = val;
          }
          break;
        }
      }

      if (!email) {
        console.log(`  Row ${i + 2}: Skipped (no email)`);
        errors++;
        continue;
      }

      email = email.toLowerCase().trim();

      // Check if exists
      const existing = await pool.query(
        'SELECT id FROM business_owners WHERE email = $1',
        [email]
      );

      if (existing.rows.length > 0) {
        // Update - mark as complete since CSV data is final
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
            ai_skill_level = COALESCE($11, ai_skill_level),
            onboarding_status = 'completed',
            onboarding_progress = 100
          WHERE email = $12
        `, [
          firstName, lastName, businessName, businessOverview,
          annualRevenue, teamCount, trafficSources, landingPages,
          painPoint, massiveWin, aiSkillLevel, email
        ]);
        updated++;
      } else {
        // Insert - mark as complete since CSV data is final
        await pool.query(`
          INSERT INTO business_owners (
            first_name, last_name, email, business_name, business_overview,
            annual_revenue, team_count, traffic_sources, landing_pages,
            pain_point, massive_win, ai_skill_level, source, onboarding_status, onboarding_progress
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        `, [
          firstName, lastName, email, businessName, businessOverview,
          annualRevenue, teamCount, trafficSources, landingPages,
          painPoint, massiveWin, aiSkillLevel, 'csv_import', 'completed', 100
        ]);
        imported++;
      }
    } catch (err) {
      console.log(`  Row ${i + 2}: Error - ${err.message}`);
      errors++;
    }
  }

  console.log(`\nBusiness Owners Import Complete:`);
  console.log(`  Imported: ${imported}`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Errors: ${errors}`);

  // Log to database
  await pool.query(`
    INSERT INTO import_history (filename, import_type, records_imported, records_failed)
    VALUES ($1, $2, $3, $4)
  `, [path.basename(filePath), 'business_owners', imported + updated, errors]);
}

async function importTeamMembers(filePath) {
  console.log(`\nImporting team members from: ${filePath}`);

  const content = fs.readFileSync(filePath, 'utf-8');
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

  console.log(`Found ${records.length} records`);

  let imported = 0;
  let updated = 0;
  let errors = 0;

  for (let i = 0; i < records.length; i++) {
    const row = records[i];

    try {
      const firstName = row['Your First Name'] || '';
      const lastName = row['Your Last Name'] || '';

      // Handle email column
      let email = '';
      for (const key of Object.keys(row)) {
        if (key.includes('Email Address') || key.includes('email')) {
          email = row[key];
          break;
        }
      }

      // Handle title/role column
      let title = '';
      for (const key of Object.keys(row)) {
        if (key.includes('Title') || key.includes('Role')) {
          title = row[key];
          break;
        }
      }

      // Handle business summary
      let businessSummary = '';
      for (const key of Object.keys(row)) {
        if (key.includes('Summary of The Business')) {
          businessSummary = row[key];
          break;
        }
      }

      // Handle responsibilities
      let responsibilities = '';
      for (const key of Object.keys(row)) {
        if (key.includes('Responsibilities')) {
          responsibilities = row[key];
          break;
        }
      }

      // Handle skill ratings
      let copywritingSkill = null;
      let croSkill = null;
      let aiSkill = null;

      for (const key of Object.keys(row)) {
        const val = parseInt(row[key]);
        if (isNaN(val) || val < 1 || val > 10) continue;

        if (key.includes('Copywriting')) copywritingSkill = val;
        else if (key.includes('CRO')) croSkill = val;
        else if (key.includes('AI')) aiSkill = val;
      }

      if (!email) {
        console.log(`  Row ${i + 2}: Skipped (no email)`);
        errors++;
        continue;
      }

      email = email.toLowerCase().trim();

      // Check if exists
      const existing = await pool.query(
        'SELECT id FROM team_members WHERE email = $1',
        [email]
      );

      if (existing.rows.length > 0) {
        // Update
        await pool.query(`
          UPDATE team_members SET
            first_name = COALESCE(NULLIF($1, ''), first_name),
            last_name = COALESCE(NULLIF($2, ''), last_name),
            title = COALESCE(NULLIF($3, ''), title),
            role = COALESCE(NULLIF($3, ''), role),
            business_summary = COALESCE(NULLIF($4, ''), business_summary),
            responsibilities = COALESCE(NULLIF($5, ''), responsibilities),
            copywriting_skill = COALESCE($6, copywriting_skill),
            cro_skill = COALESCE($7, cro_skill),
            ai_skill = COALESCE($8, ai_skill)
          WHERE email = $9
        `, [
          firstName, lastName, title, businessSummary, responsibilities,
          copywritingSkill, croSkill, aiSkill, email
        ]);
        updated++;
      } else {
        // Insert
        await pool.query(`
          INSERT INTO team_members (
            first_name, last_name, email, title, role, business_summary,
            responsibilities, copywriting_skill, cro_skill, ai_skill, source
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          firstName, lastName, email, title, title, businessSummary,
          responsibilities, copywritingSkill, croSkill, aiSkill, 'csv_import'
        ]);
        imported++;
      }
    } catch (err) {
      console.log(`  Row ${i + 2}: Error - ${err.message}`);
      errors++;
    }
  }

  console.log(`\nTeam Members Import Complete:`);
  console.log(`  Imported: ${imported}`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Errors: ${errors}`);

  // Log to database
  await pool.query(`
    INSERT INTO import_history (filename, import_type, records_imported, records_failed)
    VALUES ($1, $2, $3, $4)
  `, [path.basename(filePath), 'team_members', imported + updated, errors]);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('CA Pro CSV Import Tool');
    console.log('');
    console.log('Usage:');
    console.log('  node db/import.js --business-owners <file.csv>');
    console.log('  node db/import.js --team-members <file.csv>');
    console.log('  node db/import.js --all   # Import default CSV files in project root');
    console.log('');
    process.exit(0);
  }

  try {
    // Test database connection
    await pool.query('SELECT 1');
    console.log('Database connected successfully');

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === '--business-owners' && args[i + 1]) {
        await importBusinessOwners(args[i + 1]);
        i++;
      } else if (arg === '--team-members' && args[i + 1]) {
        await importTeamMembers(args[i + 1]);
        i++;
      } else if (arg === '--all') {
        // Import default files
        const boFile = 'CA PRO New Member Onboarding Form (Business Owner) (Responses) - Form Responses 1.csv';
        const tmFile = 'CA PRO New Member Onboarding Form (Team Members) (Responses) - Form Responses 1.csv';

        if (fs.existsSync(boFile)) {
          await importBusinessOwners(boFile);
        }
        if (fs.existsSync(tmFile)) {
          await importTeamMembers(tmFile);
        }
      }
    }

    console.log('\nImport complete!');
  } catch (error) {
    console.error('Import failed:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
