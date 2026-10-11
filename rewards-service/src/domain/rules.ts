import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const bonus = z.object({ key: z.string(), title: z.string(), minBasisCents: z.number().int().nonnegative(), points: z.number().int().nonnegative() });
const fixedReward = z.object({ key: z.string(), title: z.string(), points: z.number().int().nonnegative() });
const discountType = z.enum(['fixed_amount', 'percentage', 'free_shipping']);

export const RulesSchema = z.object({
  programName: z.string(),
  currency: z.string().length(3),
  earning: z.object({
    purchase: z.object({
      title: z.string(),
      pointsPerDollar: z.number().nonnegative(),
      basis: z.enum(['subtotal_after_discounts', 'total_paid']),
      rounding: z.enum(['floor', 'round']),
      excludeGiftCards: z.boolean(),
      excludeProductTags: z.array(z.string()),
      pendingDays: z.number().int().nonnegative(),
    }),
    spendThresholdBonuses: z.array(bonus),
    birthday: fixedReward,
    signup: fixedReward,
    referral: fixedReward,
  }),
  redemption: z.object({
    codeLength: z.number().int().min(6).max(16),
    codeAlphabet: z.string().min(10),
    combinesWith: z.object({ orderDiscounts: z.boolean(), productDiscounts: z.boolean(), shippingDiscounts: z.boolean() }),
    options: z.array(z.object({ key: z.string(), title: z.string(), points: z.number().int().positive(), discountType, value: z.number().nonnegative(), minSubtotalCents: z.number().int().nonnegative().default(0) })).min(1),
  }),
  referral: z.object({
    codeLength: z.number().int().min(5).max(12),
    codeAlphabet: z.string().min(10),
    landingPath: z.string().startsWith('/'),
    friendReward: z.object({ title: z.string(), discountType, value: z.number().nonnegative(), firstOrderOnly: z.boolean() }),
    completeOn: z.enum(['first_paid_order']),
    clawbackDays: z.number().int().nonnegative(),
  }),
  tiers: z.object({
    tagPrefix: z.string(),
    evaluationWindowMonths: z.number().int().positive(),
    list: z.array(z.object({ name: z.string(), rank: z.number().int().nonnegative(), minSpendCents: z.number().int().nonnegative().nullable(), pointsMultiplier: z.number().positive(), todo: z.string().optional() })).min(1),
  }),
  expiry: z.object({ mode: z.enum(['inactivity', 'never']), months: z.number().int().positive(), reminderDaysBefore: z.number().int().nonnegative(), title: z.string() }),
});

export type Rules = z.infer<typeof RulesSchema>;
export type RedemptionOption = Rules['redemption']['options'][number];
export type Tier = Rules['tiers']['list'][number];

export function parseRules(raw: unknown): Rules {
  const rules = RulesSchema.parse(raw);
  const ranks = rules.tiers.list.map((t) => t.rank);
  if (new Set(ranks).size !== ranks.length) throw new Error('tier ranks must be unique');
  if (!rules.tiers.list.some((t) => t.rank === 0)) throw new Error('a base tier with rank 0 is required');
  return rules;
}

export async function loadRules(path: string): Promise<Rules> {
  return parseRules(JSON.parse(await readFile(path, 'utf8')));
}
