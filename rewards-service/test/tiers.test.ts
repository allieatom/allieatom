import { describe, expect, it } from 'vitest';
import { evaluateTier, tierTag, allTierTags, tierByName } from '../src/domain/tiers.js';
import { testRules } from './helpers.js';

describe('tiers', () => {
  const rules = testRules();
  it('uses only tiers with known thresholds (Silver at $900; Gold/Platinum still unknown)', () => {
    expect(evaluateTier(rules, { spendCentsInWindow: 89_999 }).name).toBe('Bronze');
    expect(evaluateTier(rules, { spendCentsInWindow: 90_000 }).name).toBe('Silver');
    expect(evaluateTier(rules, { spendCentsInWindow: 10_000_000 }).name).toBe('Silver');
  });
  it('awards the highest tier whose threshold is met once thresholds are set', () => {
    const r = structuredClone(rules);
    r.tiers.list[1]!.minSpendCents = 25_000; r.tiers.list[2]!.minSpendCents = 50_000; r.tiers.list[3]!.minSpendCents = 100_000;
    expect(evaluateTier(r, { spendCentsInWindow: 24_999 }).name).toBe('Bronze');
    expect(evaluateTier(r, { spendCentsInWindow: 25_000 }).name).toBe('Silver');
    expect(evaluateTier(r, { spendCentsInWindow: 99_999 }).name).toBe('Gold');
    expect(evaluateTier(r, { spendCentsInWindow: 100_000 }).name).toBe('Platinum');
  });
  it('produces Yotpo-compatible customer tags', () => {
    expect(tierTag(rules, tierByName(rules, 'silver'))).toBe('swell_vip_silver');
    expect(allTierTags(rules)).toEqual(['swell_vip_bronze', 'swell_vip_silver', 'swell_vip_gold', 'swell_vip_platinum']);
  });
});
