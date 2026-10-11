# Theme changes at cutover

Three files change in the live theme (`SKIO | Prepaid | Checkout upsell fix + YOTPO`), on a duplicate first:

1. `layout/theme.liquid`: remove the line `<div class="yotpo-widget-instance" data-yotpo-instance-id="559176"></div>` (Yotpo launcher). **Keep** the `cdn-widgetsrepository.yotpo.com` loader script and the Yotpo Reviews app embed: they power product reviews.
2. `templates/page.loyalty-rewards.liquid` and `templates/page.loyalty-refer.liquid`: replace with the JSON templates in this folder, which host our app blocks inside the theme's existing `apps` section. After `shopify app deploy`, paste the real block ids (shown in the theme editor as `shopify://apps/better-rhodes-rewards/blocks/<block>/<uuid>`) over the placeholders, or simply add the blocks in the theme editor.
3. Theme editor > App embeds: enable "Rewards launcher" (ours), disable "Yotpo Loyalty & Rewards" (keep "Yotpo Product Reviews" on).

Optional: add a URL redirect `/pages/rewards-page` → `/pages/loyalty-rewards` (legacy page with a missing template).
