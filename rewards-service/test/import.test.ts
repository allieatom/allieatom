import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index.js';
import { Members } from '../src/domain/members.js';
import { Ledger } from '../src/domain/ledger.js';
import { klaviyoRowToSnapshot, parseBirthday, readKlaviyoCsv, readShopifyCustomersCsv, referralCodeFromLink } from '../src/import/klaviyo-csv.js';
import { applyAll } from '../src/import/snapshot.js';
import { yotpoCustomerToSnapshot } from '../src/import/yotpo-api.js';
import { testDb, testRules } from './helpers.js';

let db: Db; const rules = testRules(); const dir = mkdtempSync(join(tmpdir(), 'rewards-import-'));
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db?.close(); });

const klaviyoCsv = `Email,First Name,Last Name,swell_point_balance,swell_points_earned,swell_vip_tier_name,swell_vip_tier_ends_at,swell_points_expire_at,swell_referral_link,loyalty_opt_in,loyalty_opt_in_date,loyalty_birthday_date
wendy@example.com,Wendy,Johnson,2722,3122,Bronze,none,2026-10-08,http://rwrd.io/ujqrj2e,true,2023-01-16,09-04
reilly@example.com,R,S,540,1200,Silver,2027-03-01,2027-05-20,http://rwrd.io/abc1234,true,2023-06-05,
zero@example.com,Z,Z,0,300,Bronze,none,,http://rwrd.io/zzzzzzz,true,2024-01-01,
nonmember@example.com,N,M,,,,,,,false,,
`;
const shopifyCsv = `Customer ID,First Name,Last Name,Email,Tags
6162239225990,Wendy,Johnson,wendy@example.com,"newsletter, swell_vip_bronze"
6401308557446,R,S,reilly@example.com,"Login with Shop, swell_vip_silver"
`;

describe('Klaviyo CSV importer (Yotpo-less path)', () => {
  it('parses helper formats', () => {
    expect(referralCodeFromLink('http://rwrd.io/hykrwev')).toBe('hykrwev');
    expect(referralCodeFromLink('none')).toBeNull();
    expect(parseBirthday('09-04')).toEqual({ month: 9, day: 4, year: null });
    expect(parseBirthday('1967-09-04')).toEqual({ month: 9, day: 4, year: 1967 });
    expect(parseBirthday('9/4/1967')).toEqual({ month: 9, day: 4, year: 1967 });
  });

  it('imports balances, expiry dates, tiers, referral codes and birthdays; skips non-members', async () => {
    writeFileSync(join(dir, 'k.csv'), klaviyoCsv); writeFileSync(join(dir, 's.csv'), shopifyCsv);
    const ids = await readShopifyCustomersCsv(join(dir, 's.csv'));
    const snapshotAt = new Date('2026-10-11T00:00:00Z');
    const snaps = (await readKlaviyoCsv(join(dir, 'k.csv'))).map((r) => klaviyoRowToSnapshot(r, snapshotAt, ids)).filter((s) => s !== null);
    expect(snaps).toHaveLength(3);
    const report = await applyAll(db, rules, snaps);
    expect(report).toMatchObject({ rows: 3, created: 3, updated: 0, unchanged: 0, pointsImported: 2722 + 540, missingShopifyId: 1, errors: [] });

    const members = new Members(db, rules);
    const wendy = (await members.byEmail('wendy@example.com'))!;
    expect(wendy).toMatchObject({ shopify_customer_id: 6162239225990, points_balance: 2722, points_earned_total: 3122, tier: 'Bronze', referral_code: 'ujqrj2e', birthday_month: 9, birthday_day: 4 });
    expect(new Date(wendy.points_expire_at!).toISOString()).toBe('2026-10-08T00:00:00.000Z');
    expect(new Date(wendy.opted_in_at!).toISOString().slice(0, 10)).toBe('2023-01-16');
    const ledger = new Ledger(db, { expiryMonths: 12 });
    const h = await ledger.history(wendy.id);
    expect(h[0]).toMatchObject({ kind: 'import', points: 2722, reason: 'Imported balance (klaviyo)' });
    expect(new Date(h[0]!.occurred_at).toISOString()).toBe('2025-10-08T00:00:00.000Z'); // dated so expiry = legacy expiry

    const reilly = (await members.byEmail('reilly@example.com'))!;
    expect(reilly).toMatchObject({ tier: 'Silver', points_balance: 540 });
    expect(new Date(reilly.tier_ends_at!).toISOString().slice(0, 10)).toBe('2027-03-01');
    const zero = (await members.byEmail('zero@example.com'))!;
    expect(zero).toMatchObject({ points_balance: 0, points_earned_total: 300, points_expire_at: null });
    expect(await members.byEmail('nonmember@example.com')).toBeNull();
  });

  it('is a no-op when the same snapshot is replayed, and posts a delta for a newer snapshot', async () => {
    const ids = await readShopifyCustomersCsv(join(dir, 's.csv'));
    const same = (await readKlaviyoCsv(join(dir, 'k.csv'))).map((r) => klaviyoRowToSnapshot(r, new Date('2026-10-11T00:00:00Z'), ids)).filter((s) => s !== null);
    const replay = await applyAll(db, rules, same);
    expect(replay).toMatchObject({ created: 0, updated: 0, unchanged: 3, pointsImported: 0 });

    const newer = klaviyoCsv.replace('wendy@example.com,Wendy,Johnson,2722', 'wendy@example.com,Wendy,Johnson,2922');
    writeFileSync(join(dir, 'k2.csv'), newer);
    const snaps2 = (await readKlaviyoCsv(join(dir, 'k2.csv'))).map((r) => klaviyoRowToSnapshot(r, new Date('2026-10-12T00:00:00Z'), ids)).filter((s) => s !== null);
    const r2 = await applyAll(db, rules, snaps2);
    expect(r2).toMatchObject({ updated: 1, unchanged: 2, pointsImported: 200 });
    const wendy = (await new Members(db, rules).byEmail('wendy@example.com'))!;
    expect(wendy.points_balance).toBe(2922);
  });

  it('dry-run reports without writing', async () => {
    const snaps = [{ source: 'klaviyo' as const, snapshotAt: new Date(), email: 'dry@example.com', pointsBalance: 10 }];
    const r = await applyAll(db, rules, snaps, { dryRun: true });
    expect(r.created).toBe(1);
    expect(await new Members(db, rules).byEmail('dry@example.com')).toBeNull();
  });

  it('maps a Yotpo API customer object (shape observed in Klaviyo events)', () => {
    const snap = yotpoCustomerToSnapshot({
      email: 'joelwendyj@msn.com', first_name: 'Wendy', last_name: 'Johnson', third_party_id: '6162239225990', id: 1237590940,
      points_balance: 2722, points_earned: 3122, vip_tier_name: 'Bronze', vip_tier_ends_at: null, points_expire_at: '2026-10-08T00:00:00.000+00:00',
      referral_code: { code: 'ujqrj2e' }, loyalty_opt_in_date: '2023-01-16', is_opt_in: true, birth_day: 4, birthday_month: 9, birth_year: 1967,
    }, new Date('2026-10-11T00:00:00Z'));
    expect(snap).toMatchObject({ source: 'yotpo', shopifyCustomerId: 6162239225990, pointsBalance: 2722, pointsEarned: 3122, tierName: 'Bronze', referralCode: 'ujqrj2e', legacyYotpoCustomerId: 1237590940, birthday: { month: 9, day: 4, year: 1967 } });
    expect(snap.pointsExpireAt?.toISOString()).toBe('2026-10-08T00:00:00.000Z');
  });
});
