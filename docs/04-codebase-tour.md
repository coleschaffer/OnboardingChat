# Codebase Tour

Practical map of where behavior lives.

## Root Entrypoints

### `server.js`

- Express app boot
- pg Pool initialization (`DATABASE_URL`)
- raw-body middleware for Slack + Calendly signature verification
- route mounting for all `/api/*` modules
- static serving:
  - `/admin` -> `admin/`
  - `/` -> `public/`
- runtime schema migration pass (`runMigrations()`)
- Calendly webhook initialization (`lib/calendly.js`)

### `cron-worker.js`

Railway cron worker script. Calls:

- `/api/jobs/process-delayed-welcomes` (deprecated)
- `/api/jobs/process-monday-syncs`
- `/api/jobs/process-email-replies`
- `/api/jobs/process-yearly-renewals`
- `/api/jobs/process-pending-emails`

Uses `x-cron-secret` header.

## API Routers (`api/`)

### Pipeline/webhooks

- `api/webhooks.js`
  - Typeform webhook
  - SamCart order + subscription event webhook
  - welcome thread trigger + WhatsApp add logging
  - offboarding actions for delinquent/canceled members
- `api/calendly.js`
  - Calendly webhook (`invitee.created`)
- `api/wasender.js`
  - WhatsApp join webhook handling

### Slack

- `api/slack.js`
  - Slack signature verification middleware
  - interactions (modals, shortcuts, undo/send workflow)
  - commands (`/note`)
  - events (DM member lookup + thread welcome edits)
  - helper endpoints (`send-welcome`, `users`)
- `api/slack-threads.js`
  - Slack Web API wrappers (`post/update/delete/open modal`)
  - application/purchase thread helper functions
  - welcome update and note mirroring helpers

### Onboarding

- `api/onboarding.js`
  - progress saves and completion processing
  - business owner/team/partner creation
  - incremental Circle/ActiveCampaign sync hooks
  - onboarding admin endpoints

### Jobs/cron

- `api/jobs.js`
  - Monday sync job
  - yearly renewal notices job
  - email reply processing job
  - pending send processing job
  - reset/test endpoints
  - exports `sendWelcomeThread()` and `generateWelcomeMessage()`

### Admin CRUD/data endpoints

- `api/applications.js`
- `api/members.js`
- `api/team-members.js`
- `api/notes.js`
- `api/cancellations.js`
- `api/import.js`
- `api/stats.js`
- `api/validate.js`

### Integrations

- `api/monday.js` (board sync, BO/team/partner operations)
- `api/circle.js` (member invite/access-group + removals)
- `api/activecampaign.js` (contact/tag/list sync)

## Libraries (`lib/`)

- `lib/gmail.js`: OAuth refresh, send email, poll thread replies
- `lib/slack-blocks.js`: reusable Block Kit payload builders
- `lib/calendly.js`: Calendly API + webhook signing verification
- `lib/notes.js`: note create/sync shared logic
- `lib/typeform.js`: optional Typeform API sync client
- `lib/time.js`: ET date-key/time helpers
- `lib/billing-utils.js`: money parsing/formatting + renewal copy helpers
- `lib/member-threads.js`: create/find/update member thread records
- `lib/wasender-client.js`: add/remove participants in WhatsApp groups
- `lib/whatsapp-actions.js`: batch add helper + summary formatter
- `lib/whatsapp-groups.js`: configured group-key mappings

## Frontend

### Public onboarding chat (`public/`)

- `public/index.html`: chat shell
- `public/script.js`: question flow, local resume, backend progress save
- `public/styles.css`: chat styles
- `public/copy.html`: copy-to-clipboard helper page for Slack buttons

### Admin dashboard (`admin/`)

- `admin/index.html`: dashboard structure/tabs
- `admin/script.js`: client-side auth gate + API-driven views
- `admin/styles.css`: dashboard visuals, tables, panel layout

Notable admin behavior:

- hardcoded password gate (`ADMIN_PASSWORD = '2323'`)
- kanban pipeline with drag/drop stage updates
- detail side panel replacing old modal pattern
- built-in test triggers for subscription flows and yearly renewals

## Database and Scripts (`db/`)

- `db/schema.sql`: base schema
- `db/migrations/*.sql`: manual migration scripts
- `db/import.js`: CSV CLI import tool
- `db/run-schema.js`: schema bootstrap helper

## Where To Change Common Behaviors

- Typeform parsing or post-submit automation: `api/webhooks.js`
- Slack thread block layout: `lib/slack-blocks.js`
- Welcome generation prompt/model: `api/jobs.js` and `api/slack.js`
- Onboarding question flow: `public/script.js`
- Pipeline stage logic in admin: `api/applications.js` + `admin/script.js`
- Monday board/column mappings: `api/monday.js`
- Offboarding actions: `api/webhooks.js` + `api/circle.js` + `lib/wasender-client.js`
