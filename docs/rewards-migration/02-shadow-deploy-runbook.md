# Runbook: deploy the shadow instance

Goal: the rewards-service runs on real Better Rhodes order traffic and keeps its own ledger, while customers keep seeing Yotpo. Nothing customer-visible changes. Both outbound flags stay off, so no event reaches Klaviyo and no tag or metafield is written to Shopify.

Time: about 30 minutes, all in web dashboards. No command line needed.

What you'll end up with
- A web service at `https://betterrhodes-rewards.onrender.com` (Render may add a suffix), Postgres, and a nightly job.
- A Shopify custom app token and six store-level webhooks pointing at the service.
- Monthly cost around $15 (web $7, Postgres $6, cron about $1).

Have ready: Shopify admin login with permission to develop apps, a GitHub login that can see `allieatom/allieatom`, a card for Render.

---

## Part 1: Shopify access token (5 minutes)

1. Shopify admin → **Settings → Apps and sales channels → Develop apps**. If you see "Allow custom app development", click it and confirm.
2. **Create an app** → name `Better Rhodes Rewards` → Create.
3. **Configure Admin API scopes** → tick exactly: `read_orders`, `read_customers`, `write_customers`, `read_discounts`, `write_discounts` → Save.
4. **Install app** → confirm.
5. On the **API credentials** tab, click **Reveal token once** under *Admin API access token*. Copy it into your password manager as `SHOPIFY_ADMIN_ACCESS_TOKEN`. Shopify shows it only once.

## Part 2: Render (10 minutes)

1. Go to render.com, sign up or log in, and connect GitHub when asked. Grant access to `allieatom/allieatom`.
2. **New + → Blueprint**. Pick the repo. Branch: `claude/rewards-migration-yotpo-ggq4wf` (switch to `main` after the pull request merges: service → Settings → Branch).
3. Render reads `render.yaml` and lists a web service, a cron job, a database and an environment group. Blueprint name: `betterrhodes-rewards`. Click **Apply**.
4. It asks for the values marked "set in dashboard":
   - `SHOPIFY_ADMIN_ACCESS_TOKEN`: paste the token from Part 1.
   - `SHOPIFY_WEBHOOK_SECRET`: type `pending` for now (you'll get the real one in Part 3).
   - `KLAVIYO_PRIVATE_API_KEY`: leave empty for now. Emission is off anyway.
5. Wait. Postgres takes about 2 minutes, the first Docker build 3 to 5 minutes. When the web service shows **Live**, open its URL and add `/healthz`. You should see `{"ok":true}`.
6. Note the service URL. You need it in Part 3.

## Part 3: Shopify webhooks (10 minutes)

1. Shopify admin → **Settings → Notifications**, scroll to **Webhooks** → **Create webhook**.
2. Create six, all with Format **JSON**, URL `https://<your-render-url>/webhooks/shopify`, API version the latest offered (2026-01 or newer):

| Event in the dropdown | What the service does |
|---|---|
| Order payment | awards points (1 per $ of subtotal, $200 bonus), auto-enrols the buyer |
| Order cancellation | reverses the order's points |
| Refund create | removes points proportional to the refund |
| Customer creation | creates the member record |
| Customer update | syncs name/email; awards the 60-point account bonus when an account is enabled |
| Customer deletion | anonymises the member (GDPR) |

3. Under the webhook list Shopify shows: "All your webhooks will be signed with **<secret>** so you can verify their integrity." Copy that secret.
4. Render → **Env Groups → rewards-shared** → set `SHOPIFY_WEBHOOK_SECRET` to the copied value → Save. The web service redeploys in about a minute.

## Part 4: Verify (5 minutes)

1. Render → web service → **Logs**. You should see `rewards-service started` with `klaviyoEmit:false` and `shopifySync:false`.
2. Shopify → Notifications → Webhooks → on *Order payment* click **Send test notification**. The log shows a `POST /webhooks/shopify` returning 200. (The test payload uses a sample customer; it creates one harmless test member you can ignore.)
3. After the next real order, check it landed:
   - Render → Env Groups → `rewards-shared` → copy the generated `ADMIN_API_TOKEN`.
   - In a browser extension or terminal, call `GET https://<your-render-url>/admin/stats` with header `Authorization: Bearer <ADMIN_API_TOKEN>`. `optedInMembers` should be 1 or more.
   - `GET /admin/members/search?email=<buyer email>` shows the member, balance and history.
4. Confirm nothing leaked: `/admin/stats` shows the outbox counts as `skipped`, never `sent`.

## What happens next

- Pushes to the deployed branch redeploy automatically (`autoDeploy: true`).
- The nightly job (`betterrhodes-rewards-daily`, 05:15 ET) runs expiry, birthdays, tier maintenance and reminders. With the flags off it only writes to the ledger and outbox.
- Next step after a clean day of webhooks: the import (plan Stage 2) from a Klaviyo profile export plus a Shopify customer export. Then nightly reconciliation of our balances against Klaviyo's `swell_point_balance`.
- Before cutover the service switches to a Dev Dashboard app (client credentials, app proxy, theme extension). The config already supports both; see `.env.example`.

## If something goes wrong

- **Build fails on Render**: open the build log; the usual cause is the branch name. Re-check Part 2 step 2.
- **`/healthz` is fine but webhooks return 401**: the webhook secret is wrong or still `pending`. Redo Part 3 steps 3 to 4.
- **Webhooks return 500**: the service hit an error processing the payload. Logs show the stack; Shopify retries automatically for 48 hours, so no data is lost.
- **Shopify says the app can't be installed**: your staff account lacks the "Develop apps" permission; ask the store owner.
- **Rollback**: Render → web service → Settings → Suspend. Shopify keeps retrying webhooks for 48 hours, and nothing customer-facing depends on the service yet.
