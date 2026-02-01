-- Migration: Add Monday.com sync tracking columns
-- Run this against your PostgreSQL database

-- Add columns to onboarding_submissions for Monday sync scheduling
ALTER TABLE onboarding_submissions
ADD COLUMN IF NOT EXISTS monday_sync_scheduled_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS monday_synced BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS monday_synced_at TIMESTAMP WITH TIME ZONE;

-- Add index for efficient querying of pending Monday syncs
CREATE INDEX IF NOT EXISTS idx_onboarding_submissions_monday_sync
ON onboarding_submissions(monday_sync_scheduled_at, monday_synced)
WHERE monday_synced = FALSE AND monday_sync_scheduled_at IS NOT NULL;

-- Comment for documentation
COMMENT ON COLUMN onboarding_submissions.monday_sync_scheduled_at IS 'When the Monday.com sync should run (10 mins after completion)';
COMMENT ON COLUMN onboarding_submissions.monday_synced IS 'Whether team members and partners have been synced to Monday.com';
COMMENT ON COLUMN onboarding_submissions.monday_synced_at IS 'When the Monday.com sync completed';
