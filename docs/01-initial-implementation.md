# Initial Implementation (Historical Archive)

This file is intentionally historical.

It refers to the original v1 build before the current production additions:

- Slack threaded operations (notes, replies, welcome edits)
- SamCart subscription lifecycle handling (fail/recover/cancel/delinquent)
- yearly renewals job
- cancellations/offboarding automation
- Wasender join tracking
- expanded Monday/Circle/ActiveCampaign integrations

For current behavior, use:

- [`README.md`](README.md)
- [`INTEGRATION.md`](INTEGRATION.md)
- [`03-database-schema.md`](03-database-schema.md)
- [`05-api-reference.md`](05-api-reference.md)

## Why this file exists

The original implementation context is retained so prior decisions and migration history remain traceable.

Do not use this file as the source of truth for current endpoint surface, schema, or job behavior.
