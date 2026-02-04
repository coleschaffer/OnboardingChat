-- Add sending_message_ts column to track the "Sending..." message for deletion
ALTER TABLE pending_email_sends ADD COLUMN IF NOT EXISTS sending_message_ts VARCHAR(255);
