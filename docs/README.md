# CA Pro Onboarding System Documentation

## Table of Contents
1. [Project Overview](#project-overview)
2. [Architecture](#architecture)
3. [Database Schema](#database-schema)
4. [API Endpoints](#api-endpoints)
5. [Environment Variables](#environment-variables)
6. [Slack Bot Setup](#slack-bot-setup)
7. [Data Flow](#data-flow)
8. [Cron Jobs](#cron-jobs)
9. [Third-Party Integrations](#third-party-integrations)
10. [Deployment](#deployment)
11. [Troubleshooting](#troubleshooting)

---

## Project Overview

The CA Pro Onboarding System is a comprehensive member onboarding platform for Copy Accelerator Pro. It handles the complete onboarding journey from application through payment to community welcome.

### Core Features
- **Chat-based Onboarding Interface**: Interactive questionnaire for new members
- **Typeform Integration**: Receives and stores application data via webhooks
- **SamCart Integration**: Tracks payment/order data via webhooks
- **Slack Welcome Messages**: AI-generated personalized welcome messages with edit capability
- **Circle.so Integration**: Auto-adds team members and partners to Circle communities
- **ActiveCampaign Integration**: Auto-syncs contacts with tags and list subscriptions
- **Admin Dashboard**: Manage members, applications, team members, and submissions
- **Delayed Welcome System**: Automatic welcome for members who complete payment but not onboarding
- **CSV Import**: Bulk import business owners and team members

### Tech Stack
- **Backend**: Node.js + Express.js
- **Database**: PostgreSQL
- **Frontend**: Vanilla HTML/CSS/JavaScript
- **AI**: Anthropic Claude API (message generation, team count validation)
- **Hosting**: Railway

---

## Architecture

```
                                    +------------------+
                                    |    Typeform      |
                                    +--------+---------+
                                             |
                                             | Webhook (POST /api/webhooks/typeform)
                                             v
+----------------+                  +------------------+                  +------------------+
|                |  POST /api/      |                  |  Slack API       |                  |
|   SamCart      +----------------->+   Express.js     +----------------->+   Slack Bot      |
|   (Payments)   |  /webhooks/      |   Server         |  (Welcome DMs)   |   (DM Channel)   |
|                |  samcart         |   (Railway)      |                  |                  |
+----------------+                  +--------+---------+                  +------------------+
                                             |
                                             |
                    +------------------------+------------------------+
                    |                        |                        |
                    v                        v                        v
           +----------------+       +----------------+       +------------------+
           |   PostgreSQL   |       |  Public Chat   |       |  Admin Dashboard |
           |   Database     |       |  Interface     |       |  (/admin)        |
           |   (Railway)    |       |  (/)           |       |                  |
           +----------------+       +----------------+       +------------------+
```

### Directory Structure
```
/
├── server.js              # Main Express server, middleware, migrations
├── package.json           # Dependencies and scripts
├── api/
│   ├── onboarding.js      # Chat submission handling, Slack welcome
│   ├── webhooks.js        # Typeform and SamCart webhook handlers
│   ├── slack.js           # Slack bot interactions, edit flow
│   ├── jobs.js            # Delayed welcome cron job
│   ├── circle.js          # Circle.so community integration
│   ├── activecampaign.js  # ActiveCampaign CRM integration
│   ├── members.js         # Business owner CRUD
│   ├── team-members.js    # Team member CRUD
│   ├── applications.js    # Typeform application CRUD
│   ├── stats.js           # Dashboard statistics
│   ├── validate.js        # AI-powered team count validation
│   └── import.js          # CSV import functionality
├── public/
│   ├── index.html         # Chat interface HTML
│   ├── script.js          # Chat frontend logic
│   ├── styles.css         # Chat styles
│   └── copy.html          # Copy-to-clipboard helper page
├── admin/
│   ├── index.html         # Admin dashboard HTML
│   ├── script.js          # Admin dashboard logic
│   └── styles.css         # Admin styles
├── db/
│   ├── schema.sql         # Database schema
│   └── migrations/        # SQL migration files
└── lib/
    └── typeform.js        # Typeform utilities
```

---

## Database Schema

### Tables

#### `business_owners`
Primary table for CA Pro members (business owners).

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `first_name` | VARCHAR(255) | First name |
| `last_name` | VARCHAR(255) | Last name |
| `email` | VARCHAR(255) | Email (unique) |
| `phone` | VARCHAR(100) | Phone number |
| `business_name` | VARCHAR(255) | Business name |
| `business_overview` | TEXT | Business description |
| `annual_revenue` | VARCHAR(255) | Revenue tier |
| `team_count` | VARCHAR(255) | Number of team members |
| `traffic_sources` | TEXT | Marketing channels |
| `landing_pages` | TEXT | URLs to landing pages |
| `pain_point` | TEXT | Main challenge |
| `massive_win` | TEXT | Desired outcome |
| `ai_skill_level` | INTEGER | 1-10 scale |
| `bio` | TEXT | Member bio |
| `headshot_url` | TEXT | Profile photo URL |
| `whatsapp_number` | VARCHAR(100) | WhatsApp number |
| `whatsapp_joined` | BOOLEAN | Joined WhatsApp group |
| `mailing_address` | JSONB | Address object |
| `apparel_sizes` | JSONB | Sizes for swag |
| `anything_else` | TEXT | Additional notes |
| `source` | VARCHAR(50) | `typeform`, `csv_import`, `chat_onboarding` |
| `onboarding_status` | VARCHAR(50) | `pending`, `in_progress`, `completed` |
| `onboarding_progress` | INTEGER | 0-100 percentage |
| `last_question_answered` | VARCHAR(100) | Last completed question ID |
| `created_at` | TIMESTAMPTZ | Creation time |
| `updated_at` | TIMESTAMPTZ | Last update time |

#### `team_members`
Team members associated with business owners.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `business_owner_id` | UUID | FK to business_owners |
| `first_name` | VARCHAR(255) | First name |
| `last_name` | VARCHAR(255) | Last name |
| `email` | VARCHAR(255) | Email |
| `phone` | VARCHAR(100) | Phone |
| `role` | VARCHAR(255) | Job role |
| `title` | VARCHAR(255) | Job title |
| `copywriting_skill` | INTEGER | 1-10 scale |
| `cro_skill` | INTEGER | 1-10 scale |
| `ai_skill` | INTEGER | 1-10 scale |
| `business_summary` | TEXT | Business context |
| `responsibilities` | TEXT | Job responsibilities |
| `source` | VARCHAR(50) | Data source |
| `created_at` | TIMESTAMPTZ | Creation time |

#### `c_level_partners`
C-level partners/executives added during onboarding.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `business_owner_id` | UUID | FK to business_owners |
| `first_name` | VARCHAR(255) | First name |
| `last_name` | VARCHAR(255) | Last name |
| `email` | VARCHAR(255) | Email |
| `phone` | VARCHAR(100) | Phone |
| `source` | VARCHAR(50) | Data source |
| `created_at` | TIMESTAMPTZ | Creation time |

#### `typeform_applications`
Stores Typeform application responses (15 questions).

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `typeform_response_id` | VARCHAR(255) | Typeform token (unique) |
| `first_name` | VARCHAR(255) | Q1: First name |
| `last_name` | VARCHAR(255) | Q2: Last name |
| `email` | VARCHAR(255) | Q3: Email |
| `phone` | VARCHAR(50) | Q4: Phone |
| `contact_preference` | VARCHAR(100) | Q5: Best way to reach |
| `business_description` | TEXT | Q6: Business description |
| `annual_revenue` | VARCHAR(100) | Q7: Annual revenue |
| `revenue_trend` | VARCHAR(100) | Q8: Revenue trend (3 months) |
| `main_challenge` | TEXT | Q9: #1 thing holding back |
| `why_ca_pro` | TEXT | Q10: Why CA Pro |
| `investment_readiness` | VARCHAR(255) | Q11: Investment readiness |
| `decision_timeline` | VARCHAR(100) | Q12: Decision timeline |
| `has_team` | VARCHAR(255) | Q13: Has team |
| `anything_else` | TEXT | Q14: Anything else |
| `referral_source` | VARCHAR(255) | Q15: How heard about CA Pro |
| `status` | VARCHAR(50) | `new`, `reviewed`, `approved`, `rejected` |
| `raw_data` | JSONB | Full Typeform response |
| `created_at` | TIMESTAMPTZ | Creation time |

#### `samcart_orders`
Stores SamCart payment/order data.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `samcart_order_id` | VARCHAR(255) | SamCart order ID (unique) |
| `event_type` | VARCHAR(50) | Order, refund, etc. |
| `email` | VARCHAR(255) | Customer email |
| `first_name` | VARCHAR(255) | Customer first name |
| `last_name` | VARCHAR(255) | Customer last name |
| `phone` | VARCHAR(50) | Customer phone |
| `product_name` | VARCHAR(500) | Product purchased |
| `product_id` | VARCHAR(255) | SamCart product ID |
| `order_total` | DECIMAL(10,2) | Order amount |
| `currency` | VARCHAR(10) | Currency code |
| `status` | VARCHAR(50) | Order status |
| `welcome_sent` | BOOLEAN | Welcome message sent |
| `welcome_sent_at` | TIMESTAMPTZ | When welcome was sent |
| `raw_data` | JSONB | Full SamCart payload |
| `created_at` | TIMESTAMPTZ | Creation time |
| `updated_at` | TIMESTAMPTZ | Last update time |

#### `onboarding_submissions`
Tracks chat onboarding progress (supports partial saves).

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `session_id` | VARCHAR(255) | Browser session ID (unique) |
| `business_owner_id` | UUID | FK to business_owners |
| `data` | JSONB | Answers, team members, partners |
| `progress_percentage` | INTEGER | 0-100 completion |
| `last_question` | VARCHAR(100) | Last question ID |
| `is_complete` | BOOLEAN | Fully completed |
| `completed_at` | TIMESTAMPTZ | Completion time |
| `created_at` | TIMESTAMPTZ | Creation time |
| `updated_at` | TIMESTAMPTZ | Last update time |

#### `activity_log`
Audit trail for admin dashboard.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `action` | VARCHAR(100) | Action type |
| `entity_type` | VARCHAR(50) | Entity affected |
| `entity_id` | UUID | Entity ID |
| `details` | JSONB | Action details |
| `created_at` | TIMESTAMPTZ | Creation time |

#### `import_history`
Tracks CSV imports.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `filename` | VARCHAR(255) | Imported file name |
| `import_type` | VARCHAR(50) | `business_owners` or `team_members` |
| `records_imported` | INTEGER | Success count |
| `records_failed` | INTEGER | Failure count |
| `errors` | JSONB | Error details |
| `imported_by` | VARCHAR(255) | Who imported |
| `created_at` | TIMESTAMPTZ | Import time |

---

## API Endpoints

### Onboarding (`/api/onboarding`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/save-progress` | Save partial or complete onboarding |
| `POST` | `/submit` | Legacy submit endpoint |
| `GET` | `/submissions` | List all submissions with filters |
| `GET` | `/submissions/:id` | Get submission by ID |
| `GET` | `/session/:sessionId` | Get submission by session ID |
| `POST` | `/submissions/:id/complete` | Mark submission complete |
| `DELETE` | `/submissions/:id` | Delete submission |
| `GET` | `/status` | Get onboarding status summary |

**Save Progress Request:**
```json
{
  "sessionId": "session_123...",
  "answers": {
    "email": "user@example.com",
    "businessName": "Acme Corp",
    "teamCount": "5",
    ...
  },
  "teamMembers": [
    { "name": "John Doe", "email": "john@acme.com", "phone": "555-1234" }
  ],
  "cLevelPartners": [],
  "currentQuestion": 5,
  "totalQuestions": 12,
  "isComplete": false
}
```

### Webhooks (`/api/webhooks`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/typeform` | Typeform webhook receiver |
| `GET` | `/typeform/test` | Test endpoint |
| `POST` | `/samcart` | SamCart webhook receiver |
| `GET` | `/samcart/test` | Test endpoint |

### Slack (`/api/slack`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/interactions` | Handle button clicks |
| `POST` | `/events` | Handle thread replies |
| `POST` | `/send-welcome` | Trigger welcome message |
| `GET` | `/users` | List Slack users |

### Jobs (`/api/jobs`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/process-delayed-welcomes` | Run delayed welcome job |
| `GET` | `/health` | Health check |

### Members (`/api/members`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | List members with filters |
| `GET` | `/:id` | Get member by ID |
| `GET` | `/:id/unified` | Get member with linked Typeform/SamCart |
| `POST` | `/` | Create member |
| `PUT` | `/:id` | Update member |
| `DELETE` | `/:id` | Delete member |

### Team Members (`/api/team-members`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | List team members |
| `GET` | `/:id` | Get team member |
| `POST` | `/` | Create team member |
| `PUT` | `/:id` | Update team member |
| `DELETE` | `/:id` | Delete team member |

### Applications (`/api/applications`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | List applications |
| `GET` | `/:id` | Get application |
| `PUT` | `/:id/status` | Update status |
| `POST` | `/:id/convert` | Convert to member |
| `DELETE` | `/:id` | Delete application |

### Stats (`/api/stats`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Dashboard statistics |
| `GET` | `/activity` | Activity feed |

### Validation (`/api`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/validate-team-count` | AI validation of team count response |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | No | Server port (default: 3000) |
| `NODE_ENV` | No | Environment (`production` enables SSL) |
| `ANTHROPIC_API_KEY` | Yes | Claude API key for message generation |
| `SLACK_BOT_TOKEN` | Yes | Slack Bot OAuth token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Yes | Slack app signing secret |
| `SLACK_WELCOME_USER_ID` | Yes | User ID to receive welcome DMs |
| `TYPEFORM_WEBHOOK_SECRET` | No | Typeform signature verification |
| `CRON_SECRET` | Yes | Secret key for cron job authentication |
| `BASE_URL` | No | Public URL (default: `https://onboarding.copyaccelerator.com`) |
| `CIRCLE_TOKEN_CA` | Yes | Circle.so API token for Copy Accelerator community |
| `CIRCLE_TOKEN_SPG` | Yes | Circle.so API token for Stefan Paul Georgi community |
| `ACTIVECAMPAIGN_API_KEY` | Yes | ActiveCampaign API key |
| `ACTIVECAMPAIGN_URI` | Yes | ActiveCampaign API URI (e.g., `https://account.api-us1.com`) |

---

## Slack Bot Setup

### Required OAuth Scopes

Bot Token Scopes:
- `chat:write` - Send messages
- `im:write` - Open DM channels
- `users:read` - List users
- `channels:history` - Read channel messages (for thread context)
- `groups:history` - Read private channel messages
- `im:history` - Read DM history
- `mpim:history` - Read multi-party DM history

### Event Subscriptions

Subscribe to these events at `https://your-domain.com/api/slack/events`:
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`

### Interactivity

Enable interactivity at `https://your-domain.com/api/slack/interactions`

### Welcome Message Flow

1. OnboardingChat completion triggers `sendSlackWelcome()`
2. Opens DM with `SLACK_WELCOME_USER_ID`
3. Sends parent message with member overview
4. Sends threaded messages:
   - Typeform application data (if matched)
   - SamCart order data (if matched)
   - OnboardingChat data
   - AI-generated welcome message with Copy button
5. User can reply in thread to request edits
6. Bot uses Claude to regenerate message with requested changes

---

## Data Flow

### Normal Flow: Typeform -> SamCart -> OnboardingChat -> Slack

```
1. APPLICANT APPLIES VIA TYPEFORM
   - Typeform sends webhook to POST /api/webhooks/typeform
   - Data stored in typeform_applications table
   - Activity logged

2. APPLICANT PURCHASES VIA SAMCART
   - SamCart sends webhook to POST /api/webhooks/samcart
   - Data stored in samcart_orders table
   - welcome_sent = false
   - Activity logged

3. MEMBER COMPLETES ONBOARDING CHAT
   - Browser session tracks progress
   - POST /api/onboarding/save-progress on each question
   - On completion:
     a. Business owner record created/updated
     b. Team members created
     c. C-level partners created
     d. sendSlackWelcome() triggered:
        - Matches Typeform data by email/phone/name
        - Matches SamCart data by email/phone/name
        - Opens Slack DM
        - Sends thread with all data
        - Generates AI welcome message
        - Sets samcart_orders.welcome_sent = true
     e. syncOnboardingContacts() triggered (ActiveCampaign):
        - Syncs team members with tags 63, 264 and lists 49, 102
        - Syncs partners with tags 63, 265 and lists 49, 56
     f. syncAllToCircle() triggered (Circle.so):
        - Adds team members to both Circle communities
        - Adds partners to both Circle communities

4. SLACK INTERACTION
   - User clicks Copy button -> Opens copy.html with message
   - User replies in thread -> Claude edits message
```

### Delayed Welcome Flow (Cron Job)

```
1. CRON JOB RUNS (every 15-30 minutes)
   - POST /api/jobs/process-delayed-welcomes
   - Requires X-Cron-Secret header

2. FINDS PENDING ORDERS
   - samcart_orders WHERE:
     - welcome_sent = false
     - created_at < NOW() - 1 hour
     - status = 'completed'

3. FOR EACH ORDER:
   a. Check if OnboardingChat completed (skip if yes)
   b. Find matching Typeform application
   c. Skip if no Typeform data found
   d. Send delayed welcome via Slack
   e. Mark welcome_sent = true
   f. Log to activity feed
```

### Record Matching Strategy

Records are matched across systems using this priority:
1. **Email** - Case-insensitive exact match
2. **Phone** - Last 10 digits comparison (normalized)
3. **Name** - First + Last name exact match

---

## Cron Jobs

### Delayed Welcome Job

**Purpose**: Send welcome messages for members who complete payment but don't complete OnboardingChat within 1 hour.

**Endpoint**: `POST /api/jobs/process-delayed-welcomes`

**Authentication**: Requires `X-Cron-Secret` header or `secret` in body matching `CRON_SECRET` env var.

**Railway Cron Configuration**:
```json
{
  "cron": {
    "schedule": "*/15 * * * *",
    "command": "curl -X POST -H 'X-Cron-Secret: YOUR_SECRET' https://your-app.railway.app/api/jobs/process-delayed-welcomes"
  }
}
```

**Response**:
```json
{
  "success": true,
  "processed": 3,
  "skipped_has_onboarding": 1,
  "skipped_no_typeform": 1,
  "sent": 1,
  "errors": []
}
```

---

## Third-Party Integrations

### Circle.so

Automatically adds Team Members and Partners to Circle communities when onboarding is completed.

**Module**: `api/circle.js`

#### Communities

| Community | ID | URL |
|-----------|-----|-----|
| Copy Accelerator | 60481 | members.copyaccelerator.com |
| Stefan Paul Georgi | 365579 | members.stefanpaulgeorgi.com |

#### Access Groups

| Community | Type | Access Group | ID |
|-----------|------|--------------|-----|
| Copy Accelerator | Team Members | CA Pro Team Members | 4159 |
| Copy Accelerator | Partners | CA Pro Business Owners | 4160 |
| Stefan Paul Georgi | Team Members | CA Pro | 38043 |
| Stefan Paul Georgi | Partners | CA Pro | 38043 |

#### How It Works

1. When onboarding completes (`isComplete: true`), `syncAllToCircle()` is called
2. For each team member/partner with an email:
   - Added to Copy Accelerator community with appropriate access group
   - Added to Stefan Paul Georgi community with CA Pro access group
3. Circle's API handles duplicates (existing members are skipped)
4. Errors are logged to `activity_log` with action `circle_sync_failed`

#### API Endpoint Used

```
POST https://app.circle.so/api/admin/v2/community_members
Authorization: Token {CIRCLE_TOKEN}
```

---

### ActiveCampaign

Automatically syncs Team Members and Partners as contacts with appropriate tags and list subscriptions.

**Module**: `api/activecampaign.js`

#### Tag Assignments

| Contact Type | Tags |
|--------------|------|
| Team Members | CA PRO (63), CA PRO \| Team Members (264) |
| Partners | CA PRO (63), CA PRO \| Business Owners (265) |

#### List Subscriptions

| Contact Type | Lists |
|--------------|-------|
| Team Members | Members - CA PRO (49), Members - CA PRO (Team Members) (102) |
| Partners | Members - CA PRO (49), Members - CA PRO (Business Owners) (56) |

#### How It Works

1. When onboarding completes (`isComplete: true`), `syncOnboardingContacts()` is called
2. For each team member/partner:
   - Contact created/updated via `/api/3/contact/sync`
   - Tags added via `/api/3/contactTags`
   - List subscriptions added via `/api/3/contactLists`
3. Duplicate tags/lists are handled gracefully (API returns success)
4. Errors are logged to `activity_log` with action `activecampaign_sync_failed`

#### API Endpoints Used

```
POST {ACTIVECAMPAIGN_URI}/api/3/contact/sync     # Create/update contact
POST {ACTIVECAMPAIGN_URI}/api/3/contactTags      # Add tag
POST {ACTIVECAMPAIGN_URI}/api/3/contactLists     # Subscribe to list

Headers:
  Api-Token: {ACTIVECAMPAIGN_API_KEY}
  Content-Type: application/json
```

---

## Deployment

### Railway Setup

1. **Create Project**
   - Connect GitHub repository
   - Railway auto-detects Node.js

2. **Add PostgreSQL**
   - Add PostgreSQL plugin
   - `DATABASE_URL` auto-injected

3. **Set Environment Variables**
   - Add all required env vars in Railway dashboard

4. **Deploy**
   - Push to main branch triggers deploy
   - Or use Railway CLI: `railway up`

### Build & Start Commands

Railway uses these from `package.json`:
```json
{
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js",
    "cron": "node cron-worker.js"
  }
}
```

### Database Migrations

Migrations run automatically on server startup via `runMigrations()` in `server.js`. This handles:
- Creating `samcart_orders` table
- Adding `welcome_sent` columns
- Adding missing Typeform application columns
- Converting `has_team` from boolean to varchar

For manual migrations, run SQL files in `/db/migrations/` against your database.

---

## Troubleshooting

### Common Issues

#### Slack Messages Not Sending
- **Check**: `SLACK_BOT_TOKEN` is valid (`xoxb-...`)
- **Check**: `SLACK_WELCOME_USER_ID` is correct user ID (not username)
- **Check**: Bot has required OAuth scopes
- **Check**: Bot is installed to workspace
- **Logs**: Look for "Slack not configured" or API errors

#### Typeform Webhook Not Working
- **Check**: Webhook URL is correct (`/api/webhooks/typeform`)
- **Check**: `TYPEFORM_WEBHOOK_SECRET` matches Typeform config
- **Test**: Use `GET /api/webhooks/typeform/test`
- **Logs**: Look for "Invalid Typeform webhook signature"

#### SamCart Webhook Not Working
- **Check**: Webhook URL is correct (`/api/webhooks/samcart`)
- **Test**: Use `GET /api/webhooks/samcart/test`
- **Logs**: Check payload parsing in server logs

#### Delayed Welcomes Not Sending
- **Check**: `CRON_SECRET` is set and matches request
- **Check**: Cron job is scheduled in Railway
- **Check**: Orders have `status = 'completed'`
- **Check**: Matching Typeform application exists
- **Logs**: Look for "Processing delayed welcomes" messages

#### Data Not Matching
- **Check**: Email formats match (case-insensitive)
- **Check**: Phone numbers match (last 10 digits)
- **Check**: Names match exactly
- **Debug**: Check `activity_log` for `record_matched` entries

#### OnboardingChat Progress Lost
- **Check**: Browser localStorage not cleared
- **Check**: Session ID consistency
- **Debug**: Check `/api/onboarding/session/:sessionId`

#### Circle.so Sync Failing
- **Check**: `CIRCLE_TOKEN_CA` and `CIRCLE_TOKEN_SPG` are set
- **Check**: Tokens have admin API access
- **Check**: Community IDs are correct (60481, 365579)
- **Logs**: Look for `[Circle]` prefixed messages
- **Debug**: Check `activity_log` for `circle_sync_failed` entries

#### ActiveCampaign Sync Failing
- **Check**: `ACTIVECAMPAIGN_API_KEY` and `ACTIVECAMPAIGN_URI` are set
- **Check**: API key has contact/tag/list permissions
- **Logs**: Look for `ActiveCampaign:` prefixed messages
- **Debug**: Check `activity_log` for `activecampaign_sync_failed` entries

### Useful Queries

**Find unmatched SamCart orders:**
```sql
SELECT * FROM samcart_orders
WHERE welcome_sent = false
AND created_at < NOW() - INTERVAL '1 hour';
```

**Find incomplete onboarding submissions:**
```sql
SELECT * FROM onboarding_submissions
WHERE is_complete = false
ORDER BY updated_at DESC;
```

**Recent activity:**
```sql
SELECT * FROM activity_log
ORDER BY created_at DESC
LIMIT 50;
```

**Match check (email):**
```sql
SELECT
  t.email as typeform_email,
  s.email as samcart_email,
  b.email as business_owner_email
FROM typeform_applications t
LEFT JOIN samcart_orders s ON LOWER(t.email) = LOWER(s.email)
LEFT JOIN business_owners b ON LOWER(t.email) = LOWER(b.email)
WHERE t.email IS NOT NULL;
```

### Health Checks

- **Server**: `GET /api/jobs/health`
- **Typeform Webhook**: `GET /api/webhooks/typeform/test`
- **SamCart Webhook**: `GET /api/webhooks/samcart/test`

---

## Contact

For issues with this system, check server logs on Railway or contact the development team.
