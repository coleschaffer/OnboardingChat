# Security Risks + Hardening Priorities

This document lists the major current security risks discovered from source review.

## Critical / High Priority

### 1) Admin auth is client-side only

Location: `admin/script.js`

- hardcoded password (`ADMIN_PASSWORD = '2323'`)
- auth state stored in `sessionStorage`
- backend endpoints are not protected by admin auth

Impact:

- anyone with network access to app can call admin APIs directly

Mitigation:

- put real authentication/authorization in front of admin and API (SSO, reverse-proxy auth, or app-level auth)

### 2) Unauthenticated force job endpoint

Location: `api/jobs.js`

- `POST /api/jobs/process-yearly-renewals/force` does not verify `CRON_SECRET`

Impact:

- external callers can trigger renewal notices and side effects

Mitigation:

- require cron secret or admin auth for this route
- restrict ingress by IP/auth gateway

### 3) Hardcoded fallback Circle API tokens in source

Location: `api/circle.js`

- fallback tokens are embedded in `CIRCLE_CONFIG`

Impact:

- secret exposure risk in repository/runtime logs

Mitigation:

- remove hardcoded tokens
- require env vars only
- rotate compromised tokens

## Medium Priority

### 4) Broad trust on internal/test endpoints

Examples:

- subscription simulation endpoints in `api/applications.js`
- reset/test job endpoints in `api/jobs.js`

Risk:

- if admin/API is reachable without access control, these can alter production state

Mitigation:

- gate with auth role or disable outside non-production

### 5) Schema drift and implicit migrations

Location: runtime migration logic in `server.js`

Risk:

- inconsistent schema across environments increases chance of runtime errors or bypassed assumptions

Mitigation:

- adopt single migration source with tracked migration history table

### 6) Mixed verification coverage

- Typeform verification only when secret set
- Calendly verification only when signing key available
- some helper/admin endpoints have no request auth

Mitigation:

- enforce secrets in production env validation
- fail startup when required secrets are missing (for prod)

## Operational Safeguards To Add

- enforce HTTPS-only ingress
- limit public exposure of admin/API via network policy (VPN, Cloudflare Access, etc.)
- add rate limits for webhook and Slack endpoints
- centralized request logging with alerting for sensitive endpoints
- secrets scanning in CI

## Immediate Action Plan

1. protect admin + API with real auth
2. secure `process-yearly-renewals/force`
3. remove Circle fallback tokens and rotate keys
4. lock external ingress for non-webhook routes
5. add production startup checks for required secrets
