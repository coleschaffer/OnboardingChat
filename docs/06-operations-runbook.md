# Operations Runbook

This runbook focuses on day-to-day production operation and incident handling.

## Services

- API service: `server.js`
- Cron service: `cron-worker.js`
- Database: PostgreSQL

## Required Baseline Health

- `GET /api/jobs/health` returns `status: ok`
- webhooks return test endpoint success:
  - `/api/webhooks/typeform/test`
  - `/api/webhooks/samcart/test`
  - `/api/webhooks/calendly/test`
  - `/api/webhooks/wasender/test`

## Cron Checklist

Cron worker should run frequently (commonly every 5-15 minutes) and call:

- delayed welcomes (no-op/deprecated)
- Monday syncs
- email replies
- yearly renewals
- pending email sends

If cron fails:

1. verify `BASE_URL` and `CRON_SECRET`
2. verify API service reachable from cron runtime
3. call failing job endpoint manually with cron secret

## High-Value Job Endpoints

- `POST /api/jobs/process-monday-syncs`
  - processes `onboarding_submissions` pending sync
- `POST /api/jobs/process-email-replies`
  - updates `email_threads` + Slack notifications
- `POST /api/jobs/process-pending-emails`
  - safety-net sender for queued replies
- `POST /api/jobs/process-yearly-renewals`
  - ET-window renewal notifier

## Recovery/Manual Operations

### Re-queue Monday sync for recent completed submissions

- `POST /api/jobs/reset-monday-sync` (requires cron secret)

### Re-test Typeform onboarding email flow for an email

- `POST /api/jobs/reset-typeform-test` with `{ "email": "..." }`
- note: `POST /api/jobs/trigger-email-flow` is currently broken

### Retry Monday BO creation for recent orders missing item IDs

- `POST /api/jobs/process-monday-business-owners`

### Force-run yearly renewal notices outside 9 AM ET

- `POST /api/jobs/process-yearly-renewals/force`

## Troubleshooting by Symptom

### "Application posted to Slack but no email"

Check:

- Gmail env vars present
- `activity_log` for `email_send_failed`
- `email_threads` insertion for application

### "Reply received but no Slack notification"

Check:

- `email_threads` row has `slack_channel_id` and `slack_thread_ts`
- Slack bot permissions/channel membership
- cron logs for `process-email-replies`

### "Onboarding complete but team/partners not in Monday"

Check:

- `onboarding_submissions.monday_sync_scheduled_at`
- `monday_synced` flags
- Monday token configured
- business owner exists in Monday (sync retries depend on this)

### "Subscription canceled but offboarding incomplete"

Check:

- `samcart_subscription_events` contains normalized canceled/delinquent event
- `member_threads.metadata.offboarded_at`
- `cancellations` entry
- Circle/Wasender error details in Slack thread summary

### "WhatsApp joined not marking in admin"

Check:

- Wasender payload includes expected participant/group fields
- allowed group JID filtering
- phone normalization fallback path
- `typeform_applications.whatsapp_joined_at`

## Useful SQL Checks

Recent failed pending sends:

```sql
SELECT id, to_email, status, error_message, send_at, sent_at
FROM pending_email_sends
WHERE status = 'failed'
ORDER BY send_at DESC
LIMIT 50;
```

Recent subscription events:

```sql
SELECT occurred_at, event_type, email, amount, period_key
FROM samcart_subscription_events
ORDER BY occurred_at DESC
LIMIT 100;
```

Pending Monday syncs:

```sql
SELECT id, session_id, monday_sync_scheduled_at, monday_synced
FROM onboarding_submissions
WHERE monday_sync_scheduled_at IS NOT NULL
  AND monday_synced = false
ORDER BY monday_sync_scheduled_at ASC;
```

Cancellation records:

```sql
SELECT created_at, member_email, reason, source, created_by
FROM cancellations
ORDER BY created_at DESC
LIMIT 50;
```

## Deployment Safety Checklist

Before deploy:

1. verify env vars are present (especially secrets + channel IDs)
2. verify DB migrations/state for required columns
3. confirm Slack bot is in both channels

After deploy:

1. hit health endpoints
2. post a test webhook payload in staging or test route
3. run a manual cron call for one job endpoint
