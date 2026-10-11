# Current-State Inventory: Yotpo Loyalty & Referrals at Better Rhodes

Read-only audit of the Better Rhodes Shopify Plus store (`www.betterrhodes.com`) and the connected Klaviyo account, taken 2026-10-11. Nothing was changed. Every fact below was observed directly unless marked **unverified**.

## 1. Store facts

| Item | Value |
|---|---|
| Shopify plan | Shopify Plus |
| Live theme | `SKIO \| Prepaid \| Checkout upsell fix + YOTPO` (Expanse 2.0.1 base), theme id `127598133382`, last updated 2026-10-08 |
| Total customers | 79,228 |
| Customers with enabled accounts | 9,800 |
| Customers with 1+ orders | 41,128 |
| Customers who ordered in last 365 days | 3,816 |
| Yotpo app key / GUID used by the widget loader | `Y4LDm86S_49yo4iPb6wOFw` |

## 2. Yotpo apps installed

| App | Handle | Status | Notes |
|---|---|---|---|
| Yotpo Loyalty & Rewards | `swell` | Installed, app embed **enabled** | The product being replaced |
| Yotpo Product Reviews | `yotpo-social-reviews` | Installed, app embed enabled, PDP app block enabled | **Not** part of this migration unless the business decides so. Shares the same loader script as Loyalty. |

Legacy Yotpo SMS (SMSBump) leftovers exist in the theme (`sections/smsbump_subscription_form_embed_327515.liquid`, `snippets/smsbump_checkout_marketing_subscription.liquid`, CSS in `sections/header.liquid`) and one discount set titled "Yotpo Discount (Oct 16, 2024)" with 644 `SMS-*` codes. No SMSBump app is installed today, so these are dead weight, not dependencies.

## 3. Loyalty program members (from `swell_vip_*` customer tags)

Yotpo writes the VIP tier onto the Shopify customer as a tag.

| Tier tag | Members |
|---|---|
| `swell_vip_bronze` | 59,539 |
| `swell_vip_silver` | 204 |
| `swell_vip_gold` | 28 |
| `swell_vip_platinum` | 6 |
| **Total tagged** | **59,777** |

Bronze is clearly the entry tier granted on opt-in. These tags are used by at least one Shopify segment (`Yotpo Active Subscribers` uses a different tag, but tier-based segments are plausible) and are available to Klaviyo as Shopify tags. **The tag names must be preserved** by the replacement system.

No Yotpo customer metafields exist on Shopify customers (checked a silver member and the metafield definitions list; only Klaviyo/Skio definitions exist). Yotpo state lives entirely in Yotpo, with tags and Klaviyo properties as the only Shopify-side projection.

## 4. Storefront integration points (the customer interface to preserve)

### 4a. Loader script

Loaded twice: once hard-coded in `layout/theme.liquid` and once via the Yotpo Loyalty theme app embed (`shopify://apps/yotpo-loyalty-rewards/blocks/loader-app-embed-block/...`, enabled in `config/settings_data.json`). The Yotpo Reviews app embed (`yotpo-product-reviews-ugc/blocks/settings`) is also enabled.

```liquid
<!-- layout/theme.liquid, near </body> -->
<script src="https://cdn-widgetsrepository.yotpo.com/v1/loader/Y4LDm86S_49yo4iPb6wOFw" async></script>
...
<div class="yotpo-widget-instance" data-yotpo-instance-id="559176"></div>
```

### 4b. Widget instances

| Instance id | Where mounted | Purpose (inferred, **visuals unverified** from this session) |
|---|---|---|
| `559176` | End of `<body>` in `layout/theme.liquid`, every page | Site-wide loyalty widget, almost certainly the floating "Rewards" launcher / pop-up |
| `123052` | `templates/page.loyalty-rewards.liquid` (page handle `loyalty-rewards`) | Full rewards page: balance, ways to earn, ways to redeem, VIP tiers |
| `123058` | `templates/page.loyalty-refer.liquid` (page handle `loyalty-refer`) | Referral page ("Give 10% Get $10 Off") |
| `867317` | `snippets/product-template.liquid` line 158 | **Yotpo Reviews** star rating on PDP. Not loyalty. Must keep working. |

Both loyalty page templates are two lines each: the loader script tag plus one widget div. The page bodies contain only JSON-LD review schema, so the entire visible UI is rendered by Yotpo's JavaScript. There is no Yotpo markup in `templates/customers/account.liquid`, the cart, the cart drawer, or the product template (other than Reviews).

### 4c. Navigation and pages

| Page / link | Handle | Status |
|---|---|---|
| Loyalty Rewards | `loyalty-rewards` (template `loyalty-rewards`) | Published, linked from footer "FOR YOU" menu |
| Loyalty Refer ("Give 10% Get $10 Off") | `loyalty-refer` (template `loyalty-refer`) | Published, linked from footer "FOR YOU" menu (absolute URL) |
| Rewards | `rewards-page` (template `rewards-page`) | Published but the template file does not exist in the live theme, so it renders the default page template with no widget. Legacy, Yotpo-generated. Candidate for redirect to `/pages/loyalty-rewards`. |
| Rewards and Referrals FAQ's | `rewards-and-referrals-faqs` | Unpublished draft |

The footer link "Account Log In" points to the Skio portal (`/a/account/login`), and a `customer-account-main-menu` exists pointing at `shopify.com/27872854150/account/...`, which suggests Shopify's new customer accounts may be configured. **Which account surface customers actually use is unverified** and matters for where a logged-in loyalty view must render.

### 4d. Discount codes issued by Yotpo for redemptions

Yotpo creates one Shopify discount per redemption, titled with the code itself.

| Property | Observed |
|---|---|
| Code format | 8 uppercase alphanumerics, e.g. `0OJHTAPS`, `W4S42WJT` |
| Type | Fixed amount off order: $5, $10, $15, $20 observed |
| Usage limit | 1, applies once per customer |
| Combines with | nothing (order, product and shipping discounts all `false`) |
| Volume | ~17 codes between 2026-09-25 and 2026-10-07, roughly 1.3 per day |
| Total discount nodes in store | at least 10,000 (count capped), the bulk are historic redemption codes |

Observed on orders, e.g. order `BR-89732` used `0OJHTAPS`. Because these are ordinary Shopify discounts they **remain valid after Yotpo is removed**; nothing needs to be migrated for already-issued codes to keep working at checkout.

## 5. Klaviyo coupling (large)

Klaviyo account `WzP4Gu`. Yotpo pushes **31 API metrics** and roughly **14 profile properties**.

### 5a. Metrics (events) Yotpo sends to Klaviyo

Loyalty Opt In, Loyalty Opt Out, Loyalty Expiration Reminder, Loyalty Donation Created, Loyalty Custom Reward Created, Swell Account Created, Swell Points Earned, Swell Points Changed, Swell Points Reminder, Swell Redemption Created, Swell Redemption Reminder, Swell Redemption Payout Scheduled / Received / Unclaimed, Swell Purchase Payout Scheduled / Received / Unclaimed, Swell Tier Earned, Swell Tier Lost, Swell Tier Status Changed, Swell Customer Birthday, Swell Birthday Captured, Swell Customer Anniversary, Swell Customer Locked, Swell Referral Share, Swell Referral Share Reminder, Swell Referral Completed, Yotpo Referral shared, Yotpo Referral completed, Swell Widgets Customer Authentication.

### 5b. Flows triggered by those metrics

| Flow | Status | Trigger metric |
|---|---|---|
| 5. Yotpo L&R - Referral Completed - Points Reward | live | Swell Referral Completed |
| Yotpo L&R - Referral Share | live | Swell Referral Share |
| Yotpo L&R - Referral Share Reminder | live | Swell Referral Share Reminder |
| Yotpo L&R - Redemption Reminder | live | Swell Redemption Reminder |
| Yotpo L&R - Happy Birthday | live | Swell Customer Birthday |
| Yotpo L&R - Tier Earned - Points Reward | live | Swell Tier Earned |
| TS - Points Reminder | live | Swell Points Reminder |
| Yotpo L&R - Redemption Created / Earned | manual | Swell Redemption Created |
| 6 further "TS - Yotpo ..." flows | draft | various |

### 5c. Profile properties Yotpo writes (present on 97 of the 100 most recently updated profiles)

`swell_point_balance`, `swell_points_earned`, `swell_credit_balance`, `swell_has_account`, `swell_is_affiliate`, `swell_points_expire_at`, `swell_pea_date`, `swell_referral_link` (Yotpo-hosted short link, e.g. `http://rwrd.io/hykrwev`), `swell_referral_discount_code`, `swell_vip_tier_name`, `swell_vip_tier_ends_at`, `swell_vt_ends_at_date`, `loyalty_opt_in`, `loyalty_opt_in_date`, `loyalty_credit_balance_in_customer_currency`, `loyalty_next_points_expire_on`, `loyalty_next_points_expire_amount`, `loyalty_birthday_date`, and the tier-progress set `loyalty_mt_*` (current tier: points, purchases, referrals, amount) and `loyalty_nt_*` (next tier thresholds).

Observed program rules from live data: a profile that opted in on 2026-10-11 had 106 points and `swell_points_expire_at` = 2027-10-11, so **points expire 12 months after earning** and there is a sign-up / first-action bonus. **Exact earning rates, tier thresholds and redemption table are unverified** and must be exported from the Yotpo admin (Stage 0).

Any Klaviyo email template that prints `{{ person.swell_point_balance }}` or links `{{ person.swell_referral_link }}` depends on these names. Preserving the names means no template work.

## 6. Other systems touching loyalty

| System | Coupling | Verified? |
|---|---|---|
| Skio Subscriptions (customer portal at `/a/account`) | Skio documents a Yotpo Loyalty custom block for its portal (shows points / tier when logged in via Multipass). Theme name includes "SKIO ... + YOTPO". | **Unverified**: check Skio admin > Customer Portal > Custom Blocks |
| Stay Ai Subscription | Second subscription app installed; unknown whether active | Unverified |
| Shopify Flow | Installed. Yotpo exposes Flow triggers/actions; workflows cannot be read via API | **Unverified**: review Flow workflows in admin |
| Simple Affiliate | Separate affiliate program (order tags "Referred by affiliate", codes like `SOMEGOODCLEANFUN`). Independent of Yotpo referrals. | Verified independent |
| Matrixify, Accentuate, Zapier, Make, Fivetran | Data tooling available for bulk tag/metafield writes and exports | Available |
| ThemeWatch Backups | Theme backup/restore, useful for rollback | Installed |

## 7. What could not be checked from this session

- Live rendering of widgets `559176`, `123052`, `123058` (storefront and Yotpo CDN are blocked by this environment's network policy). Needs screenshots and DOM capture in every state: logged out, logged in at each tier, with and without redeemable balance.
- Yotpo admin configuration: earning campaigns, redemption options, VIP tier rules and perks, points expiry, referral reward settings, email templates Yotpo itself sends, pending-points hold period.
- Yotpo Loyalty API credentials (GUID and API key, Yotpo admin > Settings > General).
- Skio portal custom block, Shopify Flow workflows, and which customer-accounts system is live.
