# API Reference

Base path: `/api`

## Authentication + Verification Rules

### Cron-protected endpoints

Most `/api/jobs/*` POST routes require:

- `x-cron-secret: <CRON_SECRET>` header
- or body fallback: `{ "secret": "<CRON_SECRET>" }`

Exceptions:

- `GET /api/jobs/health` has no auth
- `POST /api/jobs/process-yearly-renewals/force` has no auth (intended test route)

### Slack signature verification

Enforced on:

- `POST /api/slack/interactions`
- `POST /api/slack/commands`
- `POST /api/slack/events`

Headers required:

- `x-slack-signature`
- `x-slack-request-timestamp`

### Webhook signature verification

- Typeform (`POST /api/webhooks/typeform`): verified when `TYPEFORM_WEBHOOK_SECRET` configured
- Calendly (`POST /api/webhooks/calendly`): verified when signing key exists in DB
- Wasender (`POST /api/webhooks/wasender`): optional shared secret via env

## Webhooks

### Typeform

- `POST /api/webhooks/typeform`
  - Inserts `typeform_applications`
  - Triggers async Slack + Gmail flow
  - Duplicate `typeform_response_id` is ignored
- `GET /api/webhooks/typeform/test`

### SamCart

- `POST /api/webhooks/samcart`
  - Order events:
    - insert/update `samcart_orders`
    - post purchase thread
    - trigger welcome thread
    - optionally create Monday BO item
  - Subscription lifecycle events:
    - record in `samcart_subscription_events`
    - trigger bounce/recovery/cancel/delinquent handling
    - perform offboarding actions (Monday/Circle/Wasender) where applicable
- `GET /api/webhooks/samcart/test`

### Calendly

- `POST /api/webhooks/calendly`
  - Handles `invitee.created`
  - Sets `call_booked_at` for matching application
  - Posts Slack call-booked message
  - skips existing paying members
- `GET /api/webhooks/calendly/test`

### Wasender

- `POST /api/webhooks/wasender`
  - Handles participant add/join events
  - marks `typeform_applications.whatsapp_joined_at` first time only
  - mirrors `whatsapp_joined` on `business_owners`
  - posts joined update in purchase thread
- `GET /api/webhooks/wasender/test`

## Validation

- `POST /api/validate-team-count`
  - body: `{ "teamCount": "..." }`
  - returns: `{ "hasTeamMembers": true|false }`

## Onboarding

### Main flow

- `POST /api/onboarding/save-progress`
  - upserts by `sessionId`
  - stores answers/team/partner data
  - triggers contact sync and completion side-effects

- `POST /api/onboarding/submit` (legacy)
  - creates complete submission directly

### Admin/support

- `GET /api/onboarding/submissions`
  - query: `complete`, `search`, `limit`, `offset`
- `GET /api/onboarding/submissions/:id`
- `GET /api/onboarding/session/:sessionId`
- `POST /api/onboarding/submissions/:id/complete`
- `DELETE /api/onboarding/submissions/:id`
- `GET /api/onboarding/status`

## Applications

- `GET /api/applications`
  - query: `status`, `search`, `limit`, `offset`
- `GET /api/applications/:id`
- `PUT /api/applications/:id/status`
  - body: `{ "status": "new|reviewed|approved|rejected" }`
- `PUT /api/applications/:id/pipeline-stage`
  - body: `{ "stage": "new|emailed|replied|call_booked|purchased|onboarding_started|onboarding_complete|joined" }`
- `POST /api/applications/:id/convert`
- `POST /api/applications/:id/test-subscription-failure`
  - body optional: `{ "count": 1-4 }`
- `POST /api/applications/:id/test-subscription-cancel`
- `POST /api/applications/:id/test-subscription-recovered`
- `DELETE /api/applications/:id`

## Notes

- `GET /api/notes/:applicationId`
- `POST /api/notes/:applicationId`
  - body: `{ "note_text": "...", "created_by": "admin" }`
- `DELETE /api/notes/:noteId`

## Members

- `GET /api/members`
  - query: `source`, `status`, `search`, `include_canceled`, `limit`, `offset`
- `GET /api/members/:id`
- `POST /api/members`
- `PUT /api/members/:id`
- `GET /api/members/:id/unified`
- `DELETE /api/members/:id`

## Team Members

- `GET /api/team-members`
  - query: `business_owner_id`, `source`, `search`, `limit`, `offset`
- `GET /api/team-members/:id`
- `POST /api/team-members`
- `PUT /api/team-members/:id`
- `DELETE /api/team-members/:id`

## Cancellations

- `GET /api/cancellations`
  - query: `search`, `limit`, `offset`

## Import

- `POST /api/import/business-owners` (multipart field: `file`)
- `POST /api/import/team-members` (multipart field: `file`)
- `GET /api/import/history`

## Stats

- `GET /api/stats`
- `GET /api/stats/activity`

## Slack

- `POST /api/slack/interactions`
  - handles block actions, modal submissions, message shortcuts
- `POST /api/slack/commands`
  - supports `/note`
- `POST /api/slack/events`
  - DM member lookup + welcome edit flow in notification threads
- `POST /api/slack/send-welcome`
  - body: `{ "userId": "U...", "memberData": { ... } }`
- `GET /api/slack/users`

## Jobs

- `GET /api/jobs/health`
- `POST /api/jobs/process-delayed-welcomes` (deprecated no-op)
- `POST /api/jobs/process-monday-syncs`
- `POST /api/jobs/process-yearly-renewals`
- `POST /api/jobs/process-yearly-renewals/force` (no cron secret)
- `POST /api/jobs/process-email-replies`
- `POST /api/jobs/process-pending-emails`
- `POST /api/jobs/reset-monday-sync`
- `POST /api/jobs/reset-typeform-test`
  - body: `{ "email": "..." }`
- `POST /api/jobs/process-monday-business-owners`
- `POST /api/jobs/trigger-email-flow`
  - currently non-functional (references missing `./webhooks-helpers`)
