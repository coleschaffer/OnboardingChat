# CA Pro Admin Dashboard & Backend - Initial Implementation

> Note: This document captures the original (“v1”) implementation context and is kept for history. The current production system includes additional flows (Slack threading, Gmail reply workflow, Calendly, SamCart welcome threads, Monday sync, etc.). Start with `docs/README.md` for the up-to-date overview.

## Overview

This document describes the initial implementation of the CA Pro onboarding system, converting a static chat interface into a full-stack application with:

- Express.js backend server
- PostgreSQL database (Railway)
- Typeform integration (webhook + API fetch)
- CSV import for historical data
- Admin dashboard at `/admin`

## Architecture

```
/
├── server.js              # Express server entry point
├── package.json           # Dependencies and scripts
├── .env.example           # Environment variables template
├── .gitignore             # Git ignore rules
├── /public                # Static files (chat interface)
│   ├── index.html         # Chat UI
│   ├── styles.css         # Chat styles
│   ├── script.js          # Chat logic + backend submission
│   └── CA_Favicon.png     # Favicon
├── /admin                 # Admin dashboard
│   ├── index.html         # Dashboard UI
│   ├── styles.css         # Dashboard styles
│   └── script.js          # Dashboard logic
├── /api                   # API routes
│   ├── members.js         # Business owners CRUD
│   ├── team-members.js    # Team members CRUD
│   ├── applications.js    # Typeform applications
│   ├── onboarding.js      # Chat onboarding submissions
│   ├── webhooks.js        # Typeform webhook handler
│   ├── import.js          # CSV import endpoint
│   └── stats.js           # Dashboard statistics
├── /db
│   ├── schema.sql         # Database schema
│   └── import.js          # CLI CSV import script
└── /lib
    └── typeform.js        # Typeform API client
```

## Database Schema

### Tables

#### business_owners
Primary table for CA Pro members (business owners).

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| first_name | VARCHAR(255) | First name |
| last_name | VARCHAR(255) | Last name |
| email | VARCHAR(255) | Email (unique) |
| phone | VARCHAR(50) | Phone number |
| business_name | VARCHAR(255) | Business name |
| business_overview | TEXT | Business description |
| annual_revenue | VARCHAR(100) | Revenue tier |
| team_count | VARCHAR(50) | Number of team members |
| traffic_sources | TEXT | Marketing channels |
| landing_pages | TEXT | URLs to landing pages |
| pain_point | TEXT | Current business challenge |
| massive_win | TEXT | Desired outcome from CA Pro |
| ai_skill_level | INTEGER (1-10) | AI proficiency rating |
| bio | TEXT | Member bio for directory |
| headshot_url | TEXT | Link to headshot |
| whatsapp_number | VARCHAR(50) | WhatsApp contact |
| whatsapp_joined | BOOLEAN | Joined WhatsApp group? |
| mailing_address | JSONB | Shipping address |
| apparel_sizes | JSONB | Clothing sizes |
| anything_else | TEXT | Additional notes |
| source | VARCHAR(50) | typeform, csv_import, chat_onboarding |
| onboarding_status | VARCHAR(50) | pending, in_progress, completed |
| created_at | TIMESTAMP | Record creation time |
| updated_at | TIMESTAMP | Last update time |

#### team_members
Team members associated with business owners.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| business_owner_id | UUID | FK to business_owners |
| first_name | VARCHAR(255) | First name |
| last_name | VARCHAR(255) | Last name |
| email | VARCHAR(255) | Email |
| phone | VARCHAR(50) | Phone |
| role | VARCHAR(255) | Job role |
| title | VARCHAR(255) | Job title |
| copywriting_skill | INTEGER (1-10) | Copywriting rating |
| cro_skill | INTEGER (1-10) | CRO rating |
| ai_skill | INTEGER (1-10) | AI rating |
| business_summary | TEXT | Understanding of business |
| responsibilities | TEXT | Job responsibilities |
| source | VARCHAR(50) | Data source |
| created_at | TIMESTAMP | Record creation time |

#### typeform_applications
New applications from Typeform.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| typeform_response_id | VARCHAR(255) | Typeform response token (unique) |
| first_name | VARCHAR(255) | Applicant first name |
| last_name | VARCHAR(255) | Applicant last name |
| email | VARCHAR(255) | Applicant email |
| phone | VARCHAR(50) | Applicant phone |
| business_description | TEXT | Business description |
| annual_revenue | VARCHAR(100) | Revenue tier |
| main_challenge | TEXT | Primary challenge |
| why_ca_pro | TEXT | Reason for joining |
| status | VARCHAR(50) | new, reviewed, approved, rejected |
| raw_data | JSONB | Full Typeform response |
| created_at | TIMESTAMP | Submission time |

#### onboarding_submissions
Raw chat onboarding data.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| business_owner_id | UUID | FK to business_owners |
| data | JSONB | Full chat responses |
| completed_at | TIMESTAMP | Completion time |
| created_at | TIMESTAMP | Record creation time |

#### activity_log
Audit trail for admin dashboard.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| action | VARCHAR(100) | Action type |
| entity_type | VARCHAR(50) | Entity affected |
| entity_id | UUID | Entity ID |
| details | JSONB | Additional details |
| created_at | TIMESTAMP | Action time |

#### import_history
CSV import tracking.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| filename | VARCHAR(255) | Imported file name |
| import_type | VARCHAR(50) | business_owners or team_members |
| records_imported | INTEGER | Success count |
| records_failed | INTEGER | Failure count |
| errors | JSONB | Error details |
| created_at | TIMESTAMP | Import time |

## API Endpoints

### Members API (`/api/members`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List all business owners (with filters) |
| GET | `/:id` | Get single member with team members |
| POST | `/` | Create new member |
| PUT | `/:id` | Update member |
| DELETE | `/:id` | Delete member |

**Query Parameters:**
- `search` - Search by name, email, business name
- `source` - Filter by source (typeform, csv_import, chat_onboarding)
- `status` - Filter by onboarding_status
- `limit` - Page size (default 50)
- `offset` - Page offset

### Team Members API (`/api/team-members`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List all team members |
| GET | `/:id` | Get single team member |
| POST | `/` | Create new team member |
| PUT | `/:id` | Update team member |
| DELETE | `/:id` | Delete team member |

### Applications API (`/api/applications`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List all Typeform applications |
| GET | `/:id` | Get single application |
| PUT | `/:id/status` | Update application status |
| POST | `/:id/convert` | Convert approved app to member |
| DELETE | `/:id` | Delete application |

### Onboarding API (`/api/onboarding`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/submit` | Submit chat onboarding data |
| GET | `/submissions` | List all submissions |
| GET | `/submissions/:id` | Get single submission |
| GET | `/status` | Get onboarding status counts |

### Webhooks API (`/api/webhooks`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/typeform` | Receive Typeform webhook |
| GET | `/typeform/test` | Test webhook endpoint |

### Import API (`/api/import`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/business-owners` | Import business owners CSV |
| POST | `/team-members` | Import team members CSV |
| GET | `/history` | Get import history |

### Stats API (`/api/stats`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Get dashboard statistics |
| GET | `/activity` | Get activity feed |

## Admin Dashboard

### Overview Tab
- Total members count
- Pending onboardings count
- New applications (last 7 days)
- Total team members
- Recent activity feed
- Onboarding status breakdown chart

### Applications Tab
- Searchable list of Typeform applications
- Filter by status (new, reviewed, approved, rejected)
- View full application details
- Quick actions: Review, Approve (convert to member), Reject

### Members Tab
- Searchable list of business owners
- Filter by source and onboarding status
- View full profile with team members
- Pagination support

### Team Members Tab
- Searchable list of all team members
- Shows skills ratings
- Links to parent business owner

### Onboarding Tab
- Status breakdown (pending, in progress, completed)
- Recent submission list
- View raw submission data

### Import Tab
- CSV upload for business owners
- CSV upload for team members
- Drag-and-drop support
- Import history log

## Environment Variables

```env
DATABASE_URL=postgresql://user:password@host:port/database
TYPEFORM_TOKEN=your_typeform_api_token
TYPEFORM_FORM_ID=q6umv3xg
TYPEFORM_WEBHOOK_SECRET=your_webhook_secret
PORT=3000
NODE_ENV=development
```

## Typeform Integration

### Webhook Setup
1. In Typeform dashboard, go to Connect > Webhooks
2. Add webhook URL: `https://your-domain.com/api/webhooks/typeform`
3. (Optional) Set webhook secret for signature verification

### Manual Sync
The `lib/typeform.js` module provides a `syncTypeformResponses()` function to fetch all existing responses from the Typeform API.

## CSV Import

### Via Admin Dashboard
1. Navigate to `/admin` > Import tab
2. Drag and drop or click to upload CSV
3. View import results and history

### Via CLI
```bash
# Import business owners
node db/import.js --business-owners "path/to/file.csv"

# Import team members
node db/import.js --team-members "path/to/file.csv"

# Import default files in project root
node db/import.js --all
```

## Running the Application

### Development
```bash
npm install
cp .env.example .env  # Fill in your values
npm run dev           # Starts with --watch flag
```

### Production
```bash
npm start
```

### Database Setup
```bash
# Run schema against your PostgreSQL database
psql $DATABASE_URL < db/schema.sql
```
