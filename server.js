require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const { initializeWebhook: initializeCalendlyWebhook } = require('./lib/calendly');

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

// Capture raw body for Calendly webhook signature verification
app.use('/api/webhooks/calendly', express.json({
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
app.use('/api/webhooks/calendly', require('./api/calendly'));
app.use('/api/import', require('./api/import'));
app.use('/api/stats', require('./api/stats'));
app.use('/api', require('./api/validate'));
app.use('/api/slack', require('./api/slack'));
app.use('/api/jobs', require('./api/jobs'));
app.use('/api/notes', require('./api/notes'));

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

    // Add welcome_sent columns to samcart_orders for delayed welcome feature
    await pool.query(`
      DO $$
      BEGIN
        -- welcome_sent flag (false until welcome message sent to Slack)
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'samcart_orders' AND column_name = 'welcome_sent') THEN
          ALTER TABLE samcart_orders ADD COLUMN welcome_sent BOOLEAN DEFAULT false;
          -- Mark all existing orders as welcome_sent = true so they don't get processed
          UPDATE samcart_orders SET welcome_sent = true WHERE welcome_sent IS NULL;
        END IF;
        -- welcome_sent_at timestamp (when welcome was sent)
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'samcart_orders' AND column_name = 'welcome_sent_at') THEN
          ALTER TABLE samcart_orders ADD COLUMN welcome_sent_at TIMESTAMP WITH TIME ZONE;
        END IF;
      END $$
    `);

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

    // Add Slack thread columns to samcart_orders (for welcome message editing)
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'samcart_orders' AND column_name = 'slack_channel_id') THEN
          ALTER TABLE samcart_orders ADD COLUMN slack_channel_id VARCHAR(50);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'samcart_orders' AND column_name = 'slack_thread_ts') THEN
          ALTER TABLE samcart_orders ADD COLUMN slack_thread_ts VARCHAR(50);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'samcart_orders' AND column_name = 'welcome_note_message_ts') THEN
          ALTER TABLE samcart_orders ADD COLUMN welcome_note_message_ts VARCHAR(50);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'samcart_orders' AND column_name = 'welcome_message_ts') THEN
          ALTER TABLE samcart_orders ADD COLUMN welcome_message_ts VARCHAR(50);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'samcart_orders' AND column_name = 'typeform_message_ts') THEN
          ALTER TABLE samcart_orders ADD COLUMN typeform_message_ts VARCHAR(50);
        END IF;
      END $$
    `);

    // Migration 007: Email threads, Slack threading, Calendly, Notes
    // Email threads table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_threads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        gmail_thread_id VARCHAR(255) UNIQUE,
        gmail_message_id VARCHAR(255),
        typeform_application_id UUID REFERENCES typeform_applications(id),
        recipient_email VARCHAR(255) NOT NULL,
        recipient_first_name VARCHAR(255),
        subject VARCHAR(500),
        initial_email_sent_at TIMESTAMP WITH TIME ZONE,
        has_reply BOOLEAN DEFAULT FALSE,
        reply_received_at TIMESTAMP WITH TIME ZONE,
        reply_count INTEGER DEFAULT 0,
        last_reply_snippet TEXT,
        last_reply_body TEXT,
        status VARCHAR(50) DEFAULT 'sent',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_threads_gmail_thread ON email_threads(gmail_thread_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_threads_typeform ON email_threads(typeform_application_id)`);

    // Pending email sends table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pending_email_sends (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        to_email VARCHAR(255) NOT NULL,
        subject VARCHAR(500),
        body TEXT NOT NULL,
        gmail_thread_id VARCHAR(255),
        typeform_application_id UUID REFERENCES typeform_applications(id),
        user_id VARCHAR(50) NOT NULL,
        channel_id VARCHAR(50) NOT NULL,
        thread_ts VARCHAR(50),
        message_ts VARCHAR(50),
        send_at TIMESTAMP WITH TIME ZONE NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        cancelled_at TIMESTAMP WITH TIME ZONE,
        sent_at TIMESTAMP WITH TIME ZONE,
        error_message TEXT
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pending_email_sends_status ON pending_email_sends(status)`);

    // Application notes table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS application_notes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        application_id UUID REFERENCES typeform_applications(id) ON DELETE CASCADE,
        note_text TEXT NOT NULL,
        created_by VARCHAR(255) DEFAULT 'admin',
        slack_synced BOOLEAN DEFAULT FALSE,
        slack_message_ts VARCHAR(50),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_application_notes_application ON application_notes(application_id)`);

    // Calendly webhook subscriptions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS calendly_webhook_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        webhook_uri VARCHAR(500) NOT NULL,
        signing_key VARCHAR(255) NOT NULL,
        organization_uri VARCHAR(500),
        scope VARCHAR(50),
        state VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add new columns to typeform_applications
    await pool.query(`
      DO $$
      BEGIN
        -- Slack thread tracking
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'typeform_applications' AND column_name = 'slack_channel_id') THEN
          ALTER TABLE typeform_applications ADD COLUMN slack_channel_id VARCHAR(50);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'typeform_applications' AND column_name = 'slack_thread_ts') THEN
          ALTER TABLE typeform_applications ADD COLUMN slack_thread_ts VARCHAR(50);
        END IF;
        -- Status timestamps
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'typeform_applications' AND column_name = 'emailed_at') THEN
          ALTER TABLE typeform_applications ADD COLUMN emailed_at TIMESTAMP WITH TIME ZONE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'typeform_applications' AND column_name = 'replied_at') THEN
          ALTER TABLE typeform_applications ADD COLUMN replied_at TIMESTAMP WITH TIME ZONE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'typeform_applications' AND column_name = 'call_booked_at') THEN
          ALTER TABLE typeform_applications ADD COLUMN call_booked_at TIMESTAMP WITH TIME ZONE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'typeform_applications' AND column_name = 'onboarding_started_at') THEN
          ALTER TABLE typeform_applications ADD COLUMN onboarding_started_at TIMESTAMP WITH TIME ZONE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'typeform_applications' AND column_name = 'onboarding_completed_at') THEN
          ALTER TABLE typeform_applications ADD COLUMN onboarding_completed_at TIMESTAMP WITH TIME ZONE;
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

  // Initialize Calendly webhook subscription
  initializeCalendlyWebhook(pool).catch(err => {
    console.error('Failed to initialize Calendly webhook:', err.message);
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await pool.end();
  process.exit(0);
});
