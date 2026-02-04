-- Add purchased_at timestamp to typeform_applications
-- This is set when a SamCart purchase matches the applicant's email

ALTER TABLE typeform_applications ADD COLUMN IF NOT EXISTS purchased_at TIMESTAMP WITH TIME ZONE;
