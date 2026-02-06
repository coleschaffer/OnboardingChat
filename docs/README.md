# CA Pro OnboardingChat Documentation

This repository powers the CA Pro onboarding + member operations pipeline:

- Public onboarding chat (`/`) for new members
- Admin dashboard (`/admin`) for pipeline/people/ops
- Backend API + webhooks + cron jobs
- PostgreSQL persistence
- Integrations: Slack, Gmail, Calendly, SamCart, Monday, Circle, ActiveCampaign, Wasender

## Read This First

- Setup and environment: [`00-setup-guide.md`](00-setup-guide.md)
- Integration flows (end-to-end): [`INTEGRATION.md`](INTEGRATION.md)
- Partial onboarding + resume behavior: [`02-partial-onboarding.md`](02-partial-onboarding.md)
- Database tables + migration model: [`03-database-schema.md`](03-database-schema.md)
- API endpoints and auth rules: [`05-api-reference.md`](05-api-reference.md)
- File-by-file code tour: [`04-codebase-tour.md`](04-codebase-tour.md)
- Operations runbook: [`06-operations-runbook.md`](06-operations-runbook.md)
- Security risks and hardening priorities: [`07-security-risks.md`](07-security-risks.md)
- Historical v1 implementation notes: [`01-initial-implementation.md`](01-initial-implementation.md)

## System At A Glance

### Runtime entrypoints

- `server.js`
  - Boots Express + pg Pool
  - Mounts all API routers
  - Serves `public/` and `admin/`
  - Runs startup runtime migrations (`runMigrations()`)
  - Initializes Calendly webhook subscription when token is configured
- `cron-worker.js`
  - Calls cron endpoints on deployed app using `BASE_URL` + `CRON_SECRET`

### Core pipelines

1. Typeform webhook (`POST /api/webhooks/typeform`)
   - inserts `typeform_applications`
   - posts application thread in Slack
   - sends automated Gmail email
   - tracks thread and email metadata

2. Gmail reply processing (`POST /api/jobs/process-email-replies`)
   - polls `email_threads`
   - updates reply state
   - posts reply blocks with “Open Gmail” + “Send Reply”

3. Slack reply workflow (`/api/slack/interactions` + `/api/jobs/process-pending-emails`)
   - modal creates `pending_email_sends`
   - 10-second undo window
   - sends and logs outbound reply

4. SamCart webhook (`POST /api/webhooks/samcart`)
   - records order/subscription event
   - posts purchase thread + generated welcome message
   - creates Monday business owner item (optional)
   - handles subscription failure/recovery/cancel/delinquent offboarding actions

5. Onboarding progress (`POST /api/onboarding/save-progress`)
   - upserts by `session_id`
   - syncs newly added team/partners to Circle + ActiveCampaign
   - on completion: creates member records, schedules Monday sync, updates welcome thread

6. Calendly webhook (`POST /api/webhooks/calendly`)
   - sets `call_booked_at`
   - posts call-booked notification in application thread
   - skips existing members

7. Wasender webhook (`POST /api/webhooks/wasender`)
   - marks WhatsApp joined on first matching join event
   - mirrors status to `business_owners`
   - posts joined update to purchase thread

8. Cron jobs (`/api/jobs/*`)
   - Monday sync processing
   - email replies/pending sends
   - yearly renewals (Monday due-date scan + Slack/Gmail notices)
   - utility/test/reset endpoints

## High-Impact Caveats

- Admin auth is client-only: password is hardcoded in frontend JS (`admin/script.js`) and stored in session storage.
- `api/jobs/process-yearly-renewals/force` has no cron-secret protection (intended for testing).
- `api/jobs/trigger-email-flow` is currently non-functional (missing `./webhooks-helpers` module).
- Database schema is managed by three sources: `db/schema.sql`, SQL migrations, and runtime migrations in `server.js`.
- Circle integration contains hardcoded fallback API tokens in source.

## Environment Variables

See full list and setup details in [`00-setup-guide.md`](00-setup-guide.md).

Most critical variables:

- `DATABASE_URL`, `CRON_SECRET`, `BASE_URL`
- `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`
- `CA_PRO_APPLICATION_SLACK_CHANNEL_ID`, `CA_PRO_NOTIFICATIONS_SLACK_CHANNEL`
- `STEF_GOOGLE_CLIENT_ID`, `STEF_GOOGLE_CLIENT_SECRET`, `STEF_GOOGLE_REFRESH_TOKEN`
- `ANTHROPIC_API_KEY` (welcome generation, welcome edits, team-count AI validation)

## Quick Local Start

```bash
npm install
cp .env.example .env
# fill required env vars
psql "$DATABASE_URL" -f db/schema.sql
npm run dev
```

Then open:

- public chat: `http://localhost:3000/`
- admin: `http://localhost:3000/admin`

For cron locally:

```bash
npm run cron
```
