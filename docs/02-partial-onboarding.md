# Partial Onboarding + Resume Behavior

The public onboarding chat supports resume/recovery by storing progress both client-side and server-side.

## Client-Side State

File: `public/script.js`

- Local storage key: `ca_pro_onboarding`
- Stored fields:
  - `sessionId`
  - `currentQuestion`
  - `answers`
  - `teamMembers`
  - `cLevelPartners`
  - `hasTeamMembers` (AI validation result)
  - `isComplete`

Behavior on page load:

- If `isComplete=true`: show completion screen immediately
- Else if `currentQuestion > 0`: replay prior Q/A and resume where user left off
- Else: start fresh onboarding flow

## Team Count Skip Logic

After answering the `teamCount` question:

- client calls `POST /api/validate-team-count`
- if response says no team members, `teamMembers` step is skipped
- fallback heuristic is used if Anthropic is unavailable

## Server-Side Progress API

Endpoint: `POST /api/onboarding/save-progress`

Request includes:

- `sessionId`
- `answers`
- `teamMembers`
- `cLevelPartners`
- `currentQuestion`
- `totalQuestions`
- `isComplete`

Server behavior:

- Upsert into `onboarding_submissions` by `session_id`
- Save data JSON: `{ answers, teamMembers, cLevelPartners }`
- Update progress metadata:
  - `progress_percentage`
  - `last_question`
  - `is_complete` / `completed_at`

## Side Effects During Progress Saves

### Onboarding started timestamp

When email appears for the first time in a session:

- set `typeform_applications.onboarding_started_at`
- write `activity_log` entry (`onboarding_started`)

### New team/partner contact sync

For newly-added emails (diffed against previous save):

- sync to Circle (`api/circle.js`) async, best effort
- sync to ActiveCampaign (`api/activecampaign.js`) async, best effort
- log WhatsApp group-add summary into purchase thread when possible

## Completion Processing (One-Time)

Completion executes only when transitioning from incomplete to complete.

Actions:

- create or update `business_owners`
- insert `team_members`
- insert `c_level_partners`
- link submission row to `business_owner_id`
- schedule Monday sync now (`monday_sync_scheduled_at = NOW()`)
- attempt Monday Company field update via SamCart `monday_item_id`
- update SamCart welcome thread with onboarding context
- set `typeform_applications.onboarding_completed_at`
- log onboarding completion activity

## Admin Endpoints For Onboarding Data

- `GET /api/onboarding/submissions`
- `GET /api/onboarding/submissions/:id`
- `GET /api/onboarding/session/:sessionId`
- `POST /api/onboarding/submissions/:id/complete`
- `DELETE /api/onboarding/submissions/:id`
- `GET /api/onboarding/status`

## Database Fields Used

### `onboarding_submissions`

- `session_id`
- `data` (JSONB)
- `progress_percentage`
- `last_question`
- `is_complete`
- `completed_at`
- `monday_sync_scheduled_at`
- `monday_synced`
- `monday_synced_at`

### `business_owners`

- `onboarding_status`
- `onboarding_progress`
- `last_question_answered`
