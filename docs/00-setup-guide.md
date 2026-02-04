# Setup Guide (Local + Production)

This guide walks through setting up the CA Pro OnboardingChat system locally and in production (Railway).

## Prerequisites

- Node.js `>= 18`
- PostgreSQL database
- (Recommended) Slack App (bot token + signing secret)
- (Recommended) Gmail API credentials (OAuth refresh token) for automated email + reply workflow
- (Optional) Calendly API token for automatic webhook subscription creation
- (Optional) Monday.com API token for Business Owner + team/partner sync
- (Optional) Circle + ActiveCampaign credentials for contact sync

## 1) Install Dependencies

```bash
npm install
```

## 2) Environment Variables

Create `.env` (or set variables in Railway):

### Core

```env
DATABASE_URL=postgresql://user:password@host:port/database
NODE_ENV=development
PORT=3000

# Strongly recommended (production URL). Used for:
# - Calendly webhook callback URL creation
# - cron-worker calls
# - Slack copy links (/copy.html)
BASE_URL=https://your-domain.com
```

### Slack (recommended)

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...

# Channel IDs (not names)
CA_PRO_APPLICATION_SLACK_CHANNEL_ID=C0123456789
CA_PRO_NOTIFICATIONS_SLACK_CHANNEL=C0123456789

# Optional: used for tagging in Slack blocks
STEF_SLACK_MEMBER_ID=U0123456789

# Optional: only used by POST /api/slack/send-welcome (DM workflow)
SLACK_WELCOME_USER_ID=U0123456789
```

### Wasender (WhatsApp) (optional)

```env
# If set, the webhook requires x-wasender-secret (or ?secret=) to match.
WASENDER_WEBHOOK_SECRET=some-long-random-secret

# Optional but recommended: only process join events for these WhatsApp group JIDs.
# Comma-separated. Example:
WASENDER_ALLOWED_GROUP_JIDS=120363261244407125@g.us,120363276808270172@g.us
```

### Typeform

```env
# Optional: verifies typeform-signature header on incoming webhooks
TYPEFORM_WEBHOOK_SECRET=...

# Optional: only used by lib/typeform.js (not required for webhook ingestion)
TYPEFORM_TOKEN=...
TYPEFORM_FORM_ID=...
```

### Gmail (automated outbound email + reply tracking)

```env
STEF_GOOGLE_CLIENT_ID=...
STEF_GOOGLE_CLIENT_SECRET=...
STEF_GOOGLE_REFRESH_TOKEN=...
```

### Calendly (optional but recommended)

```env
STEF_CALENDLY_TOKEN=...
```

### Monday.com (optional)

```env
MONDAY_API_TOKEN=...
```

### Circle + ActiveCampaign (optional)

```env
CIRCLE_TOKEN_CA=...
CIRCLE_TOKEN_SPG=...

ACTIVECAMPAIGN_API_KEY=...
ACTIVECAMPAIGN_URI=https://your-account.api-us1.com
```

### Cron Jobs

```env
CRON_SECRET=some-long-random-secret
```

## 3) Database Setup

### 3.1 Enable required extensions

This codebase uses **both** `uuid_generate_v4()` and `gen_random_uuid()` across tables, so enable:

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

### 3.2 Apply the base schema

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

### 3.3 Apply required migrations (recommended)

Some columns used by the running code are not guaranteed to be created by `server.js` runtime migrations.

Run these (idempotent) migrations:

```bash
psql "$DATABASE_URL" -f db/migrations/009_monday_business_owner.sql
psql "$DATABASE_URL" -f db/migrations/010_purchased_at.sql
psql "$DATABASE_URL" -f db/migrations/011_sending_message_ts.sql
```

Optional (safe) migrations you may also want on existing DBs:

```bash
psql "$DATABASE_URL" -f db/migrations/002-expand-column-lengths.sql
psql "$DATABASE_URL" -f db/migrations/007_email_threads.sql
psql "$DATABASE_URL" -f db/migrations/012_whatsapp_joined_at.sql
```

### 3.4 Start the server once (runtime migrations)

On startup, `server.js` runs `runMigrations()` which creates/updates additional tables/columns (SamCart orders, email thread tables, notes, Calendly subscription storage, Slack threading fields, etc.).

```bash
npm run dev
```

## 4) Configure Webhooks

### Typeform → `POST /api/webhooks/typeform`

- Webhook URL: `https://<BASE_URL>/api/webhooks/typeform`
- Optional secret: set the same value in Typeform and `TYPEFORM_WEBHOOK_SECRET`

You can verify the endpoint:

```bash
curl https://<BASE_URL>/api/webhooks/typeform/test
```

### SamCart → `POST /api/webhooks/samcart`

- Notify URL: `https://<BASE_URL>/api/webhooks/samcart`

You can verify the endpoint:

```bash
curl https://<BASE_URL>/api/webhooks/samcart/test
```

### Calendly → `POST /api/webhooks/calendly`

If `STEF_CALENDLY_TOKEN` is set, the server will create (or re-use) a webhook subscription automatically on startup using:

- Callback URL: `https://<BASE_URL>/api/webhooks/calendly`
- Event: `invitee.created`

Health check:

```bash
curl https://<BASE_URL>/api/webhooks/calendly/test
```

If you do *not* configure Calendly via token, you can still point Calendly to the endpoint manually, but signature verification may be skipped unless a signing key is stored in the DB.

### Wasender (WhatsApp) → `POST /api/webhooks/wasender`

This webhook tracks when a member joins the WhatsApp group and marks the Typeform application as **Joined** (final state).

- Webhook URL: `https://<BASE_URL>/api/webhooks/wasender`
- Optional secret: set `WASENDER_WEBHOOK_SECRET` and configure Wasender to send `x-wasender-secret: <secret>`
- Recommended: set `WASENDER_ALLOWED_GROUP_JIDS` so only the intended CA Pro groups mark members as Joined.
- Recommended scopes/events (minimum):
  - `group-participants.update`

Health check:

```bash
curl https://<BASE_URL>/api/webhooks/wasender/test
```

## 5) Slack App Setup

### 5.1 Interactivity + Events URLs

- Interactivity request URL: `https://<BASE_URL>/api/slack/interactions`
- Event subscriptions request URL: `https://<BASE_URL>/api/slack/events`
- Slash commands request URL: `https://<BASE_URL>/api/slack/commands` (supports `/note`)

The app verifies Slack signatures, so `SLACK_SIGNING_SECRET` must match your app’s signing secret.

### 5.2 Required OAuth scopes

At minimum (based on Web API usage in `api/slack.js` and `api/slack-threads.js`):

- `commands` (required for slash commands like `/note`)
- `chat:write`
- `users:read`
- `im:write` (for `/api/slack/send-welcome`)
- `channels:history` (if your channels are public)
- `groups:history` (if your channels are private)
- `im:history`
- `mpim:history`

### 5.3 Event subscriptions

Subscribe to message events so the bot can respond to thread replies (welcome message edits):

- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`

### 5.4 Invite the bot to channels

Make sure the bot user is invited to:

- `CA_PRO_APPLICATION_SLACK_CHANNEL_ID`
- `CA_PRO_NOTIFICATIONS_SLACK_CHANNEL`

If the bot is not in the channel, Slack posting/updating will fail.

## 6) Cron Worker (Railway)

`cron-worker.js` is designed to run on Railway Cron and call job endpoints on your deployed server.

### Option A: Run `npm run cron` as a Railway Cron service

- Command: `npm run cron`
- Schedule: e.g. every 5–15 minutes (your preference)
- Env vars required:
  - `BASE_URL` (the deployed server URL)
  - `CRON_SECRET` (must match server)

### Option B: Call job endpoints directly from an external scheduler

All `/api/jobs/*` cron endpoints require `x-cron-secret: <CRON_SECRET>`.

## 7) Quick Smoke Tests

- Server health: `GET /api/jobs/health`
- Typeform webhook: `GET /api/webhooks/typeform/test`
- SamCart webhook: `GET /api/webhooks/samcart/test`
- Calendly webhook: `GET /api/webhooks/calendly/test`
- Admin UI: `GET /admin` (note: password gate is client-side only)
