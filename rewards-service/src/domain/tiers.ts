import type { Rules, Tier } from './rules.js';

export interface TierMetrics { spendCentsInWindow: number }

export function baseTier(rules: Rules): Tier {
  return rules.tiers.list.find((t) => t.rank === 0)!;
}

/** Highest-ranked tier whose spend threshold is met. Tiers with unknown (null) thresholds are never awarded automatically. */
export function evaluateTier(rules: Rules, metrics: TierMetrics): Tier {
  const eligible = rules.tiers.list
    .filter((t) => t.minSpendCents !== null && metrics.spendCentsInWindow >= t.minSpendCents)
    .sort((a, b) => b.rank - a.rank);
  return eligible[0] ?? baseTier(rules);
}

export function tierByName(rules: Rules, name: string | null | undefined): Tier {
  return rules.tiers.list.find((t) => t.name.toLowerCase() === (name ?? '').toLowerCase()) ?? baseTier(rules);
}

/** Shopify customer tag for a tier, e.g. swell_vip_bronze (kept identical to Yotpo's for segment compatibility). */
export function tierTag(rules: Rules, tier: Tier): string {
  return `${rules.tiers.tagPrefix}${tier.name.toLowerCase()}`;
}

export function allTierTags(rules: Rules): string[] {
  return rules.tiers.list.map((t) => tierTag(rules, t));
}
