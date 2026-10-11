import type { Db } from '../db/index.js';
import { computePurchaseEarnings, type EarnableOrder } from '../domain/earning.js';
import { Ledger } from '../domain/ledger.js';
import { Members, randomCode, type Member } from '../domain/members.js';
import type { Rules, RedemptionOption } from '../domain/rules.js';
import { allTierTags, evaluateTier, tierByName, tierTag } from '../domain/tiers.js';
import { membersDueForReminder, runExpiry } from '../domain/expiry.js';
import { customerGid, type ShopifyAdminApi } from '../shopify/admin.js';
import { refundedBasisCents, toCents, type ShopifyCustomerPayload, type ShopifyOrderPayload, type ShopifyRefundPayload } from '../shopify/orders.js';
import { customerSnapshot, Metric, profileProperties } from '../klaviyo/events.js';
import { enqueue, enqueueEvent } from '../klaviyo/outbox.js';

export interface LoyaltyDeps { db: Db; rules: Rules; shopify: ShopifyAdminApi; publicBaseUrl: string; now?: () => Date }

export interface Redemption {
  id: number; member_id: number; option_key: string; title: string; points_spent: number; discount_type: string; discount_value: string;
  code: string | null; shopify_discount_id: string | null; status: string; created_at: Date; used_at: Date | null; used_order_id: number | null;
}

export class LoyaltyService {
  readonly ledger: Ledger;
  readonly members: Members;
  private readonly now: () => Date;
  constructor(private readonly deps: LoyaltyDeps) {
    this.ledger = new Ledger(deps.db, { expiryMonths: deps.rules.expiry.mode === 'inactivity' ? deps.rules.expiry.months : null });
    this.members = new Members(deps.db, deps.rules);
    this.now = deps.now ?? (() => new Date());
  }
  private get db() { return this.deps.db; }
  private get rules() { return this.deps.rules; }

  // ---------- projections (Klaviyo + Shopify) ----------
  private async spendInWindow(memberId: number): Promise<number> {
    const r = await this.db.query<{ sum: string | null }>(
      `select sum(basis_cents - refunded_cents)::text as sum from orders_seen where member_id = $1 and cancelled_at is null and paid_at >= $2`,
      [memberId, new Date(this.now().getTime() - this.rules.tiers.evaluationWindowMonths * 30.4375 * 86_400_000)],
    );
    return Number(r.rows[0]?.sum ?? 0);
  }

  private nextTier(current: string) {
    const cur = tierByName(this.rules, current);
    return this.rules.tiers.list.filter((t) => t.rank > cur.rank).sort((a, b) => a.rank - b.rank)[0] ?? null;
  }

  async syncProjections(memberId: number): Promise<Member> {
    const m = (await this.members.byId(memberId))!;
    const spend = await this.spendInWindow(memberId);
    await enqueue(this.db, 'klaviyo_profile', { email: m.email, properties: profileProperties(m, this.rules, this.deps.publicBaseUrl, this.nextTier(m.tier), spend) });
    if (m.shopify_customer_id) {
      await enqueue(this.db, 'shopify_metafields', { customerGid: customerGid(m.shopify_customer_id), fields: [
        { namespace: 'rewards', key: 'points_balance', type: 'number_integer', value: String(m.points_balance) },
        { namespace: 'rewards', key: 'vip_tier', type: 'single_line_text_field', value: m.tier },
        { namespace: 'rewards', key: 'referral_code', type: 'single_line_text_field', value: m.referral_code ?? '' },
      ] });
    }
    return m;
  }

  private async emit(metric: (typeof Metric)[keyof typeof Metric], m: Member, uniqueId: string, properties: Record<string, unknown>, at = this.now()): Promise<void> {
    await enqueueEvent(this.db, {
      metric, email: m.email, time: at, uniqueId,
      properties: { name: metric, store_name: 'Better Rhodes', website_url: this.deps.publicBaseUrl, email: m.email, customer: customerSnapshot(m, this.rules, this.deps.publicBaseUrl), ...properties },
    });
  }

  private async pointsChanged(m: Member, previous: number, current: number, reason: string, orderIds: number[], uniqueId: string, at: Date): Promise<void> {
    await this.emit(Metric.pointsChanged, m, uniqueId, {
      topic: 'swell/points/changed', previous_balance: previous, current_balance: current, difference: current - previous,
      added_or_removed: current >= previous ? 'added' : 'removed', points_changed_reason: reason, related_order_ids: orderIds.map(String),
      loyalty_next_points_expire_on: m.points_expire_at ? new Date(m.points_expire_at).toISOString().slice(0, 10) : null, loyalty_next_points_expire_amount: current, timestamp: at.toISOString(),
    }, at);
  }

  // ---------- tiers ----------
  async evaluateAndApplyTier(memberId: number): Promise<{ changed: boolean; tier: string }> {
    const m = (await this.members.byId(memberId))!;
    const spend = await this.spendInWindow(memberId);
    const target = evaluateTier(this.rules, { spendCentsInWindow: spend });
    const current = tierByName(this.rules, m.tier);
    if (target.name === current.name) return { changed: false, tier: current.name };
    // Never demote automatically during the window; only promote. (Yotpo re-evaluates at tier end; demotion handled by a scheduled job.)
    if (target.rank < current.rank) return { changed: false, tier: current.name };
    const endsAt = new Date(this.now().getTime() + this.rules.tiers.evaluationWindowMonths * 30.4375 * 86_400_000);
    await this.members.setTier(m.id, target.name, endsAt);
    const updated = (await this.members.byId(m.id))!;
    if (updated.shopify_customer_id) {
      await enqueue(this.db, 'shopify_tags', { customerGid: customerGid(updated.shopify_customer_id), add: [tierTag(this.rules, target)], remove: allTierTags(this.rules).filter((t) => t !== tierTag(this.rules, target)) });
    }
    await this.emit(Metric.tierEarned, updated, `tier:${m.id}:${target.name}:${this.now().toISOString().slice(0, 10)}`, {
      topic: 'swell/tier/earned', new_tier: { name: target.name, rank: target.rank, amount_spent_cents: target.minSpendCents ?? 0, points_multiplier: target.pointsMultiplier }, old_tier: { name: current.name, rank: current.rank },
    });
    return { changed: true, tier: target.name };
  }

  // ---------- customers ----------
  async handleCustomerUpsert(c: ShopifyCustomerPayload): Promise<Member | null> {
    if (!c.email) return null;
    const m = await this.members.upsertFromShopify({ shopifyCustomerId: c.id, email: c.email, firstName: c.first_name, lastName: c.last_name });
    if (c.state === 'enabled' && this.rules.earning.signup.points > 0) {
      const before = m.points_balance;
      const r = await this.ledger.post({ memberId: m.id, kind: 'earn', points: this.rules.earning.signup.points, reason: this.rules.earning.signup.title, campaignKey: this.rules.earning.signup.key, idempotencyKey: `signup:${c.id}` });
      if (!r.duplicate) {
        await this.db.query('update members set opted_in_at = coalesce(opted_in_at, now()) where id = $1', [m.id]);
        const after = (await this.members.byId(m.id))!;
        await this.emit(Metric.accountCreated, after, `account:${c.id}`, { topic: 'swell/account/created' });
        await this.emit(Metric.pointsEarned, after, `earn:signup:${c.id}`, { topic: 'swell/points/earned', perk: { history_title: this.rules.earning.signup.title, reward_points: this.rules.earning.signup.points, campaign_key: this.rules.earning.signup.key, completed: true, awarded: true, pending: false } });
        await this.pointsChanged(after, before, r.balance, this.rules.earning.signup.title, [], `changed:signup:${c.id}`, this.now());
        await this.syncProjections(m.id);
      }
    }
    return (await this.members.byId(m.id))!;
  }

  async anonymizeCustomer(shopifyCustomerId: number): Promise<void> {
    const m = await this.members.byShopifyCustomerId(shopifyCustomerId);
    if (!m) return;
    await this.db.query(`update members set email = $2, first_name = null, last_name = null, birthday_month = null, birthday_day = null, birthday_year = null, locked = true, updated_at = now() where id = $1`, [m.id, `redacted-${m.id}@invalid.local`]);
    await this.db.query(`insert into audit_log (actor, action, member_id, details) values ('system', 'gdpr_redact', $1, $2)`, [m.id, JSON.stringify({ shopifyCustomerId })]);
  }

  async optIn(memberId: number): Promise<Member> {
    await this.db.query('update members set opted_in_at = coalesce(opted_in_at, now()), updated_at = now() where id = $1', [memberId]);
    const m = (await this.members.byId(memberId))!;
    await this.emit(Metric.optIn, m, `optin:${m.id}`, { topic: 'loyalty/opt_in' });
    await this.syncProjections(m.id);
    return m;
  }

  // ---------- orders ----------
  async handlePaidOrder(o: ShopifyOrderPayload, earnable: EarnableOrder): Promise<{ memberId: number | null; pointsAwarded: number; duplicate: boolean }> {
    const email = o.customer?.email ?? o.email;
    if (!email) return { memberId: null, pointsAwarded: 0, duplicate: false };
    const seen = await this.db.query('select 1 from orders_seen where shopify_order_id = $1', [o.id]);
    if (seen.rows.length) return { memberId: null, pointsAwarded: 0, duplicate: true };

    // Yotpo auto-enrols purchasers: create the member and opt them in on their first paid order.
    const member = await this.members.upsertFromShopify({ shopifyCustomerId: o.customer?.id ?? null, email, firstName: o.customer?.first_name, lastName: o.customer?.last_name, optIn: true });
    const tier = tierByName(this.rules, member.tier);
    const lines = computePurchaseEarnings(this.rules, earnable, tier.pointsMultiplier);
    const basis = earnable.subtotalAfterDiscountsCents;
    const total = lines.reduce((s, l) => s + l.points, 0);

    await this.db.query(
      `insert into orders_seen (shopify_order_id, member_id, order_name, basis_cents, points_awarded, paid_at) values ($1,$2,$3,$4,$5,$6)`,
      [o.id, member.id, o.name, basis, total, earnable.paidAt],
    );
    let balance = member.points_balance;
    for (const line of lines) {
      const before = balance;
      const r = await this.ledger.post({ memberId: member.id, kind: 'earn', points: line.points, reason: line.title, campaignKey: line.campaignKey, shopifyOrderId: o.id, idempotencyKey: `order:${o.id}:${line.campaignKey}`, occurredAt: earnable.paidAt });
      balance = r.balance;
      const m = (await this.members.byId(member.id))!;
      await this.emit(Metric.pointsEarned, m, `earn:${o.id}:${line.campaignKey}`, { topic: 'swell/points/earned', perk: { history_title: line.title, reward_points: line.points, campaign_key: line.campaignKey, completed: true, awarded: true, pending: false, order_id: String(o.id) } }, earnable.paidAt);
      await this.pointsChanged(m, before, balance, line.title, [o.id], `changed:${o.id}:${line.campaignKey}`, earnable.paidAt);
    }

    await this.markRedemptionUsed(o);
    await this.completeReferralIfAny(o, member);
    await this.evaluateAndApplyTier(member.id);
    await this.syncProjections(member.id);
    return { memberId: member.id, pointsAwarded: total, duplicate: false };
  }

  async handleCancelledOrder(o: ShopifyOrderPayload): Promise<{ reversed: number }> {
    const seen = (await this.db.query<{ member_id: number; points_awarded: number; cancelled_at: Date | null }>('select member_id, points_awarded, cancelled_at from orders_seen where shopify_order_id = $1', [o.id])).rows[0];
    if (!seen || seen.cancelled_at) return { reversed: 0 };
    const reversed = await this.removePointsForOrder(seen.member_id, o.id, seen.points_awarded, 'Order Cancelled', `reverse:${o.id}:cancel`);
    await this.db.query('update orders_seen set cancelled_at = $2 where shopify_order_id = $1', [o.id, o.cancelled_at ? new Date(o.cancelled_at) : this.now()]);
    await this.syncProjections(seen.member_id);
    return { reversed };
  }

  async handleRefund(r: ShopifyRefundPayload): Promise<{ reversed: number }> {
    const seen = (await this.db.query<{ member_id: number; points_awarded: number; basis_cents: number; refunded_cents: number }>('select member_id, points_awarded, basis_cents, refunded_cents from orders_seen where shopify_order_id = $1', [r.order_id])).rows[0];
    if (!seen) return { reversed: 0 };
    const refunded = refundedBasisCents(r);
    if (refunded <= 0) return { reversed: 0 };
    const ppd = this.rules.earning.purchase.pointsPerDollar;
    const reversedRows = await this.db.query<{ sum: string | null }>(`select coalesce(sum(points),0)::text as sum from point_transactions where shopify_order_id = $1 and kind = 'reverse'`, [r.order_id]);
    const alreadyRemoved = Math.abs(Number(reversedRows.rows[0]?.sum ?? 0));
    const remaining = Math.max(0, seen.points_awarded - alreadyRemoved);
    const toRemove = Math.min(remaining, Math.floor((refunded / 100) * ppd));
    await this.db.query('update orders_seen set refunded_cents = refunded_cents + $2 where shopify_order_id = $1', [r.order_id, refunded]);
    if (toRemove <= 0) return { reversed: 0 };
    const reversed = await this.removePointsForOrder(seen.member_id, r.order_id, toRemove, 'Order Refunded', `reverse:${r.order_id}:refund:${r.id}`);
    await this.syncProjections(seen.member_id);
    return { reversed };
  }

  /** Remove up to `points` for an order, never driving the balance negative (shortfall recorded for review). */
  private async removePointsForOrder(memberId: number, orderId: number, points: number, reason: string, key: string): Promise<number> {
    if (points <= 0) return 0;
    const m = (await this.members.byId(memberId))!;
    const removable = Math.min(points, m.points_balance);
    const shortfall = points - removable;
    if (removable > 0) {
      const r = await this.ledger.post({ memberId, kind: 'reverse', points: -removable, reason, campaignKey: 'reversal', shopifyOrderId: orderId, idempotencyKey: key, metadata: shortfall ? { shortfall } : {} });
      if (!r.duplicate) await this.pointsChanged((await this.members.byId(memberId))!, m.points_balance, r.balance, reason, [orderId], `changed:${key}`, this.now());
    }
    if (shortfall > 0) await this.db.query(`insert into audit_log (actor, action, member_id, details) values ('system', 'reversal_shortfall', $1, $2)`, [memberId, JSON.stringify({ orderId, reason, shortfall })]);
    return removable;
  }

  private async markRedemptionUsed(o: ShopifyOrderPayload): Promise<void> {
    for (const dc of o.discount_codes ?? []) {
      await this.db.query(`update redemptions set status = 'used', used_at = $2, used_order_id = $3 where code = $1 and status = 'issued'`, [dc.code.toUpperCase(), this.now(), o.id]);
    }
  }

  // ---------- redemptions ----------
  async listRedemptions(memberId: number): Promise<Redemption[]> {
    return (await this.db.query<Redemption>('select * from redemptions where member_id = $1 order by created_at desc limit 50', [memberId])).rows;
  }

  async redeem(memberId: number, optionKey: string): Promise<Redemption> {
    const option: RedemptionOption | undefined = this.rules.redemption.options.find((o) => o.key === optionKey);
    if (!option) throw new Error(`unknown redemption option ${optionKey}`);
    const m = (await this.members.byId(memberId))!;
    const code = randomCode(this.rules.redemption.codeAlphabet, this.rules.redemption.codeLength);
    const before = m.points_balance;

    // 1) reserve points + create the redemption row atomically
    const redemption = await this.db.transaction(async (tx) => {
      const ins = await tx.query<Redemption>(
        `insert into redemptions (member_id, option_key, title, points_spent, discount_type, discount_value, code, status) values ($1,$2,$3,$4,$5,$6,$7,'pending') returning *`,
        [memberId, option.key, option.title, option.points, option.discountType, option.value.toFixed(2), code],
      );
      const row = ins.rows[0]!;
      const txLedger = new Ledger(tx, { expiryMonths: this.rules.expiry.mode === 'inactivity' ? this.rules.expiry.months : null });
      await txLedger.post({ memberId, kind: 'redeem', points: -option.points, reason: option.title, campaignKey: option.key, redemptionId: row.id, idempotencyKey: `redeem:${row.id}` });
      return row;
    });

    // 2) issue the Shopify code; on failure refund the points
    try {
      const { discountNodeId } = await this.deps.shopify.createDiscountCode({
        code, title: code, discountType: option.discountType, value: option.value, customerGid: m.shopify_customer_id ? customerGid(m.shopify_customer_id) : null,
        minSubtotalCents: option.minSubtotalCents, combinesWith: this.rules.redemption.combinesWith, usageLimit: 1,
      });
      await this.db.query(`update redemptions set status = 'issued', shopify_discount_id = $2, issued_at = now() where id = $1`, [redemption.id, discountNodeId]);
    } catch (err) {
      await this.ledger.post({ memberId, kind: 'reverse', points: option.points, reason: `Redemption failed: ${option.title}`, campaignKey: option.key, redemptionId: redemption.id, idempotencyKey: `redeem-fail:${redemption.id}` });
      await this.db.query(`update redemptions set status = 'failed', failure_reason = $2 where id = $1`, [redemption.id, String((err as Error).message ?? err).slice(0, 500)]);
      throw err;
    }

    const after = (await this.members.byId(memberId))!;
    await this.emit(Metric.redemptionCreated, after, `redemption:${redemption.id}`, {
      topic: 'swell/redemption/created', at_checkout: false, is_pos: false, redemption_option_name: option.title, redemption_option_id: option.key,
      redemption: { id: redemption.id, code, reward_text: code, amount: option.points, approved: true, created_at: this.now().toISOString() },
      redemption_option: { id: option.key, name: option.title, unrendered_name: option.title, amount: option.points, cost_text: `${option.points} Points`, type: 'Coupon', duration: 'single_use', discount_type: option.discountType, discount_amount_cents: option.discountType === 'fixed_amount' ? Math.round(option.value * 100) : null, discount_percentage: option.discountType === 'percentage' ? option.value : null, discount_with_currency: option.discountType === 'fixed_amount' ? '$' + String(option.value) : String(option.value) + '%', applies_to_product_type: 'ALL' },
    });
    await this.pointsChanged(after, before, after.points_balance, option.title, [], `changed:redemption:${redemption.id}`, this.now());
    await this.syncProjections(memberId);
    return (await this.db.query<Redemption>('select * from redemptions where id = $1', [redemption.id])).rows[0]!;
  }

  // ---------- referrals ----------
  /** A friend arrives via /r/<code>, enters their email, and receives their own single-use friend code. */
  async claimFriendCode(referralCode: string, friendEmail: string): Promise<{ code: string; title: string }> {
    const referrer = await this.members.byReferralCode(referralCode);
    if (!referrer) throw new Error('unknown referral code');
    const email = friendEmail.trim().toLowerCase();
    if (email === referrer.email) throw new Error('self-referral is not allowed');
    const existing = (await this.db.query<{ friend_code: string }>(`select friend_code from referrals where referrer_member_id = $1 and referred_email = $2 and friend_code is not null`, [referrer.id, email])).rows[0];
    const fr = this.rules.referral.friendReward;
    if (existing) return { code: existing.friend_code, title: fr.title };
    const code = randomCode(this.rules.redemption.codeAlphabet, this.rules.redemption.codeLength);
    await this.deps.shopify.createDiscountCode({ code, title: `Referral ${code}`, discountType: fr.discountType, value: fr.value, customerGid: null, combinesWith: this.rules.redemption.combinesWith, usageLimit: 1 });
    await this.db.query(`insert into referrals (referrer_member_id, referred_email, friend_code, status) values ($1,$2,$3,'clicked')`, [referrer.id, email, code]);
    return { code, title: fr.title };
  }

  async recordReferralShare(memberId: number, channel: string, recipients: string[] = []): Promise<void> {
    const m = (await this.members.byId(memberId))!;
    for (const r of recipients) await this.db.query(`insert into referrals (referrer_member_id, referred_email, status) values ($1,$2,'shared')`, [memberId, r.trim().toLowerCase()]);
    await this.emit(Metric.referralShare, m, `share:${memberId}:${this.now().getTime()}`, { topic: 'swell/referral/share', channel, recipients });
  }

  private async completeReferralIfAny(o: ShopifyOrderPayload, buyer: Member): Promise<void> {
    const codes = (o.discount_codes ?? []).map((d) => d.code.toUpperCase());
    if (!codes.length) return;
    const ref = (await this.db.query<{ id: number; referrer_member_id: number; referred_email: string | null; status: string }>(
      `select id, referrer_member_id, referred_email, status from referrals where friend_code = any($1::text[]) and status in ('clicked','signed_up')`, [codes],
    )).rows[0];
    if (!ref) return;
    if (ref.referrer_member_id === buyer.id) return; // self-referral guard
    if (this.rules.referral.friendReward.firstOrderOnly && (o.customer?.orders_count ?? 1) > 1) {
      await this.db.query(`insert into audit_log (actor, action, member_id, details) values ('system', 'referral_rejected_not_first_order', $1, $2)`, [buyer.id, JSON.stringify({ orderId: o.id, referralId: ref.id })]);
      return;
    }
    await this.db.query(`update referrals set status = 'completed', referred_member_id = $2, completed_order_id = $3, completed_at = $4 where id = $1`, [ref.id, buyer.id, o.id, this.now()]);
    await this.db.query('update members set referred_by_member_id = coalesce(referred_by_member_id, $2) where id = $1', [buyer.id, ref.referrer_member_id]);
    const reward = this.rules.earning.referral;
    const referrerBefore = (await this.members.byId(ref.referrer_member_id))!;
    const r = await this.ledger.post({ memberId: ref.referrer_member_id, kind: 'earn', points: reward.points, reason: reward.title, campaignKey: reward.key, shopifyOrderId: o.id, idempotencyKey: `referral:${ref.id}` });
    const referrer = (await this.members.byId(ref.referrer_member_id))!;
    await this.emit(Metric.referralCompleted, referrer, `referral:${ref.id}`, {
      topic: 'swell/referral/completed', perk: { history_title: reward.title, reward_points: reward.points, completed: true, awarded: true, pending: false },
      referrer: customerSnapshot(referrer, this.rules, this.deps.publicBaseUrl), referred_customer: customerSnapshot(buyer, this.rules, this.deps.publicBaseUrl),
    });
    await this.pointsChanged(referrer, referrerBefore.points_balance, r.balance, reward.title, [o.id], `changed:referral:${ref.id}`, this.now());
    await this.syncProjections(ref.referrer_member_id);
  }

  // ---------- birthdays ----------
  async awardBirthdays(today = this.now()): Promise<number> {
    const month = today.getUTCMonth() + 1; const day = today.getUTCDate(); const year = today.getUTCFullYear();
    const due = (await this.db.query<Member>('select * from members where birthday_month = $1 and birthday_day = $2 and opted_in_at is not null and locked = false', [month, day])).rows;
    let n = 0;
    for (const m of due) {
      const r = await this.ledger.post({ memberId: m.id, kind: 'earn', points: this.rules.earning.birthday.points, reason: this.rules.earning.birthday.title, campaignKey: this.rules.earning.birthday.key, idempotencyKey: `birthday:${m.id}:${year}`, occurredAt: today });
      if (r.duplicate) continue;
      n++;
      const after = (await this.members.byId(m.id))!;
      await this.emit(Metric.customerBirthday, after, `birthday:${m.id}:${year}`, { topic: 'swell/customer/birthday' }, today);
      await this.emit(Metric.pointsEarned, after, `earn:birthday:${m.id}:${year}`, { topic: 'swell/points/earned', perk: { history_title: this.rules.earning.birthday.title, reward_points: this.rules.earning.birthday.points, completed: true, awarded: true, pending: false } }, today);
      await this.pointsChanged(after, m.points_balance, r.balance, this.rules.earning.birthday.title, [], `changed:birthday:${m.id}:${year}`, today);
      await this.syncProjections(m.id);
    }
    return n;
  }


  // ---------- scheduled maintenance (what Yotpo's cron used to do) ----------
  private async once(key: string, memberId: number | null, fn: () => Promise<void>): Promise<boolean> {
    const ins = await this.db.query('insert into reminders_sent (key, member_id) values ($1, $2) on conflict do nothing', [key, memberId]);
    if (ins.rowCount === 0) return false;
    await fn();
    return true;
  }

  /** Re-evaluate members whose tier period ended: demote, keep, or extend. */
  async runTierMaintenance(now = this.now()): Promise<{ evaluated: number; demoted: number; retained: number }> {
    const due = (await this.db.query<Member>('select * from members where tier_ends_at is not null and tier_ends_at <= $1 and locked = false order by id', [now])).rows;
    let demoted = 0, retained = 0;
    const windowMs = this.rules.tiers.evaluationWindowMonths * 30.4375 * 86_400_000;
    for (const m of due) {
      const spend = await this.spendInWindow(m.id);
      const target = evaluateTier(this.rules, { spendCentsInWindow: spend });
      const current = tierByName(this.rules, m.tier);
      const endsAt = target.rank === 0 ? null : new Date(now.getTime() + windowMs);
      await this.members.setTier(m.id, target.name, endsAt);
      const updated = (await this.members.byId(m.id))!;
      if (updated.shopify_customer_id && target.name !== current.name) {
        await enqueue(this.db, 'shopify_tags', { customerGid: customerGid(updated.shopify_customer_id), add: [tierTag(this.rules, target)], remove: allTierTags(this.rules).filter((t) => t !== tierTag(this.rules, target)) });
      }
      if (target.rank < current.rank) {
        demoted++;
        await this.emit(Metric.tierLost, updated, `tier-lost:${m.id}:${now.toISOString().slice(0, 10)}`, { topic: 'swell/tier/lost', old_tier: { name: current.name, rank: current.rank }, new_tier: { name: target.name, rank: target.rank } }, now);
      } else retained++;
      await this.emit(Metric.tierStatusChanged, updated, `tier-status:${m.id}:${now.toISOString().slice(0, 10)}`, { topic: 'swell/tier/status_changed', old_tier: { name: current.name }, new_tier: { name: target.name }, vip_tier_ends_at: endsAt ? endsAt.toISOString().slice(0, 10) : null }, now);
      await this.syncProjections(m.id);
    }
    return { evaluated: due.length, demoted, retained };
  }

  /** Reminder events Klaviyo flows are triggered by. Each fires once per member per occurrence. */
  async runReminders(now = this.now()): Promise<{ expiration: number; redemption: number; points: number; referralShare: number }> {
    const out = { expiration: 0, redemption: 0, points: 0, referralShare: 0 };

    for (const d of await membersDueForReminder(this.db, this.rules, now)) {
      const m = (await this.members.byId(d.id))!;
      if (m.locked || !m.opted_in_at) continue;
      const expireDate = new Date(d.points_expire_at).toISOString().slice(0, 10);
      if (await this.once(`expiration:${m.id}:${expireDate}`, m.id, () => this.emit(Metric.expirationReminder, m, `expiration:${m.id}:${expireDate}`, { topic: 'loyalty/expiration_reminder', points_balance: m.points_balance, points_expire_at: expireDate, loyalty_next_points_expire_on: expireDate, loyalty_next_points_expire_amount: m.points_balance }, now))) out.expiration++;
    }

    const unused = (await this.db.query<Redemption>(`select * from redemptions where status = 'issued' and issued_at <= $1`, [new Date(now.getTime() - 7 * 86_400_000)])).rows;
    for (const r of unused) {
      const m = (await this.members.byId(r.member_id))!;
      if (await this.once(`redemption:${r.id}`, m.id, () => this.emit(Metric.redemptionReminder, m, `redemption-reminder:${r.id}`, { topic: 'swell/redemption/reminder', redemption: { id: r.id, code: r.code, reward_text: r.code, created_at: r.created_at }, redemption_option_name: r.title }, now))) out.redemption++;
    }

    const minPoints = Math.min(...this.rules.redemption.options.map((o) => o.points));
    const idle = (await this.db.query<Member>(
      `select m.* from members m where m.opted_in_at is not null and m.locked = false and m.points_balance >= $1
         and not exists (select 1 from point_transactions t where t.member_id = m.id and t.occurred_at > $2)`,
      [minPoints, new Date(now.getTime() - 30 * 86_400_000)],
    )).rows;
    const month = now.toISOString().slice(0, 7);
    for (const m of idle) {
      if (await this.once(`points:${m.id}:${month}`, m.id, () => this.emit(Metric.pointsReminder, m, `points-reminder:${m.id}:${month}`, { topic: 'swell/points/reminder', points_balance: m.points_balance, redeemable: this.rules.redemption.options.filter((o) => o.points <= m.points_balance).map((o) => o.title) }, now))) out.points++;
    }

    const stale = (await this.db.query<{ id: number; referrer_member_id: number; referred_email: string | null }>(
      `select id, referrer_member_id, referred_email from referrals where status in ('shared','clicked') and created_at <= $1 and created_at > $2`,
      [new Date(now.getTime() - 7 * 86_400_000), new Date(now.getTime() - 60 * 86_400_000)],
    )).rows;
    for (const r of stale) {
      const m = (await this.members.byId(r.referrer_member_id))!;
      if (await this.once(`share:${r.id}`, m.id, () => this.emit(Metric.referralShareReminder, m, `share-reminder:${r.id}`, { topic: 'swell/referral/share_reminder', referred_email: r.referred_email }, now))) out.referralShare++;
    }
    return out;
  }

  /** Everything that should run once a day. */
  async runDaily(now = this.now()) {
    const expiry = await runExpiry(this.db, this.ledger, this.rules, now);
    const birthdays = await this.awardBirthdays(now);
    const tiers = await this.runTierMaintenance(now);
    const reminders = await this.runReminders(now);
    return { expiry, birthdays, tiers, reminders };
  }

  // ---------- storefront view model ----------
  async memberState(memberId: number) {
    const m = (await this.members.byId(memberId))!;
    const spend = await this.spendInWindow(memberId);
    const next = this.nextTier(m.tier);
    const [history, redemptions] = await Promise.all([this.ledger.history(memberId, 20), this.listRedemptions(memberId)]);
    return {
      authenticated: true,
      member: { email: m.email, firstName: m.first_name, pointsBalance: m.points_balance, pointsEarned: m.points_earned_total, pointsExpireAt: m.points_expire_at, optedIn: m.opted_in_at !== null,
        tier: m.tier, tierEndsAt: m.tier_ends_at, nextTier: next ? { name: next.name, minSpendCents: next.minSpendCents, remainingCents: next.minSpendCents != null ? Math.max(0, next.minSpendCents - spend) : null } : null,
        referralCode: m.referral_code, referralLink: m.referral_code ? `${this.deps.publicBaseUrl}${this.rules.referral.landingPath}${m.referral_code}` : null },
      redemptionOptions: this.rules.redemption.options.map((o) => ({ key: o.key, title: o.title, points: o.points, discountType: o.discountType, value: o.value, affordable: m.points_balance >= o.points })),
      activeCoupons: redemptions.filter((r) => r.status === 'issued').map((r) => ({ code: r.code, title: r.title, createdAt: r.created_at })),
      history: history.map((t) => ({ at: t.occurred_at, points: t.points, reason: t.reason, kind: t.kind })),
      program: this.programSummary(),
    };
  }

  programSummary() {
    const e = this.rules.earning;
    return {
      name: this.rules.programName,
      waysToEarn: [
        { key: 'purchase', title: e.purchase.title, description: `${e.purchase.pointsPerDollar} point per $1 spent` },
        ...e.spendThresholdBonuses.map((b) => ({ key: b.key, title: b.title, description: `${b.points} bonus points` })),
        { key: e.signup.key, title: e.signup.title, description: `${e.signup.points} points` },
        { key: e.birthday.key, title: e.birthday.title, description: `${e.birthday.points} points` },
        { key: e.referral.key, title: e.referral.title, description: `${e.referral.points} points when a friend places their first order` },
      ],
      waysToRedeem: this.rules.redemption.options.map((o) => ({ key: o.key, title: o.title, points: o.points })),
      tiers: this.rules.tiers.list.map((t) => ({ name: t.name, rank: t.rank, minSpendCents: t.minSpendCents })),
      referral: { friend: this.rules.referral.friendReward.title, advocatePoints: e.referral.points },
      expiry: this.rules.expiry.mode === 'inactivity' ? `Points expire after ${this.rules.expiry.months} months without earning activity` : 'Points never expire',
    };
  }
}
