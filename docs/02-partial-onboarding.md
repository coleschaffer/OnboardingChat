# Partial Onboarding Support

## Overview

This feature enables the system to capture and track partially completed onboarding submissions. Users who start the onboarding process but don't finish will still have their progress saved to the database, allowing administrators to see incomplete submissions and potentially follow up.

## How It Works

### Session Management
- When a user starts the onboarding chat, a unique session ID is generated and stored in `sessionStorage`
- This session ID persists across browser refreshes (within the same tab/session)
- The session ID is cleared upon successful completion

### Progress Saving
- After each question is answered, the system automatically saves progress to the backend
- The save includes:
  - All answers collected so far
  - Any team members or C-level partners added
  - Current question number
  - Progress percentage
  - Last question answered

### Completion Status
- Submissions are tracked as either **complete** or **incomplete**
- CSV imports are automatically marked as **complete** (100% progress) since those users already provided their data
- Chat onboarding submissions start as incomplete and become complete when the user finishes all questions

## Database Changes

### business_owners Table
Added columns:
- `onboarding_progress` INTEGER (0-100) - Tracks completion percentage
- `last_question_answered` VARCHAR(100) - ID of the last question answered

### onboarding_submissions Table
Added columns:
- `session_id` VARCHAR(255) UNIQUE - Links multiple saves from same session
- `progress_percentage` INTEGER - Progress at time of save (0-100)
- `last_question` VARCHAR(100) - Question ID where user left off
- `is_complete` BOOLEAN - Whether submission is finished
- `updated_at` TIMESTAMP - Last update time (auto-updated via trigger)

## API Changes

### New Endpoint: `POST /api/onboarding/save-progress`

Saves partial or complete onboarding data.

**Request Body:**
```json
{
  "sessionId": "session_123_abc",
  "answers": {
    "businessName": "Acme Corp",
    "teamCount": "5",
    "lastQuestionId": "trafficSources"
  },
  "teamMembers": [],
  "cLevelPartners": [],
  "currentQuestion": 4,
  "totalQuestions": 13,
  "isComplete": false
}
```

**Response:**
```json
{
  "success": true,
  "sessionId": "session_123_abc",
  "submissionId": "uuid",
  "businessOwnerId": null,
  "progress": 30,
  "isComplete": false
}
```

### Updated: `GET /api/onboarding/submissions`

Now supports filtering by completion status.

**Query Parameters:**
- `complete` - Filter by completion status (`true` or `false`)
- `search` - Search by name, email, business name
- `limit` - Page size (default 50)
- `offset` - Page offset

**Response:**
```json
{
  "submissions": [...],
  "counts": {
    "complete": 45,
    "incomplete": 12,
    "total": 57
  },
  "limit": 50,
  "offset": 0
}
```

### New Endpoint: `GET /api/onboarding/session/:sessionId`

Retrieves a submission by session ID (for potential resume functionality).

## Admin Dashboard Updates

### Onboarding Tab Changes

1. **Stats Display** - Now shows:
   - Members Pending (from business_owners.onboarding_status)
   - Incomplete Submissions (from onboarding_submissions.is_complete = false)
   - Complete Submissions (from onboarding_submissions.is_complete = true)

2. **Submissions Table** - New columns:
   - Session ID (truncated for display)
   - Progress bar with percentage
   - Last Question answered
   - Status badge (Complete/Incomplete)
   - Updated timestamp

3. **Filters**:
   - Search box for submissions
   - Filter dropdown: All / Complete / Incomplete

## CSV Import Behavior

When importing from CSV files:
- All records are automatically marked as `onboarding_status = 'completed'`
- Progress is set to 100%
- This is because CSV data represents users who have already provided their information through Google Forms

## Migration

For existing databases, run the migration script:

```bash
psql $DATABASE_URL < db/migrations/001-add-partial-onboarding.sql
```

This migration:
1. Adds new columns to `business_owners` and `onboarding_submissions`
2. Creates necessary indexes
3. Updates existing CSV-imported records to be marked as complete
4. Updates existing completed submissions to have `is_complete = true`

## Frontend Changes

### Chat Interface (`public/script.js`)

1. **Session ID Generation**
   - Generates unique session ID on page load
   - Stores in `sessionStorage` (persists across refresh, cleared on tab close)

2. **Auto-Save After Each Question**
   - `saveProgress()` function called after every answer
   - Sends current state to `/api/onboarding/save-progress`
   - Non-blocking (doesn't delay UI)

3. **Completion Flow**
   - Final save called with `isComplete: true`
   - Session ID cleared from storage
   - Business owner record created/updated

## Use Cases

### Tracking Abandoned Onboardings
1. Admin views Onboarding tab
2. Filters to "Incomplete" submissions
3. Sees progress percentage and last question for each
4. Can view submission data to see what was collected
5. Can follow up with users who got far but didn't finish

### Resuming Onboarding (Future Enhancement)
The session tracking infrastructure enables a future "resume" feature where users could:
1. Return to the onboarding page
2. System detects existing session
3. Prompts to resume from where they left off
4. Pre-fills previous answers

## Technical Notes

- Progress saves are fire-and-forget (UI doesn't wait for response)
- Failed saves are logged but don't interrupt user experience
- Session IDs are formatted as `session_{timestamp}_{random}`
- The `updated_at` trigger ensures accurate timestamps for sorting
