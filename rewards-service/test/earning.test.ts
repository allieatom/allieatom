import { describe, expect, it } from 'vitest';
import { computePurchaseEarnings, type EarnableOrder } from '../src/domain/earning.js';
import { testRules } from './helpers.js';

const order = (subtotalCents: number, extra: Partial<EarnableOrder> = {}): EarnableOrder => ({
  shopifyOrderId: 1, name: 'BR-1', subtotalAfterDiscountsCents: subtotalCents, totalPaidCents: subtotalCents + 1500,
  lines: [{ title: 'Wine', quantity: 1, discountedTotalCents: subtotalCents, isGiftCard: false, productTags: [] }], paidAt: new Date(), ...extra,
});

describe('computePurchaseEarnings', () => {
  const rules = testRules();
  it('awards 1 point per whole dollar, floored (observed: $106.91 -> 106 pts)', () => {
    expect(computePurchaseEarnings(rules, order(10691))).toEqual([{ campaignKey: 'purchase', title: 'Make a Purchase', points: 106 }]);
  });
  it('adds the $200 single-purchase bonus (observed: +225)', () => {
    const lines = computePurchaseEarnings(rules, order(27600));
    expect(lines).toContainEqual({ campaignKey: 'purchase', title: 'Make a Purchase', points: 276 });
    expect(lines).toContainEqual({ campaignKey: 'spend_200_single_purchase', title: 'Spend $200 in a single Purchase', points: 225 });
  });
  it('excludes gift cards from the basis', () => {
    const o = order(15000, { lines: [
      { title: 'Gift card', quantity: 1, discountedTotalCents: 10000, isGiftCard: true, productTags: [] },
      { title: 'Beer', quantity: 1, discountedTotalCents: 5000, isGiftCard: false, productTags: [] },
    ] });
    expect(computePurchaseEarnings(rules, o)).toEqual([{ campaignKey: 'purchase', title: 'Make a Purchase', points: 50 }]);
  });
  it('applies a tier multiplier before flooring', () => {
    expect(computePurchaseEarnings(rules, order(10000), 1.5)[0]?.points).toBe(150);
  });
  it('awards nothing for a zero basis', () => {
    expect(computePurchaseEarnings(rules, order(0))).toEqual([]);
  });
});
