# Setup Guide (Local + Production)

This guide covers local setup and production deployment assumptions for the current codebase.

## Prerequisites

- Node.js `>= 18`
- PostgreSQL
- Slack app (recommended)
- Gmail API OAuth credentials (recommended)
- Optional integrations:
  - Anthropic
  - Calendly
  - Monday.com
  - Circle.so
  - ActiveCampaign
  - Wasender

## 1) Install

```bash
npm install
```

## 2) Environment Variables

Create `.env` from `.env.example` and fill values.

### Core

```env
DATABASE_URL=postgresql://user:password@host:port/database
NODE_ENV=development
PORT=3000
BASE_URL=https://your-domain.example
CRON_SECRET=change-me
```

### Slack

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
CA_PRO_APPLICATION_SLACK_CHANNEL_ID=C0123456789
CA_PRO_NOTIFICATIONS_SLACK_CHANNEL=C0123456789
CA_PRO_FAILED_SLACK_CHANNEL=C0123456789
STEF_SLACK_MEMBER_ID=U0123456789
SLACK_WELCOME_USER_ID=U0123456789
```

### Gmail

```env
STEF_GOOGLE_CLIENT_ID=...
STEF_GOOGLE_CLIENT_SECRET=...
STEF_GOOGLE_REFRESH_TOKEN=...
```

### Anthropic

```env
ANTHROPIC_API_KEY=...
```

Used by:

- welcome generation (`api/jobs.js`, `api/onboarding.js`, `api/slack.js`)
- welcome edit requests in Slack thread replies
- `POST /api/validate-team-count`

### Typeform

```env
TYPEFORM_WEBHOOK_SECRET=...
TYPEFORM_TOKEN=...
TYPEFORM_FORM_ID=...
```

Notes:

- Webhook intake only requires `TYPEFORM_WEBHOOK_SECRET` (optional verification).
- `TYPEFORM_TOKEN` + `TYPEFORM_FORM_ID` are only for `lib/typeform.js` sync tooling.

### Calendly

```env
STEF_CALENDLY_TOKEN=...
```

If set, server startup attempts to create/reuse webhook subscription at:

- `${BASE_URL}/api/webhooks/calendly`

### Monday.com

```env
MONDAY_API_TOKEN=...
```

### Circle.so

```env
CIRCLE_TOKEN_CA=...
CIRCLE_TOKEN_SPG=...
```

### ActiveCampaign

```env
ACTIVECAMPAIGN_API_KEY=...
ACTIVECAMPAIGN_URI=https://your-account.api-us1.com
```

### Wasender / WhatsApp

```env
WASENDER_WEBHOOK_SECRET=...
WASENDER_ALLOWED_GROUP_JIDS=120363261244407125@g.us,120363276808270172@g.us
WASENDER_API_TOKEN=...
WASENDER_API_BASE_URL=https://www.wasenderapi.com/api

# Group IDs used for add/remove actions
JID_AI=120363370304584165@g.us
JID_TM=120363276808270172@g.us
JID_BO=120363261244407125@g.us
```

### Optional Timezone Override

```env
DEFAULT_TIMEZONE=America/New_York
```

Used by Slack note timestamp formatting; most billing/renewal logic uses `America/New_York` in code.

## 3) Database Setup

### 3.1 Enable extensions

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

### 3.2 Apply base schema

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

### 3.3 Apply SQL migrations

Recommended for current behavior:

```bash
psql "$DATABASE_URL" -f db/migrations/003-add-samcart-orders.sql
psql "$DATABASE_URL" -f db/migrations/003-expand-typeform-fields.sql
psql "$DATABASE_URL" -f db/migrations/005_monday_sync.sql
psql "$DATABASE_URL" -f db/migrations/007_email_threads.sql
psql "$DATABASE_URL" -f db/migrations/008_samcart_slack_thread.sql
psql "$DATABASE_URL" -f db/migrations/009_monday_business_owner.sql
psql "$DATABASE_URL" -f db/migrations/010_purchased_at.sql
psql "$DATABASE_URL" -f db/migrations/011_sending_message_ts.sql
psql "$DATABASE_URL" -f db/migrations/012_whatsapp_joined_at.sql
```

Legacy/data-shape migrations (optional but safe on older DBs):

```bash
psql "$DATABASE_URL" -f db/migrations/001-add-partial-onboarding.sql
psql "$DATABASE_URL" -f db/migrations/002-expand-column-lengths.sql
```

### 3.4 Start server once for runtime migrations

`server.js` also creates/alters tables/columns at startup.

```bash
npm run dev
```

## 4) Run Services

### Web/API service

```bash
npm run dev
```

### Cron worker

```bash
npm run cron
```

Cron worker expects:

- `BASE_URL`
- `CRON_SECRET`

## 5) Configure Webhooks

### Typeform

- URL: `https://<BASE_URL>/api/webhooks/typeform`
- Optional signature verification with `TYPEFORM_WEBHOOK_SECRET`

Health:

```bash
curl https://<BASE_URL>/api/webhooks/typeform/test
```

### SamCart

- URL: `https://<BASE_URL>/api/webhooks/samcart`

Health:

```bash
curl https://<BASE_URL>/api/webhooks/samcart/test
```

### Calendly

- URL: `https://<BASE_URL>/api/webhooks/calendly`
- Event expected: `invitee.created`
- Verification occurs when signing key is present in `calendly_webhook_subscriptions`

Health:

```bash
curl https://<BASE_URL>/api/webhooks/calendly/test
```

### Wasender

- URL: `https://<BASE_URL>/api/webhooks/wasender`
- Recommended event/scope: `group-participants.update`
- If `WASENDER_WEBHOOK_SECRET` set, pass `x-wasender-secret` header (or `?secret=`)
- If `WASENDER_ALLOWED_GROUP_JIDS` set, only those groups update joined status

Health:

```bash
curl https://<BASE_URL>/api/webhooks/wasender/test
```

## 6) Slack App Setup

### Request URLs

- Interactivity: `https://<BASE_URL>/api/slack/interactions`
- Events: `https://<BASE_URL>/api/slack/events`
- Slash command (`/note`): `https://<BASE_URL>/api/slack/commands`

### Required scopes (minimum)

- `commands`
- `chat:write`
- `users:read`
- `im:write`
- `channels:history` or `groups:history` (channel type dependent)
- `im:history`
- `mpim:history`

### Event subscriptions

- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`

### Message shortcuts used by backend

- `add_application_note`
- `add_cancel_reason`

### Operational channel membership

Bot must be a member of both configured channels:

- `CA_PRO_APPLICATION_SLACK_CHANNEL_ID`
- `CA_PRO_NOTIFICATIONS_SLACK_CHANNEL`
- `CA_PRO_FAILED_SLACK_CHANNEL`

## 7) Smoke Tests

```bash
curl https://<BASE_URL>/api/jobs/health
curl https://<BASE_URL>/api/webhooks/typeform/test
curl https://<BASE_URL>/api/webhooks/samcart/test
curl https://<BASE_URL>/api/webhooks/calendly/test
curl https://<BASE_URL>/api/webhooks/wasender/test
```

## 8) Known Setup Pitfalls

- Schema drift risk: `db/schema.sql` + SQL migrations + `server.js` runtime migrations all mutate schema.
- `.env.example` is not exhaustive for AI features; add `ANTHROPIC_API_KEY` manually.
- Admin UI authentication is client-side only; add external access control in production.
- `api/jobs/trigger-email-flow` is currently broken (missing module import).
- `api/jobs/process-yearly-renewals/force` is not cron-secret protected; lock down ingress at platform/network layer.
