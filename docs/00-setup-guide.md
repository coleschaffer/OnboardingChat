# CA Pro Onboarding System - Setup Guide

## Prerequisites

- Node.js 18+ installed
- PostgreSQL database (Railway recommended)
- Typeform account (for webhook integration)

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
DATABASE_URL=postgresql://user:password@host:port/database
TYPEFORM_TOKEN=your_typeform_api_token
TYPEFORM_FORM_ID=q6umv3xg
TYPEFORM_WEBHOOK_SECRET=your_webhook_secret
PORT=3000
NODE_ENV=development
```

### 3. Set Up Database

Run the schema against your PostgreSQL database:

```bash
# Using psql directly
psql $DATABASE_URL < db/schema.sql

# Or through Railway CLI
railway run psql < db/schema.sql
```

### 4. Import Historical Data (Optional)

If you have existing data in CSV files:

```bash
# Import business owners
npm run import -- --business-owners "CA PRO New Member Onboarding Form (Business Owner) (Responses) - Form Responses 1.csv"

# Import team members
npm run import -- --team-members "CA PRO New Member Onboarding Form (Team Members) (Responses) - Form Responses 1.csv"

# Or import both default files
npm run import -- --all
```

### 5. Configure Typeform Webhook

1. Log into Typeform dashboard
2. Go to your form's Connect > Webhooks
3. Add webhook URL: `https://your-domain.com/api/webhooks/typeform`
4. (Optional) Set a webhook secret for signature verification
5. Save the webhook

### 6. Start the Server

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

### 7. Access the Application

- **Chat Interface**: http://localhost:3000
- **Admin Dashboard**: http://localhost:3000/admin

## Deployment to Railway

### Via Railway CLI

```bash
# Login to Railway
railway login

# Link to your project
railway link

# Deploy
railway up
```

### Via GitHub Integration

1. Push code to GitHub
2. Connect Railway to your GitHub repo
3. Railway will auto-deploy on push

### Environment Variables

Set these in Railway dashboard or via CLI:

```bash
railway variables set DATABASE_URL=...
railway variables set TYPEFORM_TOKEN=...
railway variables set TYPEFORM_FORM_ID=q6umv3xg
railway variables set NODE_ENV=production
```

## File Structure

```
/
├── server.js              # Express server
├── package.json           # Dependencies & scripts
├── .env.example           # Environment template
├── /public                # Chat interface (served at /)
│   ├── index.html
│   ├── styles.css
│   ├── script.js
│   └── CA_Favicon.png
├── /admin                 # Admin dashboard (served at /admin)
│   ├── index.html
│   ├── styles.css
│   └── script.js
├── /api                   # API routes
│   ├── members.js         # Business owners CRUD
│   ├── team-members.js    # Team members CRUD
│   ├── applications.js    # Typeform applications
│   ├── onboarding.js      # Onboarding submissions
│   ├── webhooks.js        # Typeform webhook
│   ├── import.js          # CSV import API
│   └── stats.js           # Dashboard stats
├── /db
│   ├── schema.sql         # Database schema
│   ├── import.js          # CLI import script
│   └── /migrations        # Database migrations
└── /lib
    └── typeform.js        # Typeform API client
```

## Troubleshooting

### Database Connection Issues

1. Verify DATABASE_URL is correct
2. Check SSL settings (production requires SSL)
3. Ensure IP is whitelisted if using external DB

### Typeform Webhook Not Working

1. Verify webhook URL is accessible (HTTPS required)
2. Check webhook secret matches
3. Look at Railway logs for errors

### CSV Import Fails

1. Check file encoding (UTF-8 required)
2. Verify column headers match expected format
3. Check for special characters in data

## Available Scripts

- `npm start` - Start production server
- `npm run dev` - Start development server with auto-reload
- `npm run import -- --all` - Import CSV files from project root
- `npm run import -- --business-owners <file>` - Import business owners CSV
- `npm run import -- --team-members <file>` - Import team members CSV
