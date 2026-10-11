import { describe, expect, it } from 'vitest';
import { testRules } from './helpers.js';

describe('rules.json', () => {
  it('parses and mirrors the observed Better Rhodes program', () => {
    const r = testRules();
    expect(r.earning.purchase.pointsPerDollar).toBe(1);
    expect(r.earning.spendThresholdBonuses[0]).toMatchObject({ minBasisCents: 20000, points: 225 });
    expect(r.earning.birthday.points).toBe(100);
    expect(r.earning.referral.points).toBe(200);
    expect(r.redemption.options.map((o) => [o.points, o.value])).toEqual([[100, 5], [200, 10], [300, 15], [400, 20]]);
    expect(r.expiry).toMatchObject({ mode: 'inactivity', months: 12 });
  });
});
