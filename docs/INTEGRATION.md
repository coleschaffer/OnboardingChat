# Integrations & Data Flow

This document explains how the system’s integrations work together (Typeform, Gmail, Slack, Calendly, SamCart, Monday, Circle, ActiveCampaign).

## Slack: Two Threaded Workflows

### 1) Application threads (Typeform)

- Channel: `CA_PRO_APPLICATION_SLACK_CHANNEL_ID`
- Trigger: `POST /api/webhooks/typeform`
- Stored on `typeform_applications`:
  - `slack_channel_id`
  - `slack_thread_ts`

This thread becomes the “source of truth” conversation for:

- The initial Typeform application content
- WhatsApp follow-up template
- Email sent/failed status
- Email replies (“Send Reply” modal)
- Calendly call booked notifications
- Admin notes (`application_notes`) sync
  - Notes created in the admin UI sync into this thread.
  - Slack message shortcut “Add Note” (callback_id: `add_application_note`) can be used on a message in this thread to create a note and sync it into:
    - the application thread, and
    - the member’s Purchase/Welcome thread (if one exists)
  - Slash command fallback: `/note <email|applicationId> <text>` (Slack does **not** allow custom slash commands to be invoked from thread replies)

### 2) Purchase + welcome threads (SamCart)

- Channel: `CA_PRO_NOTIFICATIONS_SLACK_CHANNEL`
- Trigger: `POST /api/webhooks/samcart`
- Stored on `samcart_orders`:
  - `slack_channel_id`
  - `slack_thread_ts`
  - `welcome_note_message_ts`, `welcome_message_ts`, `typeform_message_ts` (message timestamps for later update/delete)

This thread hosts:

- A purchase notification (top-level message)
- Thread replies:
  - Typeform summary (if found)
  - “Onboarding not complete yet” note
  - Application notes (mirrored from `/note` and admin notes)
  - Generated welcome message (copy link button)
  - Updated welcome message after OnboardingChat completion

Welcome-message editing:

- Users can reply inside this thread to request welcome message edits.
- The Slack events handler only processes these requests in `CA_PRO_NOTIFICATIONS_SLACK_CHANNEL` and only for threads that match an existing `samcart_orders` row (prevents bot replies in other channels like `#ca-pro-application`).

## Typeform → Slack + Gmail

### Entry point

- Endpoint: `POST /api/webhooks/typeform` (`api/webhooks.js`)
- Optional verification: `TYPEFORM_WEBHOOK_SECRET` + `typeform-signature` header

### What gets stored

- Row in `typeform_applications` with mapped fields for **all 15 questions** plus `raw_data`.

### Background actions

After insertion, the webhook triggers a background flow:

1. **Post application to Slack** (if `CA_PRO_APPLICATION_SLACK_CHANNEL_ID` is set)
   - Top-level Slack message is created
   - `typeform_applications.slack_channel_id` and `.slack_thread_ts` are saved
2. **Send automated email** (if Gmail env vars are set)
   - Uses `lib/gmail.js`
   - Creates a row in `email_threads`
   - Sets `typeform_applications.emailed_at`
3. **Update the Slack thread** with:
   - WhatsApp template message + copy button
   - Email sent/failed block (depending on Gmail success)

## Gmail Replies → Slack “Send Reply” Workflow

### Reply polling

- Cron endpoint: `POST /api/jobs/process-email-replies`
- Tracks threads via `email_threads` and Gmail API

When a new reply is detected:

- Updates `email_threads`:
  - `has_reply`, `reply_count`, `reply_received_at`, `last_reply_snippet`, `last_reply_body`, `status`
- Sets `typeform_applications.replied_at` (first reply)
- Posts a reply notification block into the Slack application thread:
  - includes “Open Gmail”
  - includes “Send Reply” (opens modal)

### Sending a reply (with undo)

- Slack interaction endpoint: `POST /api/slack/interactions`
- Modal submission inserts `pending_email_sends` with `send_at` ~10 seconds later.

Undo behavior:

- Slack posts a “Sending…” message with an Undo button
- Clicking Undo updates `pending_email_sends.status = 'cancelled'`

Email sending:

- Fast path: `api/slack.js` uses `setTimeout()` to send after the delay
- Safety net: cron endpoint `POST /api/jobs/process-pending-emails` sends any pending emails whose `send_at` has passed

On success, a confirmation block is posted into the Slack thread and `pending_email_sends` is marked `sent`.

## Calendly → “Call Booked” Slack Update

### Webhook handling

- Endpoint: `POST /api/webhooks/calendly` (`api/calendly.js`)
- Signature verification:
  - If a signing key exists in `calendly_webhook_subscriptions`, the webhook verifies `calendly-webhook-signature`.
  - If no key exists, verification is skipped.

### Matching and skipping

When `event === 'invitee.created'`:

- If the email already exists in `samcart_orders`, the booking is treated as an existing member call and **no Slack notification is posted**.
- Otherwise, the handler tries to find a matching `typeform_applications` record:
  - email match first
  - name match fallback (last 30 days) if email match fails

### DB + Slack updates

- Sets `typeform_applications.call_booked_at` (only once; duplicates are skipped)
- Posts a “Call booked” block into the application’s Slack thread

## SamCart → Purchase Notification + Welcome Thread

### Entry point

- Endpoint: `POST /api/webhooks/samcart` (`api/webhooks.js`)

### DB writes

- Inserts `samcart_orders` (or updates if the order already exists)
- Sets `typeform_applications.purchased_at` if an email match exists

### Slack

If `CA_PRO_NOTIFICATIONS_SLACK_CHANNEL` is set:

1. Posts a purchase notification as a **top-level** message
2. Stores `slack_channel_id` + `slack_thread_ts` on `samcart_orders`
3. Immediately posts the **welcome thread** (thread replies) via `api/jobs.js#sendWelcomeThread`

Welcome thread contents:

- Typeform application block (if found)
- “Onboarding not completed yet” note
- Generated welcome message + copy link (to `/copy.html?text=...`)
- Stores message timestamps (`welcome_note_message_ts`, `welcome_message_ts`, `typeform_message_ts`) for later updates

### Monday Business Owner creation (optional)

If `MONDAY_API_TOKEN` is configured:

- A “Business Owner” item is created on SamCart purchase
- `samcart_orders.monday_item_id` is stored for later updates/sync

## OnboardingChat → Progress Saves + Completion

### Progress saves

- Endpoint: `POST /api/onboarding/save-progress` (`api/onboarding.js`)
- Client-side persistence: `localStorage` key `ca_pro_onboarding` (see `docs/02-partial-onboarding.md`)

Server-side behavior:

- Upserts `onboarding_submissions` by `session_id`
- Writes progress metadata (`progress_percentage`, `last_question`, `is_complete`, etc.)
- On the first email capture for a session: sets `typeform_applications.onboarding_started_at` (email match)

### Contact sync timing (Circle + ActiveCampaign)

Circle + ActiveCampaign sync is triggered **during progress saves** when *new* team-member/partner emails are added:

- Only newly-added emails since the previous save are synced (best-effort async)
- The APIs handle duplicates gracefully

### Completion behavior (runs once per session)

On first completion:

- Creates/updates `business_owners`
- Inserts `team_members` + `c_level_partners`
- Schedules a Monday sync (`onboarding_submissions.monday_sync_scheduled_at = NOW()`)
- Updates the Monday Business Owner “Company” field (if a SamCart order exists with `monday_item_id`)
- Updates the existing SamCart welcome thread with OnboardingChat data:
  - deletes the “not completed” note (if stored)
  - regenerates the welcome message with full Typeform + OnboardingChat context
  - updates the Typeform summary message to include OnboardingChat fields (if stored)
- Sets `typeform_applications.onboarding_completed_at`

## Status Tracking (Typeform Applications)

`typeform_applications` uses timestamps to represent where an applicant is in the pipeline:

- `emailed_at`: automated email sent
- `replied_at`: email reply received
- `call_booked_at`: Calendly call booked
- `purchased_at`: SamCart purchase received
- `onboarding_started_at`: onboarding chat started (email captured during progress saves)
- `onboarding_completed_at`: onboarding chat completed (**Chat Complete** in the admin UI)
- `whatsapp_joined_at`: member joined WhatsApp group (**Joined** / final status)

The admin dashboard also computes a `display_status` based on these timestamps.

## WhatsApp (Wasender) → Joined Status

Endpoint: `POST /api/webhooks/wasender` (`api/wasender.js`)

- Watches for group participant events (scope: `group-participants.update`).
- If `WASENDER_ALLOWED_GROUP_JIDS` is set, only those group JIDs will be processed.
- Matches the member to `typeform_applications` primarily by phone number (normalized to last 10 digits), with a best-effort email fallback via `business_owners` / `samcart_orders`.
- Sets `typeform_applications.whatsapp_joined_at` (first time only; idempotent).
- Mirrors onto `business_owners` (`whatsapp_joined = true`, `whatsapp_joined_at = NOW()` if empty).
- Posts a message into the member’s Purchase/Welcome Slack thread tagging Stefan (if `STEF_SLACK_MEMBER_ID` is set).

## Matching Strategy (Across Systems)

Matching typically uses:

1. **Email** (case-insensitive exact match)
2. **Phone** (normalized; last 10 digits)
3. **Name** (first + last, exact match; used in some places)

Because third-party redirects often strip query parameters, email is the most reliable join key.
