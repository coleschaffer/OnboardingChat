-- Migration 007: Email Threads, Slack Threading, Calendly, Notes, and Status Tracking
-- For CA Pro onboarding flow enhancements

-- Email Threads table for tracking Gmail conversations
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
);

CREATE INDEX IF NOT EXISTS idx_email_threads_gmail_thread ON email_threads(gmail_thread_id);
CREATE INDEX IF NOT EXISTS idx_email_threads_typeform ON email_threads(typeform_application_id);
CREATE INDEX IF NOT EXISTS idx_email_threads_status ON email_threads(status);
CREATE INDEX IF NOT EXISTS idx_email_threads_has_reply ON email_threads(has_reply) WHERE has_reply = FALSE;

-- Add Slack thread tracking to typeform_applications
ALTER TABLE typeform_applications ADD COLUMN IF NOT EXISTS slack_channel_id VARCHAR(50);
ALTER TABLE typeform_applications ADD COLUMN IF NOT EXISTS slack_thread_ts VARCHAR(50);

-- Add status timestamp columns to typeform_applications
ALTER TABLE typeform_applications ADD COLUMN IF NOT EXISTS emailed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE typeform_applications ADD COLUMN IF NOT EXISTS replied_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE typeform_applications ADD COLUMN IF NOT EXISTS call_booked_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE typeform_applications ADD COLUMN IF NOT EXISTS onboarding_started_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE typeform_applications ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMP WITH TIME ZONE;

-- Pending email sends for 30-second undo feature
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
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'cancelled', 'sent', 'failed')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    cancelled_at TIMESTAMP WITH TIME ZONE,
    sent_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_email_sends_status ON pending_email_sends(status);
CREATE INDEX IF NOT EXISTS idx_pending_email_sends_send_at ON pending_email_sends(send_at) WHERE status = 'pending';

-- Application notes table
CREATE TABLE IF NOT EXISTS application_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID REFERENCES typeform_applications(id) ON DELETE CASCADE,
    note_text TEXT NOT NULL,
    created_by VARCHAR(255) DEFAULT 'admin',
    slack_synced BOOLEAN DEFAULT FALSE,
    slack_message_ts VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_application_notes_application ON application_notes(application_id);
CREATE INDEX IF NOT EXISTS idx_application_notes_created ON application_notes(created_at DESC);

-- Calendly webhook subscriptions (stores signing key)
CREATE TABLE IF NOT EXISTS calendly_webhook_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_uri VARCHAR(500) NOT NULL,
    signing_key VARCHAR(255) NOT NULL,
    organization_uri VARCHAR(500),
    scope VARCHAR(50),
    state VARCHAR(50) DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
