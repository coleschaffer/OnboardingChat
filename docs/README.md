# CA Pro OnboardingChat Documentation

This repository powers the Copy Accelerator Pro onboarding pipeline end-to-end:

- **Public Onboarding Chat**: SPA served at `/` from `public/`
- **Admin Dashboard**: SPA served at `/admin` from `admin/`
- **Backend**: Node.js + Express + PostgreSQL + integrations (Slack, Gmail, Calendly, SamCart, Monday, Circle, ActiveCampaign)

## Start Here (Docs Index)

- Setup / local dev: [`00-setup-guide.md`](00-setup-guide.md)
- Integrations & data flows: [`INTEGRATION.md`](INTEGRATION.md)
- Partial onboarding + resume: [`02-partial-onboarding.md`](02-partial-onboarding.md)
- Database schema + migrations: [`03-database-schema.md`](03-database-schema.md)
- API reference: [`05-api-reference.md`](05-api-reference.md)
- Codebase tour (file-by-file): [`04-codebase-tour.md`](04-codebase-tour.md)
- Historical context: [`01-initial-implementation.md`](01-initial-implementation.md) (v1; kept for history and not fully current)

## Architecture At A Glance

- `server.js`:
  - Creates the Express app and Postgres `pg` pool (`DATABASE_URL`)
  - Runs **runtime migrations** on startup (`runMigrations()`)
  - Mounts all routers under `/api/*`
  - Serves static SPAs from `public/` and `admin/`
- Database: Postgres (no ORM)
- Runtime migrations: `server.js` creates/updates several tables/columns at runtime; additional SQL migrations exist under `db/migrations/`.

### Slack Surfaces (Two Primary Channels)

The system primarily operates in two Slack contexts:

1. **Application threads** (Typeform):
   - Channel: `CA_PRO_APPLICATION_SLACK_CHANNEL_ID`
   - One top-level message per Typeform application, with a thread for:
     - WhatsApp follow-up template
     - Email sent/failed status
     - Email replies (“Send Reply” workflow)
     - Calendly “Call booked” notifications
     - Admin notes (via `/note` or the admin UI; mirrored into purchase threads when available)
2. **Purchase + Welcome threads** (SamCart):
   - Channel: `CA_PRO_NOTIFICATIONS_SLACK_CHANNEL`
   - One top-level message per SamCart order, with a thread for:
     - Typeform application summary (if found)
     - “Onboarding not complete yet” note
     - Generated welcome message + copy link
     - Updated welcome message once OnboardingChat is completed

## Core Data Model (High Level)

Full details are in [`03-database-schema.md`](03-database-schema.md). The key tables are:

- `typeform_applications`: Typeform intake (15 questions) + Slack thread pointers + status timestamps
- `email_threads`: outbound Gmail thread tracking per application + reply tracking fields
- `samcart_orders`: SamCart order events + Slack thread pointers + welcome message timestamps + Monday item ID
- `onboarding_submissions`: per-browser-session saved onboarding progress (`data` JSONB) + Monday sync scheduling
- `business_owners`, `team_members`, `c_level_partners`: normalized member records created on onboarding completion
- `pending_email_sends`: reply emails queued with an undo window
- `application_notes`: internal notes on applications (+ optional Slack sync)
- `activity_log`, `import_history`, `calendly_webhook_subscriptions`: operational support tables

## End-to-End Flows (What Happens When)

### 1) Typeform Application → Slack Thread + Automated Email (Optional)

Endpoint: `POST /api/webhooks/typeform`

- Verifies Typeform signature if `TYPEFORM_WEBHOOK_SECRET` is set.
- Inserts a row in `typeform_applications` (mapped fields + `raw_data`).
- Kicks off a background flow that can:
  - Post the application into Slack (stores `slack_channel_id`, `slack_thread_ts` on `typeform_applications`)
  - Send an automated Gmail email (creates `email_threads`, sets `typeform_applications.emailed_at`)
  - Add WhatsApp template + email status blocks into the Slack thread

### 2) Gmail Replies → Slack Notification + “Send Reply” Workflow

Cron endpoint: `POST /api/jobs/process-email-replies`

- Polls `email_threads` via the Gmail API.
- For new replies:
  - Updates `email_threads` reply fields
  - Sets `typeform_applications.replied_at`
  - Posts a reply notification block into the application’s Slack thread with:
    - “Open Gmail”
    - “Send Reply” (opens a Slack modal)

### 3) Slack Modal Reply → Pending Send (Undo) → Gmail Send

Slack endpoint: `POST /api/slack/interactions` (modal submission)

- Inserts a row into `pending_email_sends` with `send_at` ~10 seconds in the future.
- Posts a “Sending…” message with an Undo button.
- The email is sent by either:
  - an in-process timer inside `api/slack.js` (fast path), or
  - cron endpoint `POST /api/jobs/process-pending-emails` (safety net)

### 4) Calendly Booking → “Call Booked” in Slack Application Thread

Endpoint: `POST /api/webhooks/calendly`

- Validates Calendly webhook signature when a signing key is stored.
- Skips notifications for existing members (SamCart order exists).
- Finds matching `typeform_applications` record (email first; name fallback within 30 days).
- Sets `typeform_applications.call_booked_at` and posts a Slack block in the application thread.

### 4b) Slack `/note` → Application Notes → Admin + Threads

- Command: `/note <text>` (use inside an application thread in `CA_PRO_APPLICATION_SLACK_CHANNEL_ID`)
- Creates a row in `application_notes` for the matching `typeform_applications` record.
- Sync behavior:
  - posts into the application’s Slack thread (best-effort)
  - mirrors into the member’s Purchase/Welcome Slack thread (best-effort, if it exists)
- Notes are visible in `/admin` under the Typeform Application view + notes panel.

### 5) SamCart Purchase → Slack Notification + Welcome Thread

Endpoint: `POST /api/webhooks/samcart`

- Inserts/updates `samcart_orders`.
- Sets `typeform_applications.purchased_at` for matching emails.
- Posts a purchase notification to `CA_PRO_NOTIFICATIONS_SLACK_CHANNEL` and stores the `slack_channel_id` + `slack_thread_ts`.
- Immediately posts a welcome thread under that notification:
  - Typeform application details (if found)
  - Any existing application notes (if found; last 5)
  - A note that OnboardingChat is not complete yet
  - A generated welcome message + “Copy to Clipboard” link (`/copy.html`)
  - Stores Slack message timestamps in `samcart_orders` for later updates/deletions
- If Monday is configured, creates a Business Owner item and stores `samcart_orders.monday_item_id`.

### 6) OnboardingChat Progress Saves → DB + Contact Sync; Completion → Member Creation + Thread Update

Endpoint: `POST /api/onboarding/save-progress`

- The browser stores state in `localStorage` under `ca_pro_onboarding` and posts progress to the backend after each answer.
- The backend upserts `onboarding_submissions` by `session_id`.
- When the email is first captured, sets `typeform_applications.onboarding_started_at`.
- When *new* team-member/partner emails are added, triggers Circle + ActiveCampaign sync for only those new contacts (async).
- On the first completion of a session:
  - creates/updates `business_owners`, inserts `team_members` and `c_level_partners`
  - schedules Monday sync (`onboarding_submissions.monday_sync_scheduled_at = NOW()`)
  - updates Monday Business Owner “Company” field if an order exists with `monday_item_id`
  - updates the existing SamCart welcome thread with OnboardingChat data and regenerates the welcome message
  - sets `typeform_applications.onboarding_completed_at`

### 7) WhatsApp Group Join (Wasender) → Joined Status + Slack Thread Update

Endpoint: `POST /api/webhooks/wasender`

- Watches for WhatsApp group participant “add/join” events.
- Matches the member to `typeform_applications` primarily via phone number (last 10 digits), with fallback matching via `business_owners` / `samcart_orders`.
- Sets `typeform_applications.whatsapp_joined_at` (first time only).
- Mirrors onto `business_owners`:
  - `whatsapp_joined = true`
  - `whatsapp_joined_at = NOW()` (if empty)
- Posts a message into the member’s Purchase/Welcome Slack thread in `CA_PRO_NOTIFICATIONS_SLACK_CHANNEL` tagging Stefan.

### 8) Cron Worker (Railway)

`cron-worker.js` calls job endpoints (auth via `CRON_SECRET`):

- `POST /api/jobs/process-delayed-welcomes` (**deprecated no-op**, kept for backwards compatibility)
- `POST /api/jobs/process-monday-syncs`
- `POST /api/jobs/process-email-replies`
- `POST /api/jobs/process-pending-emails`

## Environment Variables (Reference)

For setup instructions and which ones are optional, see [`00-setup-guide.md`](00-setup-guide.md). This is the complete list referenced by code:

### Core

- `DATABASE_URL` (required): Postgres connection string
- `NODE_ENV` (optional): in `production`, Postgres SSL is enabled
- `PORT` (optional): server port (defaults to 3000)
- `BASE_URL` (recommended): used for Calendly webhook callback URL, cron worker calls, and copy links

### Slack

- `SLACK_BOT_TOKEN` (recommended): needed to post/update Slack messages
- `SLACK_SIGNING_SECRET` (recommended): required for `/api/slack/*` signature verification
- `CA_PRO_APPLICATION_SLACK_CHANNEL_ID` (recommended): where application threads are created
- `CA_PRO_NOTIFICATIONS_SLACK_CHANNEL` (recommended): where SamCart purchase threads + welcome messages are posted
- `STEF_SLACK_MEMBER_ID` (optional): user ID to tag in Slack application threads
- `SLACK_WELCOME_USER_ID` (optional): only used by `/api/slack/send-welcome` (DM workflow)

### Gmail (Automated Emails + Reply Tracking)

- `STEF_GOOGLE_CLIENT_ID`
- `STEF_GOOGLE_CLIENT_SECRET`
- `STEF_GOOGLE_REFRESH_TOKEN`

### Calendly

- `STEF_CALENDLY_TOKEN` (optional but recommended): allows auto-creating a webhook subscription on startup

### Cron Jobs

- `CRON_SECRET` (required to run job endpoints + cron worker)

### Monday.com

- `MONDAY_API_TOKEN` (optional): enables Business Owner creation + team/partner sync

### Circle.so

- `CIRCLE_TOKEN_CA` (recommended): Copy Accelerator Circle community admin token
- `CIRCLE_TOKEN_SPG` (recommended): Stefan Paul Georgi Circle community admin token

### ActiveCampaign

- `ACTIVECAMPAIGN_API_KEY` (optional)
- `ACTIVECAMPAIGN_URI` (optional)

### Typeform

- `TYPEFORM_WEBHOOK_SECRET` (optional): verifies `typeform-signature` on incoming webhooks
- `TYPEFORM_TOKEN` + `TYPEFORM_FORM_ID` (optional): only used by `lib/typeform.js` (not required for webhooks)

### Wasender (WhatsApp)

- `WASENDER_WEBHOOK_SECRET` (optional): if set, `/api/webhooks/wasender` requires `x-wasender-secret` (or `?secret=`) to match
- `WASENDER_ALLOWED_GROUP_JIDS` (recommended): comma-separated WhatsApp group JIDs to treat as “Joined” (prevents unrelated groups from marking members as joined)

## Operational Notes / Gotchas

- **DB extensions**: the codebase uses both `uuid_generate_v4()` (uuid-ossp) and `gen_random_uuid()` (pgcrypto). Make sure both extensions are enabled in Postgres.
- **Schema drift**: some columns required by the code are not created by `runMigrations()` and must be applied manually (see `db/migrations/009_*`, `010_*`, `011_*`).
- **Admin auth is client-side only**: `/admin` uses a hardcoded password in `admin/script.js`. Treat the admin UI as unprotected unless you add an external auth layer (Railway, Cloudflare Access, VPN, etc.).
- **Deprecated cron**: delayed welcomes are deprecated; the endpoint is a no-op but still called by `cron-worker.js`.
- **Broken test endpoint**: `/api/jobs/trigger-email-flow` references a missing module (`./webhooks-helpers`) and is currently non-functional.
