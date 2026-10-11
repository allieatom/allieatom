# rewards-service

Self-hosted loyalty & referrals for Better Rhodes. Replaces Yotpo Loyalty & Referrals while keeping the customer-facing behaviour identical: same earning rules, same $5/$10/$15/$20 single-use codes, same `swell_vip_*` customer tags, and the same Klaviyo event and profile-property names so every existing flow keeps firing.

Status: **foundation complete, not yet deployed.** See "What's done / what's left" below.

## How it fits together

```
Shopify (orders, customers) --webhooks--> rewards-service --> Postgres ledger
Storefront widget --/apps/rewards/* (signed app proxy)--> rewards-service
rewards-service --outbox--> Klaviyo events + profile properties (Yotpo names)
rewards-service --outbox--> Shopify tags (swell_vip_*) + customer metafields (rewards.*)
rewards-service --Admin API--> Shopify discount codes for redemptions and referral friend codes
```

- `config/rules.json` is the program definition, derived from live Yotpo data on 2026-10-11: 1 point per $1 of order subtotal (after discounts, before shipping/tax, floored), +225 for a $200+ order, +60 for creating an account, +100 on birthday, +200 when a referred friend places their first order, 100/200/300/400 points for $5/$10/$15/$20, friend gets 10% off, points expire 12 months after the last earning activity (date-truncated). Gold and Platinum spend thresholds are still unknown and marked `todo`.
- `src/domain/*`: ledger (append-only, idempotent, cached balance), earning, tiers, expiry, members.
- `src/services/loyalty.ts`: the orchestration (orders, refunds, cancellations, redemptions, referrals, birthdays, projections).
- `src/shopify/*`: webhook HMAC + app-proxy signature verification, Admin GraphQL client, payload mapping.
- `src/klaviyo/*`: Yotpo-compatible metric names/payloads and a durable outbox with retry.
- `src/http/*`: `/webhooks/shopify`, `/proxy/*` (storefront), `/admin/*` (bearer token), `/healthz`.

## Run locally

```bash
cp .env.example .env            # fill in Shopify + Klaviyo values; keep KLAVIYO_EMIT_ENABLED=false and SHOPIFY_SYNC_ENABLED=false until cutover
npm install
npm run typecheck && npm test   # tests run against in-process Postgres (PGlite), no database needed
npm run migrate                 # applies db/migrations to DATABASE_URL
npm run dev                     # http://localhost:8080/healthz
```

Scheduled jobs (run daily via cron or the platform scheduler): `POST /admin/jobs/expire`, `POST /admin/jobs/birthdays`, or `npm run expire`.

## Shopify custom app setup (Stage 1)

1. Create a custom app on the Better Rhodes store with scopes `read_orders, read_customers, write_customers, write_discounts, read_discounts`.
2. Webhooks (JSON) to `https://<host>/webhooks/shopify`: `orders/paid`, `orders/cancelled`, `refunds/create`, `customers/create`, `customers/update`, `customers/delete`, plus the mandatory `customers/data_request`, `customers/redact`, `shop/redact`.
3. App proxy: subpath prefix `apps`, subpath `rewards`, proxy URL `https://<host>/proxy`. The storefront then calls `/apps/rewards/me`, `/apps/rewards/redeem`, `/apps/rewards/referral/share`, `/apps/rewards/referral/claim`, `/apps/rewards/opt-in`.
4. Put the API secret in `SHOPIFY_API_SECRET` (verifies webhooks and proxy signatures) and the Admin token in `SHOPIFY_ADMIN_ACCESS_TOKEN`.

## Feature flags for a safe shadow run

- `KLAVIYO_EMIT_ENABLED=false`: events and profile updates are written to the outbox and marked `skipped`, so nothing reaches Klaviyo until cutover.
- `SHOPIFY_SYNC_ENABLED=false`: tag and metafield writes are likewise held. Discount-code creation for redemptions is not flagged because redemptions can only be triggered through the storefront widget, which is not installed until cutover.

## What's done / what's left

Done (tested): ledger, rules, earning, tiers, expiry, order/refund/cancel handling, account-creation bonus, birthday job, redemptions with Shopify code issuance and rollback on failure, referrals (friend code claim, completion on first paid order, self-referral guard, replay-safe), Klaviyo payload parity, outbox with backoff, webhook dedupe, signed proxy, admin API.

Done (tested) as well: importer from a Klaviyo profile export + Shopify customer export (`npm run import -- --klaviyo profiles.csv --shopify customers.csv --snapshot YYYY-MM-DD [--dry-run]`), idempotent and delta-aware, plus a Yotpo API client/mapper for when the Yotpo account is unlocked.

Left: storefront widgets + theme app extension (needs visual capture of the live Yotpo widgets), tier demotion at tier end, reminder jobs (points / redemption / referral-share / expiration reminders), deployment manifests, live verification against a Klaviyo test profile and a Shopify development store.
