-- Migration: Expand column lengths to handle longer field values
-- Run this to fix import errors from CSV data

-- Expand phone columns (some phone numbers have extensions or formatting)
ALTER TABLE business_owners ALTER COLUMN phone TYPE VARCHAR(100);
ALTER TABLE team_members ALTER COLUMN phone TYPE VARCHAR(100);
ALTER TABLE c_level_partners ALTER COLUMN phone TYPE VARCHAR(100);

-- Expand team_count (some entries are descriptive like "5 full time, 3 contractors")
ALTER TABLE business_owners ALTER COLUMN team_count TYPE VARCHAR(255);

-- Expand annual_revenue (some entries are descriptive)
ALTER TABLE business_owners ALTER COLUMN annual_revenue TYPE VARCHAR(255);
ALTER TABLE typeform_applications ALTER COLUMN annual_revenue TYPE VARCHAR(255);

-- Expand whatsapp_number
ALTER TABLE business_owners ALTER COLUMN whatsapp_number TYPE VARCHAR(100);
