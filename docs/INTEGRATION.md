# CA Pro Onboarding Integration Guide

This document explains how Typeform, SamCart, and OnboardingChat work together to onboard new CA Pro members.

## System Overview

```
┌─────────────┐     ┌─────────────┐     ┌─────────────────┐     ┌─────────────┐
│   Typeform  │ ──► │   SamCart   │ ──► │  OnboardingChat │ ──► │    Slack    │
│ Application │     │  Checkout   │     │    Interface    │     │  Workflow   │
└─────────────┘     └─────────────┘     └─────────────────┘     └─────────────┘
       │                   │                     │                     │
       ▼                   ▼                     ▼                     ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │                         PostgreSQL Database                          │
  │  typeform_applications │ samcart_orders │ business_owners │ etc.    │
  └──────────────────────────────────────────────────────────────────────┘
```

## User Journey

1. **Typeform Application** - User fills out the CA Pro application form
2. **SamCart Purchase** - After approval, user completes purchase on SamCart
3. **OnboardingChat** - User is redirected to complete the onboarding chat
4. **Slack Notification** - Team receives threaded notification with all data

## Data Flow

### 1. Typeform Application (Webhook)

**Endpoint:** `POST /api/webhooks/typeform`

When someone submits the Typeform application:
- Typeform sends a webhook to our server
- We parse the form response and extract key fields:
  - `first_name`, `last_name`
  - `email`, `phone`
  - `business_description`
  - `annual_revenue`
  - `main_challenge`
  - `why_ca_pro`
- Data is stored in `typeform_applications` table
- Activity logged: `new_application`

**Field Matching:** The webhook uses keyword matching on question titles:
- Revenue: looks for "revenue" or "sales" in title
- Challenge: looks for "holding", "scaling", "#1", "challenge"
- Why CA Pro: looks for "ca pro", "made you want", "specifically", "apply"

### 2. SamCart Purchase (Webhook)

**Endpoint:** `POST /api/webhooks/samcart`

When someone completes a purchase:
- SamCart sends a webhook with order details
- We extract:
  - `email`, `first_name`, `last_name`, `phone`
  - `product_name`, `order_total`, `currency`
- Data is stored in `samcart_orders` table
- If email matches a Typeform application, status is updated to "approved"
- Activity logged: `new_payment`

**SamCart Configuration:**
- Add Notify URL: `https://your-domain.com/api/webhooks/samcart`
- Configure checkout redirect URL: `https://your-domain.com`

### 3. OnboardingChat Submission

**Endpoint:** `POST /api/onboarding/submit`

When someone completes the onboarding chat:
- All chat responses are collected including:
  - `email` (first question - used for matching)
  - `businessName`, `teamCount`, `trafficSources`
  - `landingPages`, `massiveWin`, `aiSkillLevel`
  - `bio`, team members, C-level partners
- A new `business_owner` record is created (or matched to existing)
- Team members and partners are stored separately
- Activity logged: `member_created`

## Data Matching Logic

Since SamCart strips URL parameters from redirect URLs, we use email as the primary matching key. The matching happens in three places:

### OnboardingChat → Typeform/SamCart Matching

When onboarding is submitted, we try to match to existing records using this fallback chain:

1. **Email Match** (Primary)
   ```sql
   LOWER(email) = LOWER($1)
   ```

2. **Phone Match** (Secondary)
   ```sql
   -- Strips non-digits and matches last 10 digits
   REPLACE(phone, '-', '') LIKE '%' || $1
   ```

3. **Name Match** (Tertiary)
   ```sql
   LOWER(first_name) = LOWER($1) AND LOWER(last_name) = LOWER($2)
   ```

### Unified Profile API

**Endpoint:** `GET /api/members/:id/unified`

Returns a business owner with all linked data:
- Business owner details
- Team members
- C-level partners
- Linked Typeform application (if matched)
- Linked SamCart order (if matched)

## Slack Integration

When onboarding is completed, a threaded Slack message is sent:

### Parent Message (Overview)
- Member name and email
- Business name and size
- Quick stats

### Thread Messages
1. **Typeform Data** - Application answers (if matched)
2. **SamCart Data** - Purchase details (if matched)
3. **OnboardingChat Data** - Full onboarding responses
4. **Welcome Message** - Generated AI welcome with Copy/Edit buttons

### Slack App Configuration

Required scopes:
- `chat:write` - Send messages
- `reactions:write` - Add reactions
- `message.im` - Receive DM responses (for Edit functionality)

Enable Event Subscriptions:
- Request URL: `https://your-domain.com/api/slack/events`
- Subscribe to: `message.im`

## Database Schema

### Key Tables

**typeform_applications**
```sql
- id (UUID, PK)
- typeform_response_id (unique)
- first_name, last_name, email, phone
- business_description, annual_revenue
- main_challenge, why_ca_pro
- status (new | reviewed | approved | rejected)
- raw_data (JSONB)
```

**samcart_orders**
```sql
- id (UUID, PK)
- samcart_order_id (unique)
- email, first_name, last_name, phone
- product_name, product_id
- order_total, currency, status
- raw_data (JSONB)
```

**business_owners**
```sql
- id (UUID, PK)
- first_name, last_name, email, phone
- business_name, business_overview
- annual_revenue, team_count
- source (typeform | csv_import | chat_onboarding)
- onboarding_status (pending | in_progress | completed)
```

**activity_log**
```sql
- id (UUID, PK)
- action (new_application | new_payment | member_created | record_matched)
- entity_type, entity_id
- details (JSONB)
```

## Environment Variables

```env
DATABASE_URL=postgresql://...
TYPEFORM_TOKEN=xxx
TYPEFORM_FORM_ID=q6umv3xg
TYPEFORM_WEBHOOK_SECRET=xxx (optional)
SLACK_BOT_TOKEN=xoxb-xxx
SLACK_CHANNEL_ID=xxx
PORT=3000
```

## Admin Dashboard

Access at `/admin`

### Tabs
- **Overview** - Stats and activity feed
- **Members** - Business owners with unified profile view
- **Team Members** - All team members across companies
- **Typeform** - Applications with status management
- **Onboarding** - Chat submission tracking

### Features
- Search and filter on all tabs
- Kebab menus with View Data and Delete options
- Unified profile view showing linked Typeform/SamCart data
- Activity feed with payment and matching notifications

## Troubleshooting

### Typeform Fields Not Capturing
Check the question titles in your Typeform match the keywords in `api/webhooks.js`. The webhook looks for specific phrases like "revenue", "ca pro", "holding", etc.

### SamCart Data Not Linking
Since SamCart strips URL parameters, matching relies on email. Ensure:
1. Customer uses the same email in Typeform, SamCart, and OnboardingChat
2. The email question is answered in OnboardingChat

### Slack Messages Not Sending
1. Check `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID` are set
2. Verify the bot is invited to the channel
3. Check server logs for API errors

### Edit Button "Sending messages turned off"
Enable Event Subscriptions in Slack app settings and add `message.im` scope.

## Future Improvements

1. **SamCart API Integration** - Once access is granted, use API to fetch order data directly instead of relying on webhooks
2. **Automatic Email Matching** - Pre-populate email in OnboardingChat from SamCart redirect (requires SamCart API)
3. **Duplicate Detection** - Flag potential duplicate applications across systems
