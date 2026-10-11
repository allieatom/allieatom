import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index.js';
import { LoyaltyService } from '../src/services/loyalty.js';
import { toEarnableOrder, type ShopifyOrderPayload } from '../src/shopify/orders.js';
import { Metric } from '../src/klaviyo/events.js';
import { processOutbox, type OutboxRow } from '../src/klaviyo/outbox.js';
import { FakeShopifyAdmin, paidOrder } from './fakes.js';
import { testDb, testRules } from './helpers.js';

let db: Db; let shopify: FakeShopifyAdmin; let svc: LoyaltyService;
const rules = testRules();
const outboxRows = async (channel?: string) => (await db.query<{ channel: string; payload: Record<string, unknown> }>(channel ? 'select channel, payload from outbox where channel = $1 order by id' : 'select channel, payload from outbox order by id', channel ? [channel] : [])).rows;

beforeAll(async () => { db = await testDb(); shopify = new FakeShopifyAdmin(); svc = new LoyaltyService({ db, rules, shopify, publicBaseUrl: 'https://www.betterrhodes.com', now: () => new Date('2026-10-11T20:00:00Z') }); });
afterAll(async () => { await db?.close(); });

describe('orders/paid', () => {
  it('awards 1 pt per $ of subtotal and auto-enrols the buyer (observed order BR-89796 -> 106 pts)', async () => {
    const o = paidOrder() as unknown as ShopifyOrderPayload;
    const r = await svc.handlePaidOrder(o, toEarnableOrder(o));
    expect(r.pointsAwarded).toBe(106);
    const m = await svc.members.byShopifyCustomerId(31277051641990);
    expect(m?.points_balance).toBe(106);
    expect(m?.opted_in_at).not.toBeNull();
    const events = (await outboxRows('klaviyo_event')).map((r) => r.payload['metric']);
    expect(events).toContain(Metric.pointsEarned);
    expect(events).toContain(Metric.pointsChanged);
    const changed = (await outboxRows('klaviyo_event')).find((r) => r.payload['metric'] === Metric.pointsChanged)!.payload['properties'] as Record<string, unknown>;
    expect(changed).toMatchObject({ previous_balance: 0, current_balance: 106, difference: 106, points_changed_reason: 'Make a Purchase', related_order_ids: ['18937236553862'] });
    const profile = (await outboxRows('klaviyo_profile'))[0]!.payload['properties'] as Record<string, unknown>;
    expect(profile).toMatchObject({ swell_point_balance: 106, swell_vip_tier_name: 'Bronze', loyalty_opt_in: true, loyalty_nt_amount_cents: 90000 - 10691 });
    expect(profile['swell_referral_link']).toMatch(/^https:\/\/www\.betterrhodes\.com\/pages\/loyalty-refer\?ref=[a-z0-9]{7}$/);
  });

  it('ignores a replayed order', async () => {
    const o = paidOrder() as unknown as ShopifyOrderPayload;
    const r = await svc.handlePaidOrder(o, toEarnableOrder(o));
    expect(r.duplicate).toBe(true);
    expect((await svc.members.byShopifyCustomerId(31277051641990))?.points_balance).toBe(106);
  });

  it('adds the $200 bonus and promotes to Silver at $900 of spend in the window', async () => {
    const big = paidOrder({ id: 2, name: 'BR-2', subtotal_price: '850.00', current_subtotal_price: '850.00', total_price: '850.00', line_items: [{ id: 9, title: 'Case', quantity: 1, price: '850.00', gift_card: false }] }) as unknown as ShopifyOrderPayload;
    const r = await svc.handlePaidOrder(big, toEarnableOrder(big));
    expect(r.pointsAwarded).toBe(850 + 225);
    const m = await svc.members.byShopifyCustomerId(31277051641990);
    expect(m?.tier).toBe('Silver');
    const tagJob = (await outboxRows('shopify_tags')).at(-1)!.payload;
    expect(tagJob).toMatchObject({ add: ['swell_vip_silver'] });
    expect((tagJob['remove'] as string[])).toContain('swell_vip_bronze');
    expect((await outboxRows('klaviyo_event')).map((r) => r.payload['metric'])).toContain(Metric.tierEarned);
  });

  it('reverses points on cancellation without going negative', async () => {
    const o = paidOrder({ id: 3, name: 'BR-3', subtotal_price: '50.00', current_subtotal_price: '50.00', total_price: '50.00', customer: { id: 777, email: 'spender@example.com', first_name: 'S', last_name: 'P' }, email: 'spender@example.com', line_items: [{ id: 1, title: 'x', quantity: 1, price: '50.00' }] }) as unknown as ShopifyOrderPayload;
    await svc.handlePaidOrder(o, toEarnableOrder(o));
    const m = (await svc.members.byShopifyCustomerId(777))!;
    await svc.ledger.post({ memberId: m.id, kind: 'adjust', points: -30, reason: 'test spend' });
    const r = await svc.handleCancelledOrder({ ...o, cancelled_at: '2026-10-11T21:00:00Z' });
    expect(r.reversed).toBe(20);
    expect(await svc.ledger.balance(m.id)).toBe(0);
    const audit = await db.query('select * from audit_log where action = $1 and member_id = $2', ['reversal_shortfall', m.id]);
    expect(audit.rows.length).toBe(1);
  });

  it('deducts proportionally on partial refund, capped at what the order earned', async () => {
    const o = paidOrder({ id: 4, name: 'BR-4', subtotal_price: '100.00', current_subtotal_price: '100.00', total_price: '100.00', customer: { id: 778, email: 'refund@example.com' }, email: 'refund@example.com', line_items: [{ id: 1, title: 'x', quantity: 2, price: '50.00' }] }) as unknown as ShopifyOrderPayload;
    await svc.handlePaidOrder(o, toEarnableOrder(o));
    const r1 = await svc.handleRefund({ id: 1, order_id: 4, created_at: '2026-10-12T00:00:00Z', refund_line_items: [{ line_item_id: 1, quantity: 1, subtotal: '50.00' }] });
    expect(r1.reversed).toBe(50);
    const r2 = await svc.handleRefund({ id: 2, order_id: 4, created_at: '2026-10-12T00:00:00Z', refund_line_items: [{ line_item_id: 1, quantity: 1, subtotal: '50.00' }] });
    expect(r2.reversed).toBe(50);
    const r3 = await svc.handleRefund({ id: 3, order_id: 4, created_at: '2026-10-12T00:00:00Z', refund_line_items: [{ line_item_id: 1, quantity: 1, subtotal: '50.00' }] });
    expect(r3.reversed).toBe(0);
  });
});

describe('customers', () => {
  it('awards 60 points once when a store account is enabled', async () => {
    await svc.handleCustomerUpsert({ id: 900, email: 'new@example.com', first_name: 'N', state: 'disabled' });
    expect((await svc.members.byEmail('new@example.com'))?.points_balance).toBe(0);
    await svc.handleCustomerUpsert({ id: 900, email: 'new@example.com', first_name: 'N', state: 'enabled' });
    await svc.handleCustomerUpsert({ id: 900, email: 'new@example.com', first_name: 'N', state: 'enabled' });
    const m = await svc.members.byEmail('new@example.com');
    expect(m?.points_balance).toBe(60);
    expect((await svc.ledger.history(m!.id))[0]).toMatchObject({ reason: 'Create an Account', points: 60 });
  });
});

describe('redemptions', () => {
  it('issues a single-use Shopify code with Yotpo-identical shape and deducts points', async () => {
    const m = (await svc.members.byShopifyCustomerId(31277051641990))!;
    const before = m.points_balance;
    const r = await svc.redeem(m.id, 'off_15');
    expect(r.status).toBe('issued');
    expect(r.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(await svc.ledger.balance(m.id)).toBe(before - 300);
    const spec = shopify.created.at(-1)!;
    expect(spec).toMatchObject({ code: r.code, discountType: 'fixed_amount', value: 15, usageLimit: 1, minSubtotalCents: 100, customerGid: 'gid://shopify/Customer/31277051641990', combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false } });
    const ev = (await outboxRows('klaviyo_event')).find((x) => x.payload['metric'] === Metric.redemptionCreated)!.payload['properties'] as Record<string, unknown>;
    expect(ev['redemption_option']).toMatchObject({ name: '$15 Off', amount: 300, cost_text: '300 Points', discount_type: 'fixed_amount', discount_amount_cents: 1500 });
  });

  it('refunds points when Shopify fails to create the code', async () => {
    const m = (await svc.members.byShopifyCustomerId(31277051641990))!;
    const before = m.points_balance;
    shopify.failNext = true;
    await expect(svc.redeem(m.id, 'off_5')).rejects.toThrow('simulated Shopify outage');
    expect(await svc.ledger.balance(m.id)).toBe(before);
    const failed = await db.query(`select status from redemptions where member_id = $1 order by id desc limit 1`, [m.id]);
    expect(failed.rows[0]).toMatchObject({ status: 'failed' });
  });

  it('refuses when the balance is too low', async () => {
    const poor = await svc.members.upsertFromShopify({ shopifyCustomerId: 555, email: 'poor@example.com' });
    await expect(svc.redeem(poor.id, 'off_20')).rejects.toThrow(/insufficient points/);
  });

  it('marks the coupon used when it appears on a paid order', async () => {
    const m = (await svc.members.byShopifyCustomerId(31277051641990))!;
    const issued = (await svc.listRedemptions(m.id)).find((r) => r.status === 'issued')!;
    const o = paidOrder({ id: 5, name: 'BR-5', subtotal_price: '40.00', current_subtotal_price: '40.00', total_price: '25.00', discount_codes: [{ code: issued.code, amount: '15.00', type: 'fixed_amount' }], line_items: [{ id: 1, title: 'x', quantity: 1, price: '40.00' }] }) as unknown as ShopifyOrderPayload;
    await svc.handlePaidOrder(o, toEarnableOrder(o));
    const after = (await svc.listRedemptions(m.id)).find((r) => r.id === issued.id)!;
    expect(after.status).toBe('used');
    expect(after.used_order_id).toBe(5);
  });
});

describe('referrals', () => {
  it('friend claims a 10% code; first paid order completes the referral and pays the advocate 200 points', async () => {
    const advocate = (await svc.members.byShopifyCustomerId(31277051641990))!;
    const claim = await svc.claimFriendCode(advocate.referral_code!, 'Friend@Example.com');
    expect(claim.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(shopify.created.at(-1)).toMatchObject({ discountType: 'percentage', value: 10, usageLimit: 1 });
    const again = await svc.claimFriendCode(advocate.referral_code!, 'friend@example.com');
    expect(again.code).toBe(claim.code);
    await expect(svc.claimFriendCode(advocate.referral_code!, advocate.email)).rejects.toThrow(/self-referral/);

    const before = advocate.points_balance;
    const o = paidOrder({ id: 6, name: 'BR-6', email: 'friend@example.com', customer: { id: 8888, email: 'friend@example.com', first_name: 'F', orders_count: 1 }, subtotal_price: '80.00', current_subtotal_price: '80.00', total_price: '72.00', discount_codes: [{ code: claim.code, amount: '8.00', type: 'percentage' }], line_items: [{ id: 1, title: 'x', quantity: 1, price: '80.00' }] }) as unknown as ShopifyOrderPayload;
    await svc.handlePaidOrder(o, toEarnableOrder(o));
    expect(await svc.ledger.balance(advocate.id)).toBe(before + 200);
    const ref = await db.query<{ status: string; completed_order_id: number }>('select status, completed_order_id from referrals where friend_code = $1', [claim.code]);
    expect(ref.rows[0]).toMatchObject({ status: 'completed', completed_order_id: 6 });
    expect((await outboxRows('klaviyo_event')).map((r) => r.payload['metric'])).toContain(Metric.referralCompleted);
    // replay must not pay twice
    await svc.handlePaidOrder(o, toEarnableOrder(o));
    expect(await svc.ledger.balance(advocate.id)).toBe(before + 200);
  });
});

describe('birthdays and outbox', () => {
  it('awards 100 birthday points once per year', async () => {
    const m = await svc.members.upsertFromShopify({ shopifyCustomerId: 4242, email: 'bday@example.com', optIn: true });
    await svc.members.setBirthday(m.id, 10, 11, 1980);
    expect(await svc.awardBirthdays(new Date('2026-10-11T10:00:00Z'))).toBe(1);
    expect(await svc.awardBirthdays(new Date('2026-10-11T23:00:00Z'))).toBe(0);
    expect(await svc.ledger.balance(m.id)).toBe(100);
  });

  it('delivers outbox rows, skipping when a channel is disabled, retrying on failure', async () => {
    const seen: OutboxRow[] = [];
    let fail = true;
    const sender = { async send(row: OutboxRow) { seen.push(row); if (row.channel === 'shopify_tags' && fail) { fail = false; throw new Error('boom'); } return row.channel === 'klaviyo_event' ? 'skipped' as const : 'sent' as const; } };
    const first = await processOutbox(db, sender, 1000);
    expect(first.failed).toBe(1);
    expect(first.skipped).toBeGreaterThan(0);
    const pending = await db.query<{ n: string }>(`select count(*)::text as n from outbox where status = 'pending'`);
    expect(Number(pending.rows[0]!.n)).toBe(1); // the failed row is re-queued with backoff
  });
});
