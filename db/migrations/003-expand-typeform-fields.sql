-- Migration: Expand Typeform application fields to capture all 15 questions
-- Run this on existing databases to add missing columns

-- Change has_team from BOOLEAN to VARCHAR to store the actual choice text
ALTER TABLE typeform_applications
ALTER COLUMN has_team TYPE VARCHAR(255) USING CASE WHEN has_team THEN 'Yes' ELSE 'No' END;

-- Add anything_else column if it doesn't exist (Q14: Is there anything else I should know)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'typeform_applications' AND column_name = 'anything_else') THEN
        ALTER TABLE typeform_applications ADD COLUMN anything_else TEXT;
    END IF;
END $$;

-- Make sure all columns exist with correct types
DO $$
BEGIN
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
END $$;
