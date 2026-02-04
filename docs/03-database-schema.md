# Database Schema & Migrations

This project uses PostgreSQL directly via `pg` (no ORM). The schema is created from a mix of:

1. **Base schema**: `db/schema.sql` (tables + indexes + triggers)
2. **Runtime migrations**: `server.js` `runMigrations()` (creates/updates additional tables/columns on startup)
3. **Manual SQL migrations**: `db/migrations/*.sql` (apply with `psql` as needed)

Because there is no migration runner/ledger, **your database must be kept in sync manually**. The setup guide (`docs/00-setup-guide.md`) lists the migrations that are required for currently-running code.

## Required Extensions

This codebase uses **two** UUID generation functions:

- `uuid_generate_v4()` → requires extension `uuid-ossp` (enabled in `db/schema.sql`)
- `gen_random_uuid()` → requires extension `pgcrypto` (enabled in `db/schema.sql`; enable manually if your DB user cannot create extensions)

Run:

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

## Tables (By Domain)

### Core Member Records

#### `business_owners`

Primary record created/updated when OnboardingChat completes (or imported from CSV / converted from Typeform).

Key columns:

- Identity: `id` (UUID PK), `email` (unique), `first_name`, `last_name`, `phone`
- Business: `business_name`, `business_overview`, `annual_revenue`, `team_count`
- Onboarding metadata: `source`, `onboarding_status`, `onboarding_progress`, `last_question_answered`
- Profile details: `bio`, `headshot_url`, `whatsapp_number`, `whatsapp_joined`, `whatsapp_joined_at`, `mailing_address` (JSONB), `apparel_sizes` (JSONB), `anything_else`
- Timestamps: `created_at`, `updated_at` (trigger updates `updated_at`)

#### `team_members`

Team members inserted during onboarding completion and/or CSV imports.

Key columns:

- `business_owner_id` → `business_owners.id` (nullable; `ON DELETE SET NULL`)
- Contact: `first_name`, `last_name`, `email`, `phone`
- Role/skills: `role`, `title`, `copywriting_skill`, `cro_skill`, `ai_skill`
- Context: `business_summary`, `responsibilities`
- `source`, `created_at`

#### `c_level_partners`

Partners/executives captured during onboarding completion.

Key columns:

- `business_owner_id` → `business_owners.id` (`ON DELETE CASCADE`)
- Contact: `first_name`, `last_name`, `email`, `phone`
- `source`, `created_at`

### Onboarding Sessions (Partial Saves)

#### `onboarding_submissions`

One row per browser session (`session_id`) capturing partial progress and full responses.

Key columns:

- `session_id` (unique): generated client-side and persisted in `localStorage`
- `data` (JSONB): `{ answers, teamMembers, cLevelPartners }`
- Progress: `progress_percentage`, `last_question`, `is_complete`, `completed_at`
- Member link: `business_owner_id` → `business_owners.id` (nullable)
- Monday sync tracking:
  - `monday_sync_scheduled_at`
  - `monday_synced`
  - `monday_synced_at`
- Timestamps: `created_at`, `updated_at` (trigger updates `updated_at`)

### Application Pipeline (Typeform → Email → Call → Purchase → Onboarding)

#### `typeform_applications`

Application intake record created by the Typeform webhook.

Base columns (from `db/schema.sql`):

- Identity: `id` (UUID PK), `typeform_response_id` (unique)
- Applicant: `first_name`, `last_name`, `email`, `phone`
- Q5–Q15 (stored individually): `contact_preference`, `business_description`, `annual_revenue`, `revenue_trend`, `main_challenge`, `why_ca_pro`, `investment_readiness`, `decision_timeline`, `has_team`, `referral_source`
- `additional_info` (legacy/freeform)
- `status` (`new|reviewed|approved|rejected`)
- `raw_data` (JSONB), `created_at`

Additional columns used by the current system (from runtime/migrations):

- Q14: `anything_else` (preferred by code; code falls back to `additional_info` for older rows)
- Slack threading:
  - `slack_channel_id`
  - `slack_thread_ts`
- Status timestamps:
  - `emailed_at` (automated email sent)
  - `replied_at` (reply received)
  - `call_booked_at` (Calendly booking)
  - `purchased_at` (SamCart purchase matched by email)
  - `onboarding_started_at` (first onboarding save with email)
  - `onboarding_completed_at` (onboarding completion)
  - `whatsapp_joined_at` (member joined WhatsApp group via Wasender webhook; final status)

Notes:

- `has_team` starts as a boolean in `db/schema.sql`; runtime migration converts it to `VARCHAR(255)` to store choice text like `"Yes"`/`"No"`.

#### `email_threads`

Tracks outbound Gmail threads for Typeform applicants and stores reply metadata.

Key columns:

- Linking:
  - `typeform_application_id` → `typeform_applications.id`
  - `gmail_thread_id` (unique), `gmail_message_id` (the first outbound message)
- Recipient: `recipient_email`, `recipient_first_name`
- Message: `subject`, `initial_email_sent_at`
- Reply tracking: `has_reply`, `reply_received_at`, `reply_count`, `last_reply_snippet`, `last_reply_body`
- `status` (string), `created_at`

Used by:

- `POST /api/jobs/process-email-replies` (poll + update + Slack notification)

#### `pending_email_sends`

Queue of reply emails created from Slack (“Send Reply” modal) with a short undo window.

Key columns:

- Linking:
  - `typeform_application_id` → `typeform_applications.id`
  - `gmail_thread_id` (thread to reply into)
  - Slack pointers: `channel_id`, `thread_ts`
- Payload: `to_email`, `subject`, `body`
- Scheduling: `send_at`
- Status: `status` (`pending|cancelled|sent|failed`), `cancelled_at`, `sent_at`, `error_message`
- Slack UX: `sending_message_ts` (timestamp of the “Sending…” Slack message to delete on undo)

Used by:

- Slack interaction handler (`POST /api/slack/interactions`)
- Cron endpoint `POST /api/jobs/process-pending-emails`

#### `application_notes`

Internal notes on Typeform applications. Notes can be synced into the application’s Slack thread.

Key columns:

- `application_id` → `typeform_applications.id` (`ON DELETE CASCADE`)
- `note_text`, `created_by`
- Slack sync: `slack_synced`, `slack_message_ts`
- `created_at`

#### `calendly_webhook_subscriptions`

Stores Calendly webhook subscription metadata and the signing key used for signature verification.

Key columns:

- `webhook_uri`, `signing_key`
- `organization_uri`, `scope`, `state`
- `created_at`, `updated_at`

### Purchases + Welcome Threads

#### `samcart_orders`

Stores SamCart webhook payloads and Slack/Monday metadata for onboarding.

Base columns (created by runtime migration / `db/migrations/003-add-samcart-orders.sql`):

- Identity: `id` (UUID PK), `samcart_order_id` (unique), `event_type`
- Customer: `email`, `first_name`, `last_name`, `phone`
- Product: `product_name`, `product_id`, `order_total`, `currency`, `status`
- `raw_data` (JSONB), `created_at`, `updated_at`

Additional columns used by the current system:

- Welcome flow:
  - `welcome_sent` (boolean)
  - `welcome_sent_at`
- Slack threading + message pointers:
  - `slack_channel_id`, `slack_thread_ts` (purchase notification thread)
  - `welcome_note_message_ts` (the “Onboarding not complete” note)
  - `welcome_message_ts` (the generated welcome message)
  - `typeform_message_ts` (the Typeform summary message in the thread)
- Monday:
  - `monday_item_id`
  - `monday_created_at`

### Admin / Ops Tables

#### `activity_log`

Lightweight audit/event log used by the admin dashboard.

- `action`, `entity_type`, `entity_id`, `details` (JSONB), `created_at`

#### `import_history`

Tracks CSV imports via the admin UI and CLI.

- `filename`, `import_type`, `records_imported`, `records_failed`, `errors` (JSONB), `imported_by`, `created_at`

## Schema Application Order (Recommended)

For a fresh database:

1. Enable extensions (`uuid-ossp`, `pgcrypto`)
2. Apply `db/schema.sql`
3. Apply required migrations under `db/migrations/` (at minimum `009`, `010`, `011`)
4. Start the server once so `server.js` runtime migrations can create missing tables/columns

For existing databases, apply migrations as needed and restart the server.

### Migration note: WhatsApp join tracking

If you have an existing database and want to add WhatsApp join tracking via SQL, apply:

- `db/migrations/012_whatsapp_joined_at.sql` (adds `whatsapp_joined_at` to `typeform_applications` and `business_owners`)
