import type { Rules } from './rules.js';

export interface OrderLine { title: string; quantity: number; discountedTotalCents: number; isGiftCard: boolean; productTags: string[] }
export interface EarnableOrder { shopifyOrderId: number; name: string; subtotalAfterDiscountsCents: number; totalPaidCents: number; lines: OrderLine[]; paidAt: Date }
export interface EarningLine { campaignKey: string; title: string; points: number }

/** Eligible basis in cents after excluding gift cards / excluded product tags. */
export function eligibleBasisCents(rules: Rules, order: EarnableOrder): number {
  const p = rules.earning.purchase;
  const base = p.basis === 'total_paid' ? order.totalPaidCents : order.subtotalAfterDiscountsCents;
  const excluded = order.lines
    .filter((l) => (p.excludeGiftCards && l.isGiftCard) || l.productTags.some((t) => p.excludeProductTags.includes(t)))
    .reduce((s, l) => s + l.discountedTotalCents, 0);
  return Math.max(0, base - excluded);
}

export function computePurchaseEarnings(rules: Rules, order: EarnableOrder, tierMultiplier = 1): EarningLine[] {
  const p = rules.earning.purchase;
  const basis = eligibleBasisCents(rules, order);
  const rawPoints = (basis / 100) * p.pointsPerDollar * tierMultiplier;
  const points = p.rounding === 'floor' ? Math.floor(rawPoints) : Math.round(rawPoints);
  const lines: EarningLine[] = [];
  if (points > 0) lines.push({ campaignKey: 'purchase', title: p.title, points });
  for (const b of rules.earning.spendThresholdBonuses) {
    if (basis >= b.minBasisCents && b.points > 0) lines.push({ campaignKey: b.key, title: b.title, points: b.points });
  }
  return lines;
}
