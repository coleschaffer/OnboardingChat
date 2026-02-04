# API Reference

This API is served by `server.js` and mounted under `/api/*`.

## Authentication / Verification

### Cron job endpoints

All `/api/jobs/*` endpoints require:

- Header: `x-cron-secret: <CRON_SECRET>`

They also accept `{"secret": "<CRON_SECRET>"}` in the JSON body as a fallback.

### Slack endpoints

`/api/slack/interactions`, `/api/slack/events`, and `/api/slack/commands` require valid Slack signatures:

- `x-slack-signature`
- `x-slack-request-timestamp`

The server captures the raw body for verification (see `server.js`).

### Typeform webhook signature (optional)

If `TYPEFORM_WEBHOOK_SECRET` is set, `/api/webhooks/typeform` verifies `typeform-signature`.

### Calendly webhook signature (optional)

If a signing key is stored in `calendly_webhook_subscriptions`, `/api/webhooks/calendly` verifies `calendly-webhook-signature`.

## Webhooks

### Typeform

- `POST /api/webhooks/typeform`
  - Purpose: ingest a Typeform submission and kick off the Slack+Gmail background flow.
  - Notes: handler expects JSON payload; signature verification is optional.
  - Response:
    - `200 { "success": true, "application_id": "<uuid>" }` on insert
    - `200 { "message": "Response already processed" }` on duplicate

- `GET /api/webhooks/typeform/test`
  - Purpose: quick health check

### SamCart

- `POST /api/webhooks/samcart`
  - Purpose: ingest a SamCart order webhook, post Slack notification, send welcome thread, and (optionally) create Monday Business Owner item.
  - Response:
    - `200 { "success": true, "order_id": "<uuid>" }` on insert
    - `200 { "success": true, "message": "Order updated" }` when updating an existing order

- `GET /api/webhooks/samcart/test`
  - Purpose: quick health check

### Calendly

- `POST /api/webhooks/calendly`
  - Purpose: receive Calendly invitee.created events and update Typeform + Slack thread state.
  - Responses can vary:
    - `200 { "success": true, "application_id": "<uuid>", "email": "...", "event_time": "..." }`
    - `200 { "received": true, "skipped": true, "reason": "existing_member" | "already_notified", ... }`

- `GET /api/webhooks/calendly/test`
  - Purpose: quick health check

### Wasender (WhatsApp)

- `POST /api/webhooks/wasender`
  - Purpose: receive WhatsApp group join events and set `typeform_applications.whatsapp_joined_at` (Joined/final status).
  - Notes:
    - Optional auth: if `WASENDER_WEBHOOK_SECRET` is set, require `x-wasender-secret: <secret>` (or `?secret=`).
    - Optional allowlist: if `WASENDER_ALLOWED_GROUP_JIDS` is set, only those WhatsApp group JIDs will be processed.
    - Recommended Wasender scope/event: `group-participants.update`.
  - Response:
    - `200 { "received": true, "processed_count": <n>, "skipped_count": <n>, ... }`

- `GET /api/webhooks/wasender/test`
  - Purpose: quick health check

## Onboarding

### Progress saves (primary)

- `POST /api/onboarding/save-progress`
  - Body:
    ```json
    {
      "sessionId": "optional-session-id",
      "answers": { "email": "user@example.com", "lastQuestionId": "q1", "...": "..." },
      "teamMembers": [{ "name": "Jane", "email": "jane@co.com", "phone": "..." }],
      "cLevelPartners": [{ "name": "Pat", "email": "pat@co.com", "phone": "..." }],
      "currentQuestion": 5,
      "totalQuestions": 20,
      "isComplete": false
    }
    ```
  - Response:
    ```json
    {
      "success": true,
      "sessionId": "session-id",
      "submissionId": "uuid",
      "businessOwnerId": "uuid-or-null",
      "progress": 25,
      "isComplete": false
    }
    ```

### Legacy completion endpoint

- `POST /api/onboarding/submit`
  - Body: `{ "answers": {...}, "teamMembers": [...], "cLevelPartners": [...] }`
  - Notes: kept for backwards compatibility; internally creates a completed submission.

### Admin support endpoints

- `GET /api/onboarding/submissions?complete=true|false&search=...&limit=50&offset=0`
- `GET /api/onboarding/submissions/:id`
- `GET /api/onboarding/session/:sessionId`
- `POST /api/onboarding/submissions/:id/complete`
- `DELETE /api/onboarding/submissions/:id`
- `GET /api/onboarding/status`

## Validation

- `POST /api/validate-team-count`
  - Body: `{ "teamCount": "..." }`
  - Response: `{ "hasTeamMembers": true|false }`

## Applications (Typeform)

- `GET /api/applications?status=new|reviewed|approved|rejected&search=...&limit=50&offset=0`
- `GET /api/applications/:id`
- `PUT /api/applications/:id/status` body: `{ "status": "new|reviewed|approved|rejected" }`
- `POST /api/applications/:id/convert` (creates a `business_owners` record from an application)
- `DELETE /api/applications/:id` (also deletes related `email_threads`, `application_notes`, `pending_email_sends`)

## Notes (Application Notes)

- `GET /api/notes/:applicationId`
- `POST /api/notes/:applicationId`
  - Body: `{ "note_text": "text", "created_by": "admin" }`
  - Notes: attempts to post the note into the application’s Slack thread.
- `DELETE /api/notes/:noteId`

## Members (Business Owners)

- `GET /api/members?source=typeform|csv_import|chat_onboarding&status=pending|in_progress|completed&search=...&limit=50&offset=0`
- `GET /api/members/:id`
- `POST /api/members`
- `PUT /api/members/:id`
- `GET /api/members/:id/unified` (includes linked Typeform + SamCart rows when matched)
- `DELETE /api/members/:id`

## Team Members

- `GET /api/team-members?business_owner_id=...&source=...&search=...&limit=50&offset=0`
- `GET /api/team-members/:id`
- `POST /api/team-members`
- `PUT /api/team-members/:id`
- `DELETE /api/team-members/:id`

## Import (CSV)

- `POST /api/import/business-owners` (multipart form-data; field name: `file`)
- `POST /api/import/team-members` (multipart form-data; field name: `file`)
- `GET /api/import/history?limit=20&offset=0`

## Stats

- `GET /api/stats`
- `GET /api/stats/activity?limit=20&offset=0`

## Slack

- `POST /api/slack/interactions` (Slack interactive components + modal submissions)
- `POST /api/slack/events` (Slack events; used for thread reply → welcome message editing)
- `POST /api/slack/commands` (Slack slash commands; currently supports `/note`)
- `POST /api/slack/send-welcome` (manual DM-based flow)
  - Body: `{ "userId": "U...", "memberData": { ... } }`
- `GET /api/slack/users`

## Jobs (Cron)

- `GET /api/jobs/health`
- `POST /api/jobs/process-delayed-welcomes` (deprecated no-op)
- `POST /api/jobs/process-monday-syncs`
- `POST /api/jobs/process-email-replies`
- `POST /api/jobs/process-pending-emails`
- `POST /api/jobs/reset-monday-sync`
- `POST /api/jobs/reset-typeform-test` body: `{ "email": "..." }`
- `POST /api/jobs/process-monday-business-owners`
- `POST /api/jobs/trigger-email-flow` (currently non-functional; references missing module)
