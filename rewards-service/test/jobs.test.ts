import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index.js';
import { LoyaltyService } from '../src/services/loyalty.js';
import { toEarnableOrder, type ShopifyOrderPayload } from '../src/shopify/orders.js';
import { Metric } from '../src/klaviyo/events.js';
import { FakeShopifyAdmin, paidOrder } from './fakes.js';
import { testDb, testRules } from './helpers.js';

let db: Db; let svc: LoyaltyService; let clock = new Date('2026-10-11T12:00:00Z');
beforeAll(async () => { db = await testDb(); svc = new LoyaltyService({ db, rules: testRules(), shopify: new FakeShopifyAdmin(), publicBaseUrl: 'https://www.betterrhodes.com', now: () => clock }); });
afterAll(async () => { await db?.close(); });
const metrics = async () => (await db.query<{ payload: { metric: string } }>(`select payload from outbox where channel = 'klaviyo_event' order by id`)).rows.map((r) => r.payload.metric);

describe('scheduled maintenance', () => {
  it('promotes on spend, then demotes at period end when spend in the window has dropped', async () => {
    const o = paidOrder({ id: 101, name: 'BR-101', subtotal_price: '950.00', current_subtotal_price: '950.00', total_price: '950.00', line_items: [{ id: 1, title: 'Case', quantity: 1, price: '950.00' }] }) as unknown as ShopifyOrderPayload;
    await svc.handlePaidOrder(o, toEarnableOrder(o));
    const m = (await svc.members.byShopifyCustomerId(31277051641990))!;
    expect(m.tier).toBe('Silver');
    clock = new Date('2027-10-20T12:00:00Z'); // tier period over, order now outside the 12-month window
    const r = await svc.runTierMaintenance();
    expect(r).toMatchObject({ evaluated: 1, demoted: 1 });
    expect((await svc.members.byId(m.id))!.tier).toBe('Bronze');
    expect(await metrics()).toContain(Metric.tierLost);
  });

  it('sends each reminder once', async () => {
    clock = new Date('2026-10-11T12:00:00Z');
    const m = (await svc.members.byShopifyCustomerId(31277051641990))!;
    await svc.redeem(m.id, 'off_5');
    clock = new Date('2026-11-20T12:00:00Z'); // >7 days since coupon, >30 days idle, well inside the expiry reminder window? (expiry 2027-10-11: no)
    const first = await svc.runReminders();
    expect(first).toMatchObject({ redemption: 1, points: 1, expiration: 0 });
    const second = await svc.runReminders();
    expect(second).toMatchObject({ redemption: 0, points: 0 });
    clock = new Date('2027-09-20T12:00:00Z'); // 21 days before the 2027-10-11 expiry
    const third = await svc.runReminders();
    expect(third.expiration).toBe(1);
    expect(await metrics()).toEqual(expect.arrayContaining([Metric.redemptionReminder, Metric.pointsReminder, Metric.expirationReminder]));
    expect(await svc.runReminders()).toMatchObject({ expiration: 0 });
  });

  it('runDaily returns a combined summary', async () => {
    const r = await svc.runDaily();
    expect(Object.keys(r)).toEqual(['expiry', 'birthdays', 'tiers', 'reminders']);
  });
});
