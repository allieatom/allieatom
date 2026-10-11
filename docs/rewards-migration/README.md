# Better Rhodes Rewards: Yotpo → Self-Hosted Loyalty Migration Plan

**Goal.** Replace Yotpo Loyalty & Referrals with a loyalty service that Better Rhodes hosts and owns, migrate every member's balance, tier, history and referral identity, and stop paying Yotpo for loyalty, **without changing anything the customer sees**: same widgets in the same places, same rewards page and referral page, same discount-code behaviour at checkout, same emails.

**Scope.** Yotpo Loyalty & Referrals only. Yotpo Product Reviews stays unless a separate decision is made (see Open Decisions). Simple Affiliate, Skio and Klaviyo stay; the new service must plug into them where Yotpo did.

Companion document: [01-current-state-inventory.md](01-current-state-inventory.md) holds the evidence behind every statement here.

---

## 1. What we are actually replacing

Yotpo's footprint at Better Rhodes is wide but shallow. The customer-facing surface is three JavaScript widgets mounted by two-line Liquid templates. Everything else is data plumbing.

| Layer | Today (Yotpo) | After migration |
|---|---|---|
| Points ledger, tiers, referrals, expiry | Inside Yotpo | Better Rhodes-hosted service + database (the "Rewards Service") |
| Site-wide launcher widget | Widget `559176` in `layout/theme.liquid` | Our widget, same position and look, mounted from a theme app extension |
| Rewards page `/pages/loyalty-rewards` | Widget `123052` | Our rewards widget, same page, same URL |
| Referral page `/pages/loyalty-refer` | Widget `123058` | Our referral widget, same page, same URL |
| Redemption → checkout | Yotpo creates a single-use Shopify discount code ($5/$10/$15/$20, 8-char code, no stacking) | Rewards Service creates an identical discount via Shopify Admin API |
| Tier → Shopify | Customer tags `swell_vip_bronze/silver/gold/platinum` | Same tags, written by Rewards Service |
| Email automation | 31 Klaviyo metrics + ~14 profile properties, 7 live flows | Same metric names and property names emitted by Rewards Service, so no flow or template changes |
| Referral links | Yotpo short links `rwrd.io/xxxx` | `betterrhodes.com/r/<code>` (Yotpo's domain cannot be kept) |
| Subscription portal | Skio custom block embedding Yotpo widget (to confirm) | Same block, pointing at our widget |
| Admin | Yotpo dashboard | Minimal internal admin (search member, adjust points, view history, export) |

Member population to migrate: **59,777 tagged members** (59,539 bronze, 204 silver, 28 gold, 6 platinum) out of 79,228 customers. Only 3,816 customers ordered in the last 12 months, so most balances are small or dormant, but all must come across.

---

## 2. Target architecture

### 2.1 Components

1. **Rewards Service** (single deployable, e.g. Node/TypeScript or Python, Postgres). Owns:
   - Append-only **ledger** (`point_transactions`: earn, redeem, adjust, expire, reverse; each with source, order id, campaign, expiry date, idempotency key).
   - **Members** (Shopify customer id as primary key, email, opt-in date, birthday, tier, tier-until, referral code, Yotpo legacy ids for audit).
   - **Rules engine** configured from data exported from Yotpo: earning campaigns (points per dollar, sign-up, birthday, review, social follow, etc.), redemption options (points → fixed $ off), VIP tiers (thresholds, period, perks), expiry (12 months observed), referral (friend gets 10% code, advocate gets $10 in points once friend's first order is paid).
   - **Redemptions**: creates Shopify discount codes via `discountCodeBasicCreate` restricted to the member, usage limit 1, no combination, same code format as today.
   - **Referrals**: `/r/<code>` landing redirect, cookie/attribution, friend code issuance, completion on `orders/paid`, fraud rules (self-referral, same address, refunds).
   - **Projections** out to Shopify (tier tags, optional customer metafields `rewards.points_balance`, `rewards.tier`) and to Klaviyo (events + profile properties with Yotpo's exact names).
   - **Internal admin** (behind SSO): member lookup, manual adjust with reason, history, bulk CSV import/export, rules editor.
2. **Shopify custom app** (installed only on this store, not published):
   - Webhooks: `orders/paid`, `orders/cancelled`, `orders/updated`, `refunds/create`, `customers/create`, `customers/update`, `customers/delete`, plus mandatory GDPR topics (`customers/data_request`, `customers/redact`, `shop/redact`).
   - **App proxy** at `/apps/rewards/*` so the storefront widget can fetch the logged-in member's state. Shopify signs proxy requests and passes `logged_in_customer_id`, which gives authenticated identity without Multipass or our own tokens.
   - **Theme app extension**: one app embed (loads our widget script and mounts the launcher) and one app block (mounts rewards or referral widget). This replaces Yotpo's embed and the two template files with equivalent two-line templates.
   - Optional **Customer Account UI extension** (full-page "Rewards") if the store uses Shopify's new customer accounts (see Open Decisions).
   - Optional **Shopify Flow triggers** ("Points earned", "Tier changed") if any current Flow workflows use Yotpo's triggers.
3. **Widget front-end**: a small framework-free bundle that renders the three widgets pixel-matched to the captured Yotpo designs, reads state from the app proxy, and posts redemptions and referral shares.
4. **Migration toolkit**: scripts to pull from the Yotpo Loyalty API, transform, load, and reconcile (see Stage 2).

### 2.2 Why not alternatives

- *Another SaaS (Rivo, Smile, Joy, Skio Loyalty).* Cheaper to build than self-hosting, but changes the customer UI and still carries a per-month fee. The brief is to own it and pay nobody.
- *Shopify-native only (metafields + Flow + discounts, no service).* Flow cannot run a ledger with expiry, tiers and referrals reliably, and there is no place to render a widget with live state. A service is unavoidable.
- *Keeping Yotpo's widget JS pointing at our API.* Yotpo's loader is closed and tied to their backend; not viable.

### 2.3 Hosting ("host this locally")

Interpreted as Better Rhodes-controlled infrastructure rather than a laptop in the office. Recommended: a managed container host (Fly.io, Render, Railway or AWS ECS) with managed Postgres and daily backups. Expected run cost is tens of dollars per month at this traffic (about one redemption per day and a few hundred orders per week). An on-premise box is possible but fails the uptime and webhook-reachability bar; Shopify webhooks need a public HTTPS endpoint that is up when orders happen. Decision needed (Open Decisions #1).

---

## 3. Data migration design

### 3.1 Sources, in order of preference

| Data | Primary source | Fallback |
|---|---|---|
| Balance per member | Yotpo Loyalty API `GET /api/v2/customers?customer_email=…&with_history=true` (headers `x-guid`, `x-api-key`, base `https://loyalty.yotpo.com/api/v2`, limit 1,500 calls/min) | Yotpo admin Customers CSV export (email, names, balance, referral link) |
| Earning + redemption history | same call, `with_history=true` | Yotpo admin Earning history and Redemption history reports |
| VIP tier and tier-until | same call (tier name field) | Shopify `swell_vip_*` tags (tier only, no dates) |
| Referral code / link | same call | Klaviyo `swell_referral_link`, `swell_referral_discount_code` |
| Birthday | same call if present | Klaviyo `loyalty_birthday_date` |
| Pending points and their release dates | same call history items with pending state | Yotpo support request |
| Points expiry dates | derived from history (earn date + 12 months) | Klaviyo `swell_points_expire_at`, `loyalty_next_points_expire_on/amount` |
| Program rules (campaigns, redemption options, tiers) | Yotpo admin screens, exported manually to a rules file; API has tier/campaign/redemption-option endpoints to cross-check | — |
| Recently changed members (for delta loads) | `GET /api/v2/customers/recent` (last 7 days) | Klaviyo "Swell Points Changed" events |

**Known gaps to confirm with Yotpo support early:** whether the export includes VIP tier dates, pending points, and already-issued-but-unused redemption coupons. The Yotpo API reference could not be opened from this session; endpoint names above come from Yotpo's published reference index and third-party connector docs and must be re-verified against `loyaltyapi.yotpo.com/reference` in Stage 0.

### 3.2 Volume and timing

Per-member API pulls for ~60,000 members at 1,500 calls/min is about 40 minutes of wall time, so a full snapshot can be taken nightly during the shadow period and again at cutover. Member identity is matched on Shopify customer id first, email second.

### 3.3 Reconciliation rule

Shadow ledger balance must equal Yotpo balance for ≥ 99.5% of members, and every mismatch must be explained (timing of a pending release, refund handling, manual adjust in Yotpo) before cutover is approved.

---

## 4. Stages

Each stage has deliverables and an exit gate. Durations assume one engineer plus part-time design/marketing input; they are estimates, not commitments.

### Stage 0: Discovery, capture and decisions (1 to 2 weeks)

Deliverables
- Yotpo API GUID + key obtained; API access confirmed with one `GET /customers` call.
- **Visual capture pack**: screenshots, DOM snapshots and computed CSS of widgets `559176`, `123052`, `123058` in every state (logged out; logged in at bronze/silver/gold/platinum; zero balance; redeemable balance; after redemption; referral share flow; mobile and desktop). This is the acceptance spec for "nothing changes".
- **Rules export**: every earning campaign, redemption option, tier threshold and perk, expiry setting, referral reward, pending-points window, and every Yotpo-sent email (are any still enabled, or does Klaviyo send everything?).
- Dependency checks: Skio portal custom block, Shopify Flow workflows using Yotpo, Klaviyo templates and segments referencing `swell_*` / `loyalty_*` properties, which customer-accounts system is live, whether Stay Ai is active.
- Decisions recorded (Section 7).

Exit gate: rules file signed off by marketing; capture pack complete; decisions 1 to 5 made.

### Stage 1: Foundation (2 to 3 weeks)

Deliverables
- Repo, CI, infrastructure as code, staging + production environments, backups.
- Shopify custom app registered; webhooks and GDPR endpoints live; app proxy skeleton.
- Ledger, members, rules engine with Better Rhodes rules; unit tests against the rules file.
- Order → points pipeline from `orders/paid`, with refund/cancel reversal and pending hold.
- Internal admin: member lookup, history, manual adjust.

Exit gate: service earns points for live orders into a **shadow** database (no customer-visible effect); 100% webhook delivery observed for a week.

### Stage 2: Import and shadow run (2 to 3 weeks, overlaps Stage 3)

Deliverables
- Migration toolkit: full pull, transform, load, idempotent re-run, delta pull via `customers/recent`.
- Historical import of all ~60,000 members with ledger lines carrying original dates (so expiry works), tiers with end dates, referral codes, birthdays, pending points.
- Nightly reconciliation report vs Yotpo; drift dashboard.
- Tier recomputation checked against `swell_vip_*` tags.

Exit gate: reconciliation ≥ 99.5% three nights running; every mismatch class documented.

### Stage 3: Customer-facing parity (3 to 4 weeks, overlaps Stage 2)

Deliverables
- Widget bundle: launcher, rewards page, referral page, matched against the capture pack; accessibility and mobile parity.
- Theme app extension (embed + block) and the two replacement page templates, built on a **duplicate of the live theme**, never on the live theme.
- App proxy endpoints: member state, redemption, referral share (email + copy link), opt-in.
- Redemption creates Shopify discount with identical format and rules; checkout tested.
- Referral landing `/r/<code>` and friend 10% code issuance; completion logic on paid order.
- Klaviyo emitter: all 31 metric names and all profile properties, behind a feature flag (off until cutover). Verified against a Klaviyo test profile.
- Shopify projections: tier tags and metafields behind the same flag.
- Skio custom block variant pointing at our widget (if Stage 0 confirms the block exists).
- Admin: rules editor, CSV export, audit log.

Exit gate: side-by-side review on the preview theme by marketing; test customers at each tier walk through earn → redeem → checkout and refer → friend order → reward with no visible difference from production.

### Stage 4: Cutover (1 day) and hypercare (1 week)

Runbook (all steps reversible until step 7)
1. Announce internal freeze: no manual point adjustments in Yotpo for 24 hours.
2. Final full pull from Yotpo; load; reconcile; sign-off.
3. Flip Klaviyo and Shopify projection flags **on** in the Rewards Service; confirm one test event lands in Klaviyo under the expected metric name.
4. Publish the prepared theme (duplicate with our embed, app block, and the two swapped templates; Yotpo loader line removed **only if Reviews is also leaving**, otherwise kept).
5. Disable the Yotpo Loyalty app embed in the theme editor (leave the Reviews embed enabled).
6. Update the Skio custom block; add a 301 from `/pages/rewards-page` to `/pages/loyalty-rewards`.
7. Verify on production as a real logged-in member: launcher, rewards page, referral page, a redemption, checkout with the code, and the resulting Klaviyo event.
8. Do **not** uninstall Yotpo yet. Keep it installed but inert through hypercare.

Rollback: republish the previous theme (ThemeWatch backup or theme library), re-enable the Yotpo embed, flip projection flags off. Points earned during the gap are replayed into Yotpo manually from our ledger export. Rollback window closes when Yotpo is cancelled.

Hypercare: daily reconciliation of order count vs. earn events, redemption success rate, Klaviyo flow trigger counts versus the prior four weeks, support tickets tagged "rewards".

### Stage 5: Decommission (after 30 clean days)

- Export and archive the final Yotpo data set (API + CSV) to cold storage.
- Cancel Yotpo Loyalty & Referrals; uninstall the app; remove the loader-app-embed reference and SMSBump leftovers from the theme; delete the unused `rewards-page` template suffix.
- Retire `rwrd.io` references in Klaviyo content (the properties will already hold the new links).
- Record the realised saving and hand over the admin runbook.

Indicative total: **10 to 14 weeks** end to end, with Stage 2 and 3 running in parallel.

---

## 5. Preserving the customer interface: the checklist

A change is acceptable only if a member could not tell. Specifically:

- Launcher appears on the same pages, same corner, same open/closed states, same copy and colours.
- `/pages/loyalty-rewards` and `/pages/loyalty-refer` URLs, page titles and footer links unchanged.
- Balance, tier, tier progress, "ways to earn", "ways to redeem" and history render identical values at cutover (reconciled) and identical layout (capture pack).
- Redemption still yields an 8-character uppercase code for the same dollar steps, single use, non-stackable, applied in the same checkout field.
- Codes already issued by Yotpo keep working (they are Shopify discounts and are untouched).
- VIP tags unchanged, so any segment or Klaviyo logic keyed on them keeps working.
- Klaviyo keeps receiving events under the same metric names with the same property keys, so every live flow fires as before and templates render the same merge fields.
- Referral: friend still gets 10% off, advocate still gets $10, email share still works. The one unavoidable change is the link domain; old `rwrd.io` links in the wild stop working when Yotpo is cancelled (Open Decision #6).
- Skio portal still shows points if it does today.

---

## 6. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Yotpo export lacks tier dates, pending points or unused coupons | Members see wrong tier-until or lose pending points | Ask Yotpo support in Stage 0; fall back to Klaviyo properties; grant benefit of the doubt (round up) at cutover |
| Widget not pixel-identical | Visible change, support tickets | Capture pack as acceptance spec; marketing side-by-side sign-off on preview theme |
| Klaviyo metric name mismatch | Live flows silently stop | Emit exact names; test profile verification in Stage 3; compare trigger counts in hypercare |
| Shared Yotpo loader removed by mistake | Product reviews disappear from PDP | Explicit rule: loader and Reviews embed stay unless Reviews is also migrating |
| Webhook loss or duplicate | Missed or double points | Idempotency keys on order id; nightly order-vs-ledger reconciliation; Shopify webhook retries |
| Referral fraud without Yotpo's heuristics | Reward leakage | Rules: no self-referral by email/customer id/address, reward only after paid order, clawback on refund within 30 days |
| Points expiry mass-event after import | Many members lose points at once | Import with original earn dates; verify expiry schedule matches Yotpo's before enabling the expiry job |
| Single engineer dependency | Schedule risk | Document everything in repo; admin runbook; keep rollback path alive until Stage 5 |
| New customer accounts in use | Logged-in state unavailable to Liquid/app proxy on account pages | Confirm in Stage 0; add Customer Account UI extension if needed |

---

## 7. Open decisions for Better Rhodes

1. **Hosting.** Managed cloud (recommended) vs on-premise. Who holds the account and pays the bill?
2. **Yotpo Product Reviews.** Stay (default, out of scope) or migrate too? Changes Stage 4 step 4 and the decommission list.
3. **Account surface.** Are customers on classic accounts, Shopify new customer accounts, or the Skio portal for day-to-day? Determines whether a Customer Account UI extension is in scope.
4. **Program rules at cutover.** Carry rules over exactly, or use the migration to simplify (for example fewer redemption steps)? Exactly-as-is is the only option that satisfies "nothing changes for the customer".
5. **Pending points and expiry policy** for migrated balances: honour Yotpo's dates exactly, or reset the 12-month clock at cutover as a goodwill gesture? Reset is simpler and customer-friendly but costs margin.
6. **Referral links.** Accept that `rwrd.io` links die when Yotpo is cancelled, or keep Yotpo for an extra month purely to let old links redirect? Either way new links go out from cutover.
7. **Communication.** Silent cutover (consistent with "nothing changes") or a light "your rewards got an upgrade" email? Recommendation: silent, with a prepared support macro.
8. **Admin ownership.** Who adjusts points, approves clawbacks and edits rules after Yotpo is gone? Needs a named owner and SSO group.
9. **Yotpo contract.** Renewal date and notice period drive the Stage 5 date; check the contract now.

---

## 8. Immediate next actions

1. Obtain Yotpo Loyalty API GUID and key and store them in the team password manager.
2. Someone with browser access runs the visual capture pack on production (logged out and logged in at each tier).
3. Export the rules from the Yotpo admin into `docs/rewards-migration/rules/` in this repo.
4. Check Skio custom blocks, Shopify Flow workflows, and the Yotpo contract date.
5. Make decisions 1 to 5; then Stage 1 can start.
