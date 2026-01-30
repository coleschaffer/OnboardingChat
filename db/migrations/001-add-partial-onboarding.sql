-- Migration: Add partial onboarding support
-- Run this if you already have the initial schema

-- Add progress tracking to business_owners
ALTER TABLE business_owners
ADD COLUMN IF NOT EXISTS onboarding_progress INTEGER DEFAULT 0 CHECK (onboarding_progress >= 0 AND onboarding_progress <= 100);

ALTER TABLE business_owners
ADD COLUMN IF NOT EXISTS last_question_answered VARCHAR(100);

-- Add fields to onboarding_submissions for partial saves
ALTER TABLE onboarding_submissions
ADD COLUMN IF NOT EXISTS session_id VARCHAR(255) UNIQUE;

ALTER TABLE onboarding_submissions
ADD COLUMN IF NOT EXISTS progress_percentage INTEGER DEFAULT 0;

ALTER TABLE onboarding_submissions
ADD COLUMN IF NOT EXISTS last_question VARCHAR(100);

ALTER TABLE onboarding_submissions
ADD COLUMN IF NOT EXISTS is_complete BOOLEAN DEFAULT FALSE;

ALTER TABLE onboarding_submissions
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_onboarding_submissions_session ON onboarding_submissions(session_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_submissions_complete ON onboarding_submissions(is_complete);
CREATE INDEX IF NOT EXISTS idx_business_owners_progress ON business_owners(onboarding_progress);

-- Add trigger for onboarding_submissions updated_at
DROP TRIGGER IF EXISTS update_onboarding_submissions_updated_at ON onboarding_submissions;
CREATE TRIGGER update_onboarding_submissions_updated_at
    BEFORE UPDATE ON onboarding_submissions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Update existing business_owners from CSV imports to be marked as complete
UPDATE business_owners
SET onboarding_progress = 100, onboarding_status = 'completed'
WHERE source = 'csv_import';

-- Update existing completed onboarding_submissions
UPDATE onboarding_submissions
SET is_complete = TRUE, progress_percentage = 100
WHERE completed_at IS NOT NULL;
