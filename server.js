require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Make pool available to routes
app.locals.pool = pool;

// Middleware
app.use(cors());

// Capture raw body for Slack signature verification
app.use('/api/slack', express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use('/api/slack', express.urlencoded({
  extended: true,
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Regular JSON parsing for other routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API Routes
app.use('/api/members', require('./api/members'));
app.use('/api/team-members', require('./api/team-members'));
app.use('/api/applications', require('./api/applications'));
app.use('/api/onboarding', require('./api/onboarding'));
app.use('/api/webhooks', require('./api/webhooks'));
app.use('/api/import', require('./api/import'));
app.use('/api/stats', require('./api/stats'));
app.use('/api', require('./api/validate'));
app.use('/api/slack', require('./api/slack'));

// Serve admin dashboard
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// Serve public chat interface
app.use(express.static(path.join(__dirname, 'public')));

// Catch-all for admin SPA
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// Catch-all for public SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Run migrations on startup
async function runMigrations() {
  try {
    // Create samcart_orders table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS samcart_orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        samcart_order_id VARCHAR(255) UNIQUE,
        event_type VARCHAR(50) DEFAULT 'order',
        email VARCHAR(255),
        first_name VARCHAR(255),
        last_name VARCHAR(255),
        phone VARCHAR(50),
        product_name VARCHAR(500),
        product_id VARCHAR(255),
        order_total DECIMAL(10, 2),
        currency VARCHAR(10) DEFAULT 'USD',
        status VARCHAR(50) DEFAULT 'completed',
        raw_data JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_samcart_orders_email ON samcart_orders(LOWER(email))`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_samcart_orders_samcart_id ON samcart_orders(samcart_order_id)`);

    // Add missing typeform_applications columns for all 15 questions
    await pool.query(`
      DO $$
      BEGIN
        -- anything_else column (Q14)
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'typeform_applications' AND column_name = 'anything_else') THEN
          ALTER TABLE typeform_applications ADD COLUMN anything_else TEXT;
        END IF;
        -- contact_preference (Q5)
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'typeform_applications' AND column_name = 'contact_preference') THEN
          ALTER TABLE typeform_applications ADD COLUMN contact_preference VARCHAR(100);
        END IF;
        -- revenue_trend (Q8)
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'typeform_applications' AND column_name = 'revenue_trend') THEN
          ALTER TABLE typeform_applications ADD COLUMN revenue_trend VARCHAR(100);
        END IF;
        -- investment_readiness (Q11)
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'typeform_applications' AND column_name = 'investment_readiness') THEN
          ALTER TABLE typeform_applications ADD COLUMN investment_readiness VARCHAR(255);
        END IF;
        -- decision_timeline (Q12)
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'typeform_applications' AND column_name = 'decision_timeline') THEN
          ALTER TABLE typeform_applications ADD COLUMN decision_timeline VARCHAR(100);
        END IF;
        -- referral_source (Q15)
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'typeform_applications' AND column_name = 'referral_source') THEN
          ALTER TABLE typeform_applications ADD COLUMN referral_source VARCHAR(255);
        END IF;
      END $$
    `);

    // Change has_team from BOOLEAN to VARCHAR if needed
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'typeform_applications' AND column_name = 'has_team' AND data_type = 'boolean'
        ) THEN
          ALTER TABLE typeform_applications ALTER COLUMN has_team TYPE VARCHAR(255) USING CASE WHEN has_team THEN 'Yes' ELSE 'No' END;
        END IF;
      END $$
    `);

    console.log('Database migrations completed');
  } catch (error) {
    console.error('Migration error:', error);
  }
}

// Start server
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Chat interface: http://localhost:${PORT}`);
  console.log(`Admin dashboard: http://localhost:${PORT}/admin`);

  // Run migrations after server starts
  await runMigrations();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await pool.end();
  process.exit(0);
});
