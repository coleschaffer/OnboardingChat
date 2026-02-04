-- CA Pro Onboarding Database Schema
-- Run this against your PostgreSQL database to set up the tables

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
-- gen_random_uuid() is used by runtime-created tables (server.js runMigrations)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Business Owners table
CREATE TABLE IF NOT EXISTS business_owners (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    email VARCHAR(255) UNIQUE,
    phone VARCHAR(100),
    business_name VARCHAR(255),
    business_overview TEXT,
    annual_revenue VARCHAR(255),
    team_count VARCHAR(255),
    traffic_sources TEXT,
    landing_pages TEXT,
    pain_point TEXT,
    massive_win TEXT,
    ai_skill_level INTEGER CHECK (ai_skill_level >= 1 AND ai_skill_level <= 10),
    bio TEXT,
    headshot_url TEXT,
    whatsapp_number VARCHAR(100),
    whatsapp_joined BOOLEAN DEFAULT FALSE,
    whatsapp_joined_at TIMESTAMP WITH TIME ZONE,
    mailing_address JSONB,
    apparel_sizes JSONB,
    anything_else TEXT,
    source VARCHAR(50) DEFAULT 'chat_onboarding' CHECK (source IN ('typeform', 'csv_import', 'chat_onboarding')),
    onboarding_status VARCHAR(50) DEFAULT 'pending' CHECK (onboarding_status IN ('pending', 'in_progress', 'completed')),
    onboarding_progress INTEGER DEFAULT 0 CHECK (onboarding_progress >= 0 AND onboarding_progress <= 100),
    last_question_answered VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Team Members table
CREATE TABLE IF NOT EXISTS team_members (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_owner_id UUID REFERENCES business_owners(id) ON DELETE SET NULL,
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(100),
    role VARCHAR(255),
    title VARCHAR(255),
    copywriting_skill INTEGER CHECK (copywriting_skill >= 1 AND copywriting_skill <= 10),
    cro_skill INTEGER CHECK (cro_skill >= 1 AND cro_skill <= 10),
    ai_skill INTEGER CHECK (ai_skill >= 1 AND ai_skill <= 10),
    business_summary TEXT,
    responsibilities TEXT,
    source VARCHAR(50) DEFAULT 'chat_onboarding' CHECK (source IN ('typeform', 'csv_import', 'chat_onboarding')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- C-Level Partners table (for partner/executive additions)
CREATE TABLE IF NOT EXISTS c_level_partners (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_owner_id UUID REFERENCES business_owners(id) ON DELETE CASCADE,
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(100),
    source VARCHAR(50) DEFAULT 'chat_onboarding',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Typeform Applications table
CREATE TABLE IF NOT EXISTS typeform_applications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    typeform_response_id VARCHAR(255) UNIQUE,
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(50),
    contact_preference VARCHAR(100),
    business_description TEXT,
    annual_revenue VARCHAR(100),
    revenue_trend VARCHAR(100),
    main_challenge TEXT,
    why_ca_pro TEXT,
    investment_readiness VARCHAR(100),
    decision_timeline VARCHAR(100),
    has_team BOOLEAN,
    additional_info TEXT,
    whatsapp_joined_at TIMESTAMP WITH TIME ZONE,
    referral_source VARCHAR(255),
    status VARCHAR(50) DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'approved', 'rejected')),
    raw_data JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Onboarding Submissions table (stores raw chat data)
CREATE TABLE IF NOT EXISTS onboarding_submissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id VARCHAR(255) UNIQUE,
    business_owner_id UUID REFERENCES business_owners(id) ON DELETE SET NULL,
    data JSONB NOT NULL,
    progress_percentage INTEGER DEFAULT 0,
    last_question VARCHAR(100),
    is_complete BOOLEAN DEFAULT FALSE,
    completed_at TIMESTAMP WITH TIME ZONE,
    monday_sync_scheduled_at TIMESTAMP WITH TIME ZONE,
    monday_synced BOOLEAN DEFAULT FALSE,
    monday_synced_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Import History table (tracks CSV imports)
CREATE TABLE IF NOT EXISTS import_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    filename VARCHAR(255),
    import_type VARCHAR(50) CHECK (import_type IN ('business_owners', 'team_members')),
    records_imported INTEGER DEFAULT 0,
    records_failed INTEGER DEFAULT 0,
    errors JSONB,
    imported_by VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Activity Log table (for admin dashboard feed)
CREATE TABLE IF NOT EXISTS activity_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id UUID,
    details JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_business_owners_email ON business_owners(email);
CREATE INDEX IF NOT EXISTS idx_business_owners_source ON business_owners(source);
CREATE INDEX IF NOT EXISTS idx_business_owners_status ON business_owners(onboarding_status);
CREATE INDEX IF NOT EXISTS idx_business_owners_created ON business_owners(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_team_members_business_owner ON team_members(business_owner_id);
CREATE INDEX IF NOT EXISTS idx_team_members_email ON team_members(email);

CREATE INDEX IF NOT EXISTS idx_typeform_applications_status ON typeform_applications(status);
CREATE INDEX IF NOT EXISTS idx_typeform_applications_created ON typeform_applications(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_onboarding_submissions_business_owner ON onboarding_submissions(business_owner_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_submissions_session ON onboarding_submissions(session_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_submissions_complete ON onboarding_submissions(is_complete);

CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_business_owners_progress ON business_owners(onboarding_progress);

CREATE INDEX IF NOT EXISTS idx_onboarding_submissions_monday_sync
ON onboarding_submissions(monday_sync_scheduled_at, monday_synced)
WHERE monday_synced = FALSE AND monday_sync_scheduled_at IS NOT NULL;

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger for business_owners updated_at
DROP TRIGGER IF EXISTS update_business_owners_updated_at ON business_owners;
CREATE TRIGGER update_business_owners_updated_at
    BEFORE UPDATE ON business_owners
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger for onboarding_submissions updated_at
DROP TRIGGER IF EXISTS update_onboarding_submissions_updated_at ON onboarding_submissions;
CREATE TRIGGER update_onboarding_submissions_updated_at
    BEFORE UPDATE ON onboarding_submissions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
