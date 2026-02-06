# Integrations + End-to-End Data Flow

This document describes how external systems interact with the app and database.

## Integration Map

- Typeform -> application intake + initial outreach
- Gmail -> outbound email + reply polling
- Slack -> operator workflow surface (threads, notes, replies, lookups)
- Calendly -> call-booked status updates
- SamCart -> orders + subscription lifecycle + offboarding triggers
- Monday.com -> business owner/team/partner synchronization
- Circle + ActiveCampaign -> member/team/partner contact sync
- Wasender -> WhatsApp join detection and group add/remove actions

## Slack Architecture (Two Main Thread Families)

### Application threads (`CA_PRO_APPLICATION_SLACK_CHANNEL_ID`)

Created when Typeform webhook is received.

Typical thread content:

- full Typeform application block
- WhatsApp follow-up template
- email sent/failed block
- reply notifications with `Open Gmail` + `Send Reply`
- Calendly call-booked notification
- application notes synced from admin or Slack shortcuts

### Purchase/welcome threads (`CA_PRO_NOTIFICATIONS_SLACK_CHANNEL`)

Created on SamCart order notification.

Typical content:

- SamCart purchase top-level message
- Typeform summary block
- existing notes mirrored from application thread
- onboarding-not-complete note (later removed)
- generated welcome message + copy link
- edited welcome variants when users reply with change requests
- WhatsApp add/join updates and offboarding status summaries

### Slack operator shortcuts

- `add_application_note` (message shortcut)
  - resolves application by thread/email context
  - stores note in `application_notes`
  - syncs note to application thread and purchase thread
- `add_cancel_reason` (message shortcut)
  - resolves member by thread/email context
  - updates or inserts row in `cancellations`
  - posts cancellation reason block back to Slack thread

## Typeform -> Slack + Gmail

Entry endpoint: `POST /api/webhooks/typeform`

Flow:

1. Optional signature verification (`TYPEFORM_WEBHOOK_SECRET`)
2. Parse/match all 15 questions into mapped fields
3. Insert into `typeform_applications`
4. Async automation:
   - post application message + persist thread pointers
   - send Gmail outreach email (if configured)
   - insert `email_threads`
   - set `emailed_at`
   - post WhatsApp template and email result blocks

Idempotency:

- duplicate `typeform_response_id` is acknowledged and ignored

## Gmail Replies -> Slack Reply Workflow

Entry endpoint: `POST /api/jobs/process-email-replies`

Flow:

1. load active `email_threads`
2. poll Gmail thread for replies not from sender account
3. update reply counters/snippet/body and mark status
4. set `typeform_applications.replied_at` for first reply
5. post Slack reply block with:
   - Open Gmail button
   - Send Reply modal button

Send Reply flow:

- `POST /api/slack/interactions` receives modal submission
- row inserted into `pending_email_sends` with ~10 second delay
- “Sending…” message with Cancel button is posted
- send path:
  - immediate in-process timer (primary)
  - cron fallback `POST /api/jobs/process-pending-emails`

## Calendly -> Call Booked Status

Entry endpoint: `POST /api/webhooks/calendly`

Flow:

1. optional signature check via stored signing key
2. process only `invitee.created`
3. skip if email belongs to existing SamCart member
4. find application by email, then name fallback (30-day window)
5. set `call_booked_at` if not already set
6. post call-booked Slack message in application thread

## SamCart Order Events

Entry endpoint: `POST /api/webhooks/samcart`

Flow (order events):

1. normalize payload -> `orderData`
2. insert/update `samcart_orders`
3. set matched `typeform_applications.purchased_at`
4. post purchase notification in Slack
5. generate welcome thread (Typeform summary + generated message)
6. add business owner contact to configured WhatsApp groups (best effort)
7. optionally create Monday business owner item and store `monday_item_id`

## SamCart Subscription Events (Failure/Recovery/Cancel)

Same endpoint, normalized event handling path.

### Charge failed

- create/update `member_threads` for `monthly_bounce` + current month `period_key`
- count failure attempts this period
- post attempt message to thread
- on first attempt, post WhatsApp copy block
- on 4+ failures, trigger offboarding (once):
  - Monday BO status -> Canceled + date
  - Team Member statuses -> Canceled
  - Circle removals
  - Wasender group removals
  - offboarding summary posted in thread

### Charged / recovered

- post recovery message to monthly bounce thread
- store recovery marker in thread metadata

### Delinquent

- create/ensure monthly bounce thread
- trigger offboarding path (if not already done)

### Canceled

- create cancel thread (`thread_type='cancel'`)
- insert `cancellations` record
- trigger offboarding path (if not already done)

All subscription events are deduped by `event_key` in `samcart_subscription_events`.

## Yearly Renewals

Cron endpoint: `POST /api/jobs/process-yearly-renewals`

Behavior:

- requires Monday configured
- runs only during 9 AM ET window unless `force=true`
- computes due date = today + 7 days (ET)
- queries Monday BO board for matching next payment due date
- skips if monthly recurring amount exists (`numbers3` > 0)
- creates/uses `member_threads` with `thread_type='yearly_renewal'`
- posts WhatsApp renewal copy block
- sends renewal email via Gmail (if configured)
- stores email thread context for reply workflow

Force variant:

- `POST /api/jobs/process-yearly-renewals/force`

## Onboarding Progress + Completion

Entry endpoint: `POST /api/onboarding/save-progress`

Flow:

- upsert `onboarding_submissions` by `session_id`
- set `onboarding_started_at` on first email capture
- detect newly-added team/partner emails since previous save:
  - Circle sync
  - ActiveCampaign sync
  - WhatsApp add summary to purchase thread

On first completion transition:

- create/update `business_owners`
- insert `team_members` + `c_level_partners`
- set `monday_sync_scheduled_at = NOW()`
- update Monday company field via stored `monday_item_id`
- update welcome thread with full onboarding context
- set `onboarding_completed_at`

Monday team/partner sync executes via cron job `process-monday-syncs`.

## Wasender Join Webhook

Entry endpoint: `POST /api/webhooks/wasender`

Flow:

1. optional shared-secret auth
2. process only participant add/invite/join actions
3. optional allowed-group filter (`WASENDER_ALLOWED_GROUP_JIDS`)
4. match person primarily by phone last-10 digits
5. fallback via `business_owners`/`samcart_orders` email mapping
6. set `typeform_applications.whatsapp_joined_at` once
7. set `business_owners.whatsapp_joined=true` and timestamp
8. post joined message into purchase thread

## Circle + ActiveCampaign Sync Timing

Triggered in onboarding progress path when new emails are added, not only at final completion.

- team members and partners are synced independently
- operations are best effort and non-blocking
- duplicates are tolerated by integration code

## Slack DM Member Lookup

`POST /api/slack/events` also handles direct messages to the bot:

- input: first name, full name, or email
- lookup priority:
  1. typeform applications
  2. business owners
  3. samcart orders
- if exact unique match found: return structured profile blocks
- if multiple matches: return disambiguation list

## Matching Strategy Across Systems

Primary keys used for cross-system joins:

1. email (preferred)
2. phone last-10 digits
3. first+last name fallback (limited scenarios)

Recommendation:

- preserve email consistently across Typeform/SamCart/Onboarding to minimize ambiguous matching.
