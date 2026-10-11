import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index.js';
import { InsufficientPointsError, Ledger } from '../src/domain/ledger.js';
import { Members } from '../src/domain/members.js';
import { runExpiry, membersDueForReminder } from '../src/domain/expiry.js';
import { testDb, testRules } from './helpers.js';

let db: Db; const rules = testRules(); let ledger: Ledger; let members: Members;
beforeAll(async () => { db = await testDb(); ledger = new Ledger(db, { expiryMonths: 12 }); members = new Members(db, rules); });
afterAll(async () => { await db?.close(); });

describe('Ledger', () => {
  it('posts earnings, caches balance and sets a 12-month inactivity expiry', async () => {
    const m = await members.upsertFromShopify({ shopifyCustomerId: 101, email: 'A@Example.com', firstName: 'A', optIn: true });
    expect(m.email).toBe('a@example.com');
    expect(m.referral_code).toMatch(/^[a-z0-9]{7}$/);
    const when = new Date('2026-10-11T18:40:00Z');
    const r = await ledger.post({ memberId: m.id, kind: 'earn', points: 106, reason: 'Make a Purchase', campaignKey: 'purchase', shopifyOrderId: 18937236553862, idempotencyKey: 'order:18937236553862:purchase', occurredAt: when });
    expect(r.balance).toBe(106);
    const after = await members.byId(m.id);
    expect(after?.points_balance).toBe(106);
    expect(after?.points_earned_total).toBe(106);
    expect(new Date(after!.points_expire_at!).toISOString()).toBe('2027-10-11T00:00:00.000Z'); // Yotpo truncates to the date
  });

  it('is idempotent on the idempotency key', async () => {
    const m = await members.byShopifyCustomerId(101);
    const dup = await ledger.post({ memberId: m!.id, kind: 'earn', points: 106, reason: 'Make a Purchase', idempotencyKey: 'order:18937236553862:purchase' });
    expect(dup.duplicate).toBe(true);
    expect(await ledger.balance(m!.id)).toBe(106);
  });

  it('refuses to redeem more than the balance', async () => {
    const m = await members.byShopifyCustomerId(101);
    await expect(ledger.post({ memberId: m!.id, kind: 'redeem', points: -200, reason: '$10 Off' })).rejects.toBeInstanceOf(InsufficientPointsError);
    expect(await ledger.balance(m!.id)).toBe(106);
  });

  it('redeems and records history newest-first', async () => {
    const m = await members.byShopifyCustomerId(101);
    const r = await ledger.post({ memberId: m!.id, kind: 'redeem', points: -100, reason: '$5 Off', campaignKey: 'off_5' });
    expect(r.balance).toBe(6);
    const h = await ledger.history(m!.id);
    expect(h.map((t) => t.points)).toEqual([-100, 106]);
  });

  it('expires whole balances after the inactivity window, once', async () => {
    const m = await members.upsertFromShopify({ shopifyCustomerId: 102, email: 'b@example.com' });
    await ledger.post({ memberId: m.id, kind: 'import', points: 1234, reason: 'Imported balance', occurredAt: new Date('2025-10-11T14:19:26Z') });
    const soon = await membersDueForReminder(db, rules, new Date('2026-09-20T00:00:00Z'));
    expect(soon.map((x) => x.id)).toContain(m.id);
    const first = await runExpiry(db, ledger, rules, new Date('2026-10-11T07:32:48Z'));
    expect(first).toEqual({ expiredMembers: 1, expiredPoints: 1234 });
    expect(await ledger.balance(m.id)).toBe(0);
    const again = await runExpiry(db, ledger, rules, new Date('2026-10-12T00:00:00Z'));
    expect(again.expiredPoints).toBe(0);
    const h = await ledger.history(m.id);
    expect(h[0]).toMatchObject({ kind: 'expire', points: -1234, reason: 'Points Expiration' });
  });

  it('recomputes a cached balance from the ledger', async () => {
    const m = await members.byShopifyCustomerId(101);
    await db.query('update members set points_balance = 999 where id = $1', [m!.id]);
    expect(await ledger.recompute(m!.id)).toBe(6);
  });
});
