# Partial Onboarding + Resume Support

## Overview

The onboarding chat supports **partial saves** so a member can refresh/leave and resume later. Progress is stored in:

- **Client**: `localStorage` (fast resume in the browser)
- **Server**: `onboarding_submissions` (admin visibility + recovery)

## Client Behavior (Public Chat)

Implemented in `public/script.js`:

- **Storage key**: `ca_pro_onboarding` (in `localStorage`)
- Stored data:
  - `sessionId`, `currentQuestion`
  - `answers`
  - `teamMembers`, `cLevelPartners`
  - `hasTeamMembers` (AI validation result)
  - `isComplete`
- On load:
  - If `isComplete` is true → shows the completion screen immediately
  - Else if `currentQuestion > 0` → replays prior Q&A and resumes at the saved question

### Team Step Skipping (AI + Fallback)

After the user answers the **Team Count** question, the client calls:

- `POST /api/validate-team-count`

If the response indicates *no* team members, the chat skips the `teamMembers` step.

## Backend Behavior (Progress Saves)

### `POST /api/onboarding/save-progress`

The browser calls this after each answer. The request includes:

- `sessionId`
- `answers` (plus `answers.lastQuestionId` for tracking)
- `teamMembers`, `cLevelPartners`
- `currentQuestion`, `totalQuestions`
- `isComplete`

The server stores/updates a row in `onboarding_submissions` keyed by `session_id`:

- `data` = `{ answers, teamMembers, cLevelPartners }`
- `progress_percentage` = `round(currentQuestion / totalQuestions * 100)`
- `last_question` = `answers.lastQuestionId`
- `is_complete`, `completed_at`

Additional side-effects during progress saves:

- On the **first** save where an email is present, the server sets `typeform_applications.onboarding_started_at` (email match).
- When **new** team-member/partner emails appear (compared to the previous save), the server triggers best-effort async syncs:
  - Circle (`api/circle.js`)
  - ActiveCampaign (`api/activecampaign.js`)

### Completion Processing (Runs Once)

When a submission becomes complete for the **first** time, the server additionally:

- Creates/updates `business_owners`
- Inserts `team_members` and `c_level_partners`
- Sets `onboarding_submissions.monday_sync_scheduled_at = NOW()` (for the cron-driven Monday sync)
- Sets `typeform_applications.onboarding_completed_at` (if email matches)
- Updates an existing SamCart welcome thread with onboarding data (if a thread exists)

## Admin Dashboard Support

The **Onboarding** tab in `/admin` uses:

- `GET /api/onboarding/submissions` (filter by `complete=true|false`)
- `GET /api/onboarding/submissions/:id`
- `GET /api/onboarding/session/:sessionId`
- `POST /api/onboarding/submissions/:id/complete`
- `DELETE /api/onboarding/submissions/:id`

## Database Fields Involved

### `onboarding_submissions`

- `session_id` (unique)
- `data` (JSONB)
- `progress_percentage`
- `last_question`
- `is_complete`, `completed_at`
- `created_at`, `updated_at`
- `monday_sync_scheduled_at`, `monday_synced`, `monday_synced_at`

### `business_owners` (progress metadata)

- `onboarding_status`
- `onboarding_progress`
- `last_question_answered`

## Migration Notes

- `db/migrations/001-add-partial-onboarding.sql` adds the original partial-onboarding columns/indexes.

## Testing Checklist

1. Start onboarding, answer a few questions.
2. Refresh: confirm the chat resumes.
3. Confirm `onboarding_submissions` updates the same `session_id`.
4. Complete onboarding: confirm `is_complete=true` and downstream processing runs once.
