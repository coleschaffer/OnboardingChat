# Database Schema + Migration Model

This project uses PostgreSQL with no ORM. Schema comes from three sources:

1. `db/schema.sql`
2. SQL files in `db/migrations/*.sql`
3. runtime migration logic in `server.js` (`runMigrations()`)

Because there is no migration ledger table, keep environments in sync manually.

## Required Extensions

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

Both are required because code uses `uuid_generate_v4()` and `gen_random_uuid()`.

## Table Inventory

## Member/Core Tables

### `business_owners`

Primary normalized member row.

Key fields:

- identity: `id`, `first_name`, `last_name`, `email` (unique), `phone`
- business profile: `business_name`, `business_overview`, `annual_revenue`, `team_count`, `traffic_sources`, `landing_pages`, `pain_point`, `massive_win`
- onboarding metadata: `source`, `onboarding_status`, `onboarding_progress`, `last_question_answered`
- personal/profile: `bio`, `headshot_url`, `whatsapp_number`, `whatsapp_joined`, `whatsapp_joined_at`, `mailing_address`, `apparel_sizes`, `anything_else`
- timestamps: `created_at`, `updated_at`

### `team_members`

Team members linked to `business_owners` (`business_owner_id`).

### `c_level_partners`

Partner/executive contacts linked to `business_owners`.

## Onboarding Session Tables

### `onboarding_submissions`

One row per browser session (`session_id`).

Key fields:

- `data` JSONB (`answers`, `teamMembers`, `cLevelPartners`)
- `progress_percentage`, `last_question`, `is_complete`, `completed_at`
- `business_owner_id`
- Monday sync fields: `monday_sync_scheduled_at`, `monday_synced`, `monday_synced_at`
- `created_at`, `updated_at`

## Typeform + Application Pipeline Tables

### `typeform_applications`

Application intake + pipeline status timestamps.

Important fields:

- source identity: `typeform_response_id`, `raw_data`
- answer columns: `contact_preference`, `business_description`, `annual_revenue`, `revenue_trend`, `main_challenge`, `why_ca_pro`, `investment_readiness`, `decision_timeline`, `has_team`, `anything_else`/legacy `additional_info`, `referral_source`
- review status: `status` (`new|reviewed|approved|rejected`)
- slack thread pointers: `slack_channel_id`, `slack_thread_ts`
- timeline fields:
  - `emailed_at`
  - `replied_at`
  - `call_booked_at`
  - `purchased_at`
  - `onboarding_started_at`
  - `onboarding_completed_at`
  - `whatsapp_joined_at`

### `email_threads`

Tracks Gmail threads for both Typeform and renewal contexts.

Key fields:

- `gmail_thread_id`, `gmail_message_id`
- `typeform_application_id` (nullable for non-Typeform contexts)
- `context_type`, `context_id`
- `slack_channel_id`, `slack_thread_ts`
- reply state: `has_reply`, `reply_received_at`, `reply_count`, `last_reply_snippet`, `last_reply_body`, `status`

### `pending_email_sends`

Queued outbound replies with undo support.

Key fields:

- recipient/payload: `to_email`, `subject`, `body`
- linking: `gmail_thread_id`, `typeform_application_id`, `context_type`, `context_id`
- Slack UX pointers: `channel_id`, `thread_ts`, `sending_message_ts`
- queue state: `send_at`, `status`, `cancelled_at`, `sent_at`, `error_message`

### `application_notes`

Internal notes for applications with optional Slack sync pointers.

### `calendly_webhook_subscriptions`

Stores Calendly webhook metadata and signing key for request verification.

## SamCart + Billing/Offboarding Tables

### `samcart_orders`

SamCart order records + Slack/Monday metadata.

Key fields:

- order payload: `samcart_order_id`, `event_type`, customer fields, product fields, `status`, `raw_data`
- welcome flow: `welcome_sent`, `welcome_sent_at`
- Slack purchase thread pointers:
  - `slack_channel_id`, `slack_thread_ts`
  - `welcome_note_message_ts`
  - `welcome_message_ts`
  - `typeform_message_ts`
- Monday mapping: `monday_item_id`, `monday_created_at`

### `samcart_subscription_events`

Deduplicated subscription lifecycle events.

Key fields:

- `event_key` (unique)
- normalized `event_type` (`charge_failed`, `charged`, `recovered`, `delinquent`, `canceled`, etc.)
- `email`, `period_key`, `subscription_id`, `order_id`
- `amount`, `currency`, `status`, `occurred_at`, `raw_data`

Used by offboarding logic and monthly bounce attempt tracking.

### `member_threads`

Slack thread registry for non-application contexts.

Key fields:

- `member_email`, `member_name`
- `thread_type` (`monthly_bounce`, `yearly_renewal`, `cancel`, etc.)
- `period_key`
- `slack_channel_id`, `slack_thread_ts`
- `metadata` JSONB (e.g., offboarding flags, recovery timestamps)

Unique index:

- `(member_email, thread_type, period_key)`

### `cancellations`

Cancellation records and reason tracking.

Key fields:

- `member_email`, `member_name`
- `reason`, `source`, `created_by`
- `slack_channel_id`, `slack_thread_ts`
- `member_thread_id`

## Admin/Ops Tables

### `activity_log`

Generic event log for dashboard and operational audit trail.

### `import_history`

Tracks CSV imports via admin UI or CLI scripts.

## Runtime Migrations In `server.js`

Startup logic in `runMigrations()` can create/alter:

- `samcart_orders`
- `email_threads`
- `pending_email_sends`
- `member_threads`
- `samcart_subscription_events`
- `cancellations`
- `application_notes`
- `calendly_webhook_subscriptions`
- multiple status/threading columns on `typeform_applications`
- `whatsapp_joined_at` on `business_owners`

This means startup behavior can mutate schema even when SQL migrations are not run.

## SQL Migrations Reference

- `001-add-partial-onboarding.sql`: partial onboarding support fields
- `002-expand-column-lengths.sql`: wider text/varchar fields
- `003-add-samcart-orders.sql`: base SamCart table
- `003-expand-typeform-fields.sql`: Typeform question column expansion + `has_team` type conversion
- `005_monday_sync.sql`: Monday sync scheduling fields
- `007_email_threads.sql`: email threads, notes, calendly subscription storage, status timestamps
- `008_samcart_slack_thread.sql`: SamCart Slack thread columns
- `009_monday_business_owner.sql`: `monday_item_id` tracking on orders
- `010_purchased_at.sql`: `typeform_applications.purchased_at`
- `011_sending_message_ts.sql`: pending email sending-message pointer
- `012_whatsapp_joined_at.sql`: WhatsApp joined timestamps

## Recommended Fresh Environment Order

1. create extensions
2. apply `db/schema.sql`
3. apply SQL migrations (see setup guide)
4. boot app once to run runtime migrations

## Drift Risks To Watch

- `typeform_applications.has_team` boolean-vs-text differences on old DBs
- columns expected by admin/pipeline views (`purchased_at`, `monday_item_id`, `sending_message_ts`)
- coexistence of legacy `additional_info` and newer `anything_else`
