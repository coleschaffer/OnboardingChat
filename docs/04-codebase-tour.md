# Codebase Tour (File-by-File)

This document is a practical map of the repository: what lives where, and where to look when changing/diagnosing behavior.

## Top-Level Entry Points

### `server.js`

- Express app setup + middleware
  - CORS
  - raw-body capture for Slack signature verification (`/api/slack/*`)
  - raw-body capture for Calendly signature verification (`/api/webhooks/calendly`)
- Postgres `pg` pool creation (`DATABASE_URL`)
- Route mounting
- Static hosting:
  - `/admin` → `admin/`
  - `/` → `public/`
- Runtime DB migrations: `runMigrations()` (creates/updates several tables/columns on startup)
- Calendly webhook initialization: `lib/calendly.js#initializeWebhook()`

### `cron-worker.js`

Designed for Railway Cron. Calls job endpoints on the deployed server:

- `POST /api/jobs/process-delayed-welcomes` (deprecated no-op)
- `POST /api/jobs/process-monday-syncs`
- `POST /api/jobs/process-email-replies`
- `POST /api/jobs/process-pending-emails`

Auth is via `x-cron-secret: CRON_SECRET`.

## API Routers (`api/`)

### Webhooks + pipeline triggers

- `api/webhooks.js`
  - `POST /api/webhooks/typeform`: Typeform intake → insert `typeform_applications` → async Slack+Gmail flow
  - `POST /api/webhooks/samcart`: SamCart purchase → insert `samcart_orders` → Slack purchase thread + welcome thread + Monday Business Owner creation
- `api/calendly.js`
  - `POST /api/webhooks/calendly`: Calendly invitee.created → sets `call_booked_at` → posts Slack call-booked block
- `api/wasender.js`
  - `POST /api/webhooks/wasender`: WhatsApp group join events → sets `typeform_applications.whatsapp_joined_at` → posts Slack update in the purchase/welcome thread

### Onboarding

- `api/onboarding.js`
  - `POST /api/onboarding/save-progress`: upserts partial progress + triggers contact sync + processes completion (once)
  - Admin support endpoints: list/fetch/complete/delete submissions, fetch by session ID, status summary

### Slack

- `api/slack.js`
  - Slack request signature verification (requires `SLACK_SIGNING_SECRET`)
  - `POST /api/slack/interactions`:
    - copy/open modal actions
    - “Send Reply” flow → inserts `pending_email_sends` + undo message
  - `POST /api/slack/events`:
    - thread replies used to request welcome-message edits
  - `POST /api/slack/commands`:
    - Slack slash commands (currently `/note` for application notes)
  - `POST /api/slack/send-welcome`: manual DM-based welcome message send (not the primary production flow)
  - `GET /api/slack/users`: user list for the admin UI (if used)
- `api/slack-threads.js`
  - Low-level Slack Web API helpers (`postMessage`, `updateMessage`, `deleteMessage`, `openModal`)
  - Application thread posting helpers:
    - `postApplicationNotification`
    - `postReplyNotification`
    - `postCallBookedNotification`
    - `postNoteToThread`
    - `postNoteToPurchaseThread` (mirrors notes into the purchase/welcome thread when available)
  - Purchase thread updater:
    - `postOnboardingUpdateToWelcomeThread`

### Scheduled jobs

- `api/jobs.js`
  - `sendWelcomeThread()` (used by SamCart webhook; posts threaded welcome content)
  - Cron endpoints:
    - `/process-delayed-welcomes` (deprecated no-op)
    - `/process-monday-syncs`
    - `/process-email-replies`
    - `/process-pending-emails`
  - Utility admin/test endpoints:
    - `/reset-monday-sync`
    - `/reset-typeform-test`
    - `/process-monday-business-owners`
    - `/trigger-email-flow` (currently references a missing module; not functional)

### Admin CRUD APIs

- `api/applications.js`: Typeform application list/detail/status updates/conversion/deletion
- `api/notes.js`: CRUD notes on an application + optional Slack sync
- `api/members.js`: business owner list/detail/unified view/update/delete
- `api/team-members.js`: team members list/detail/create/update/delete
- `api/import.js`: CSV import endpoints + import history
- `api/stats.js`: dashboard metrics + activity feed
- `api/validate.js`: Claude-powered team-count validation (fallback heuristic if not configured)

### Integrations (non-router modules)

- `api/monday.js`: Monday.com GraphQL integration (board IDs and column IDs are partially hardcoded)
- `api/circle.js`: Circle admin API integration (has env var tokens with hardcoded fallbacks)
- `api/activecampaign.js`: ActiveCampaign contact/tag/list sync

## Libraries (`lib/`)

- `lib/gmail.js`: Gmail OAuth token refresh + send email + thread polling + reply parsing helpers
- `lib/calendly.js`: Calendly API client for webhook subscription creation + signature verification
- `lib/slack-blocks.js`: Slack Block Kit templates (WhatsApp template, email blocks, modals, etc.)
- `lib/notes.js`: shared helpers for creating application notes and syncing them into Slack threads
- `lib/typeform.js`: Typeform API client + optional DB sync helper (not part of the webhook path)

## Frontend

### Public onboarding chat (`public/`)

- `public/index.html`: chat UI shell
- `public/script.js`: question flow, localStorage persistence, calls:
  - `POST /api/onboarding/save-progress`
  - `POST /api/validate-team-count`
- `public/copy.html`: helper page used by Slack copy-link buttons (copies query param `text` to clipboard)

### Admin dashboard (`admin/`)

- `admin/index.html`: dashboard UI
- `admin/script.js`: client-side password gate + calls admin APIs
  - Security note: password is hardcoded and stored in sessionStorage; treat this as unprotected without external auth.
  - Monday-style “board” UX (tables) implemented client-side:
    - Grouped rows (collapsible headers) for Applications / Members / Team Members
    - Sortable columns (state persisted in `localStorage`)
    - Resizable columns (state persisted in `localStorage`)
    - Right-side item view panel (replaces modals): `openItemPanel()`; legacy `openModal()` routes into the panel
- `admin/styles.css`: dashboard styles (palette + board/panel UI)

## Database (`db/`)

- `db/schema.sql`: base schema
- `db/migrations/*.sql`: manual migrations (no migration runner)
- `db/run-schema.js`: helper to apply `schema.sql` against `DATABASE_URL`
- `db/import.js`: CLI CSV import script (also exposed via admin upload endpoints)
