# Database Schema Documentation

## Overview

The CA Pro Onboarding system uses PostgreSQL with 7 main tables to store member data, applications, and track onboarding progress.

## Database Connection

```
DATABASE_URL=postgresql://user:password@host:port/database
```

For Railway, the connection uses SSL in production:
```javascript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});
```

## Tables

### 1. business_owners

Primary table for CA Pro members (business owners).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK, DEFAULT uuid_generate_v4() | Unique identifier |
| first_name | VARCHAR(255) | | Owner's first name |
| last_name | VARCHAR(255) | | Owner's last name |
| email | VARCHAR(255) | UNIQUE | Primary email address |
| phone | VARCHAR(100) | | Phone number (supports extensions/formatting) |
| business_name | VARCHAR(255) | | Company/business name |
| business_overview | TEXT | | Description of the business |
| annual_revenue | VARCHAR(255) | | Revenue info (can be descriptive) |
| team_count | VARCHAR(255) | | Team size (can be descriptive like "5 full time, 3 contractors") |
| traffic_sources | TEXT | | Marketing channels used |
| landing_pages | TEXT | | URLs to landing/product pages |
| pain_point | TEXT | | Main business challenge |
| massive_win | TEXT | | What success looks like for them |
| ai_skill_level | INTEGER | CHECK 1-10 | Team's AI proficiency rating |
| bio | TEXT | | Member bio for directory |
| headshot_url | TEXT | | Link to profile photo |
| whatsapp_number | VARCHAR(100) | | WhatsApp contact number |
| whatsapp_joined | BOOLEAN | DEFAULT FALSE | Whether they joined the WhatsApp group |
| mailing_address | JSONB | | Physical address for merchandise |
| apparel_sizes | JSONB | | Clothing sizes for merch |
| anything_else | TEXT | | Additional notes |
| source | VARCHAR(50) | CHECK IN ('typeform', 'csv_import', 'chat_onboarding') | How they were added |
| onboarding_status | VARCHAR(50) | DEFAULT 'pending', CHECK IN ('pending', 'in_progress', 'completed') | Onboarding state |
| onboarding_progress | INTEGER | DEFAULT 0, CHECK 0-100 | Completion percentage |
| last_question_answered | VARCHAR(100) | | ID of last question answered |
| created_at | TIMESTAMP WITH TIME ZONE | DEFAULT CURRENT_TIMESTAMP | Record creation time |
| updated_at | TIMESTAMP WITH TIME ZONE | DEFAULT CURRENT_TIMESTAMP | Last update time (auto-updated via trigger) |

**Indexes:**
- `idx_business_owners_email` - Fast lookup by email
- `idx_business_owners_source` - Filter by source
- `idx_business_owners_status` - Filter by onboarding status
- `idx_business_owners_created` - Sort by creation date
- `idx_business_owners_progress` - Filter by progress

---

### 2. team_members

Team members associated with business owners.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK, DEFAULT uuid_generate_v4() | Unique identifier |
| business_owner_id | UUID | FK -> business_owners(id) ON DELETE SET NULL | Link to business owner |
| first_name | VARCHAR(255) | | Team member's first name |
| last_name | VARCHAR(255) | | Team member's last name |
| email | VARCHAR(255) | | Email address |
| phone | VARCHAR(100) | | Phone number |
| role | VARCHAR(255) | | Job role (e.g., "Copywriter", "Marketing Manager") |
| title | VARCHAR(255) | | Job title |
| copywriting_skill | INTEGER | CHECK 1-10 | Copywriting skill rating |
| cro_skill | INTEGER | CHECK 1-10 | CRO (Conversion Rate Optimization) skill rating |
| ai_skill | INTEGER | CHECK 1-10 | AI proficiency rating |
| business_summary | TEXT | | Summary of what the business does |
| responsibilities | TEXT | | Their responsibilities |
| source | VARCHAR(50) | CHECK IN ('typeform', 'csv_import', 'chat_onboarding') | How they were added |
| created_at | TIMESTAMP WITH TIME ZONE | DEFAULT CURRENT_TIMESTAMP | Record creation time |

**Indexes:**
- `idx_team_members_business_owner` - Find team members by business owner
- `idx_team_members_email` - Fast lookup by email

---

### 3. c_level_partners

C-level executives or business partners added to the owner WhatsApp group.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK, DEFAULT uuid_generate_v4() | Unique identifier |
| business_owner_id | UUID | FK -> business_owners(id) ON DELETE CASCADE | Link to business owner |
| first_name | VARCHAR(255) | | Partner's first name |
| last_name | VARCHAR(255) | | Partner's last name |
| email | VARCHAR(255) | | Email address |
| phone | VARCHAR(100) | | Phone number |
| source | VARCHAR(50) | DEFAULT 'chat_onboarding' | How they were added |
| created_at | TIMESTAMP WITH TIME ZONE | DEFAULT CURRENT_TIMESTAMP | Record creation time |

---

### 4. typeform_applications

Inbound applications from the Typeform application form.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK, DEFAULT uuid_generate_v4() | Unique identifier |
| typeform_response_id | VARCHAR(255) | UNIQUE | Typeform's response ID |
| first_name | VARCHAR(255) | | Applicant's first name |
| last_name | VARCHAR(255) | | Applicant's last name |
| email | VARCHAR(255) | | Email address |
| phone | VARCHAR(50) | | Phone number |
| contact_preference | VARCHAR(100) | | Preferred contact method |
| business_description | TEXT | | Description of their business |
| annual_revenue | VARCHAR(100) | | Revenue tier |
| revenue_trend | VARCHAR(100) | | Growing/stable/declining |
| main_challenge | TEXT | | Primary business challenge |
| why_ca_pro | TEXT | | Why they want to join CA Pro |
| investment_readiness | VARCHAR(100) | | Ready to invest in growth? |
| decision_timeline | VARCHAR(100) | | When they plan to decide |
| has_team | BOOLEAN | | Whether they have a team |
| additional_info | TEXT | | Extra information |
| referral_source | VARCHAR(255) | | How they heard about CA Pro |
| status | VARCHAR(50) | DEFAULT 'new', CHECK IN ('new', 'reviewed', 'approved', 'rejected') | Application status |
| raw_data | JSONB | | Full Typeform response data |
| created_at | TIMESTAMP WITH TIME ZONE | DEFAULT CURRENT_TIMESTAMP | Submission time |

**Indexes:**
- `idx_typeform_applications_status` - Filter by status
- `idx_typeform_applications_created` - Sort by submission date

---

### 5. onboarding_submissions

Raw submissions from the chat onboarding interface. Tracks both partial and complete submissions.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK, DEFAULT uuid_generate_v4() | Unique identifier |
| session_id | VARCHAR(255) | UNIQUE | Browser session identifier |
| business_owner_id | UUID | FK -> business_owners(id) ON DELETE SET NULL | Link to created business owner (null until complete) |
| data | JSONB | NOT NULL | All collected answers as JSON |
| progress_percentage | INTEGER | DEFAULT 0 | Completion percentage (0-100) |
| last_question | VARCHAR(100) | | Question ID where user left off |
| is_complete | BOOLEAN | DEFAULT FALSE | Whether onboarding was finished |
| completed_at | TIMESTAMP WITH TIME ZONE | | When onboarding was completed |
| created_at | TIMESTAMP WITH TIME ZONE | DEFAULT CURRENT_TIMESTAMP | First submission time |
| updated_at | TIMESTAMP WITH TIME ZONE | DEFAULT CURRENT_TIMESTAMP | Last update time (auto-updated via trigger) |

**Indexes:**
- `idx_onboarding_submissions_business_owner` - Find submissions by business owner
- `idx_onboarding_submissions_session` - Fast lookup by session ID
- `idx_onboarding_submissions_complete` - Filter by completion status

---

### 6. import_history

Tracks CSV import operations.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK, DEFAULT uuid_generate_v4() | Unique identifier |
| filename | VARCHAR(255) | | Name of imported file |
| import_type | VARCHAR(50) | CHECK IN ('business_owners', 'team_members') | Type of data imported |
| records_imported | INTEGER | DEFAULT 0 | Successfully imported count |
| records_failed | INTEGER | DEFAULT 0 | Failed import count |
| errors | JSONB | | Error details |
| imported_by | VARCHAR(255) | | Who performed the import |
| created_at | TIMESTAMP WITH TIME ZONE | DEFAULT CURRENT_TIMESTAMP | Import timestamp |

---

### 7. activity_log

Activity feed for the admin dashboard.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK, DEFAULT uuid_generate_v4() | Unique identifier |
| action | VARCHAR(100) | NOT NULL | Action type (e.g., "member_created", "application_approved") |
| entity_type | VARCHAR(50) | | Type of entity affected |
| entity_id | UUID | | ID of affected entity |
| details | JSONB | | Additional action details |
| created_at | TIMESTAMP WITH TIME ZONE | DEFAULT CURRENT_TIMESTAMP | When action occurred |

**Indexes:**
- `idx_activity_log_created` - Sort by time (recent first)

---

## Triggers

### update_updated_at_column()

Automatically updates the `updated_at` timestamp when a row is modified.

```sql
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';
```

Applied to:
- `business_owners` - Tracks profile updates
- `onboarding_submissions` - Tracks progress saves

---

## Data Sources

Records can come from three sources (tracked in `source` column):

1. **csv_import** - Historical data imported from Google Forms CSV exports
   - Always marked as `onboarding_status = 'completed'` and `onboarding_progress = 100`

2. **chat_onboarding** - Data collected through the chat interface
   - Progress tracked in real-time
   - Can be partial (incomplete) or complete

3. **typeform** - Applications from the Typeform intake form
   - Stored in `typeform_applications` table
   - Can be approved/rejected by admin

---

## Relationships

```
business_owners (1) -----> (*) team_members
business_owners (1) -----> (*) c_level_partners
business_owners (1) -----> (*) onboarding_submissions
```

- A business owner can have multiple team members
- A business owner can have multiple C-level partners
- A business owner can have multiple onboarding submissions (though typically one per session)

---

## Migrations

Migrations are stored in `db/migrations/` and should be run in order:

1. **001-add-partial-onboarding.sql** - Adds progress tracking columns
2. **002-expand-column-lengths.sql** - Expands phone, team_count, annual_revenue columns

Run migrations with:
```bash
psql $DATABASE_URL < db/migrations/001-add-partial-onboarding.sql
psql $DATABASE_URL < db/migrations/002-expand-column-lengths.sql
```

Or via Node.js if psql is not available:
```bash
node db/run-schema.js  # For initial setup
```

---

## Common Queries

### Get all members with their team counts
```sql
SELECT
  bo.*,
  COUNT(tm.id) as team_member_count
FROM business_owners bo
LEFT JOIN team_members tm ON tm.business_owner_id = bo.id
GROUP BY bo.id
ORDER BY bo.created_at DESC;
```

### Get incomplete onboarding submissions
```sql
SELECT * FROM onboarding_submissions
WHERE is_complete = FALSE
ORDER BY updated_at DESC;
```

### Get new Typeform applications
```sql
SELECT * FROM typeform_applications
WHERE status = 'new'
ORDER BY created_at DESC;
```

### Dashboard stats
```sql
SELECT
  (SELECT COUNT(*) FROM business_owners) as total_members,
  (SELECT COUNT(*) FROM business_owners WHERE onboarding_status = 'pending') as pending_onboarding,
  (SELECT COUNT(*) FROM typeform_applications WHERE status = 'new') as new_applications,
  (SELECT COUNT(*) FROM team_members) as total_team_members;
```
