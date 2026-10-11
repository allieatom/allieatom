import type { Member } from '../domain/members.js';
import type { Rules } from '../domain/rules.js';

/** Metric names exactly as Yotpo sends them, so existing Klaviyo flows keep firing. */
export const Metric = {
  pointsEarned: 'Swell Points Earned',
  pointsChanged: 'Swell Points Changed',
  pointsReminder: 'Swell Points Reminder',
  redemptionCreated: 'Swell Redemption Created',
  redemptionReminder: 'Swell Redemption Reminder',
  tierEarned: 'Swell Tier Earned',
  tierLost: 'Swell Tier Lost',
  tierStatusChanged: 'Swell Tier Status Changed',
  referralShare: 'Swell Referral Share',
  referralShareReminder: 'Swell Referral Share Reminder',
  referralCompleted: 'Swell Referral Completed',
  customerBirthday: 'Swell Customer Birthday',
  birthdayCaptured: 'Swell Birthday Captured',
  accountCreated: 'Swell Account Created',
  optIn: 'Loyalty Opt In',
  optOut: 'Loyalty Opt Out',
  expirationReminder: 'Loyalty Expiration Reminder',
} as const;
export type MetricName = (typeof Metric)[keyof typeof Metric];

const isoDate = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const isoTs = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export function referralLink(baseUrl: string, rules: Rules, member: Member): string | null {
  return member.referral_code ? `${baseUrl.replace(/\/$/, '')}${rules.referral.landingPath}${member.referral_code}` : null;
}

/** The `customer` object Yotpo embeds in every event (subset we can populate). */
export function customerSnapshot(member: Member, rules: Rules, baseUrl: string, extra: { totalPurchases?: number; totalSpendCents?: number } = {}) {
  return {
    email: member.email,
    first_name: member.first_name,
    last_name: member.last_name,
    third_party_id: member.shopify_customer_id ? String(member.shopify_customer_id) : null,
    thirty_party_id: member.shopify_customer_id ? String(member.shopify_customer_id) : null,
    points_balance: member.points_balance,
    points_earned: member.points_earned_total,
    points_expire_at: isoTs(member.points_expire_at),
    vip_tier_name: member.tier,
    vip_tier_ends_at: isoDate(member.tier_ends_at),
    is_opt_in: member.opted_in_at !== null,
    loyalty_opt_in_date: isoDate(member.opted_in_at),
    has_store_account: member.shopify_customer_id !== null,
    is_member: member.opted_in_at !== null,
    is_affiliate: false,
    credit_balance: '$0',
    credit_balance_in_customer_currency: '$0',
    referral_link: referralLink(baseUrl, rules, member),
    referral_discount_code: null,
    referral_code: member.referral_code ? { code: member.referral_code } : null,
    total_purchases: extra.totalPurchases ?? null,
    total_spend_cents: extra.totalSpendCents ?? null,
  };
}

/** Profile properties Yotpo maintains on every Klaviyo profile (same keys). */
export function profileProperties(member: Member, rules: Rules, baseUrl: string, nextTier: { name: string; minSpendCents: number | null } | null, spendCentsInWindow: number) {
  const remaining = nextTier?.minSpendCents != null ? Math.max(0, nextTier.minSpendCents - spendCentsInWindow) : null;
  return {
    swell_point_balance: member.points_balance,
    swell_points_earned: member.points_earned_total,
    swell_vip_tier_name: member.tier,
    swell_vip_tier_ends_at: isoDate(member.tier_ends_at) ?? 'none',
    swell_points_expire_at: isoDate(member.points_expire_at),
    swell_pea_date: isoDate(member.points_expire_at),
    swell_referral_link: referralLink(baseUrl, rules, member),
    swell_referral_discount_code: 'none',
    swell_has_account: member.shopify_customer_id !== null,
    swell_is_affiliate: false,
    swell_credit_balance: '$0',
    loyalty_credit_balance_in_customer_currency: '$0',
    loyalty_opt_in: member.opted_in_at !== null,
    loyalty_opt_in_date: isoDate(member.opted_in_at),
    loyalty_next_points_expire_on: isoDate(member.points_expire_at),
    loyalty_next_points_expire_amount: member.points_balance,
    loyalty_birthday_date: member.birthday_month && member.birthday_day ? `${String(member.birthday_month).padStart(2, '0')}-${String(member.birthday_day).padStart(2, '0')}` : null,
    loyalty_mt_amount_cents: 0, loyalty_mt_points: 0, loyalty_mt_purchases: 0, loyalty_mt_referrals: 0,
    loyalty_nt_amount_cents: remaining, loyalty_nt_points: 0, loyalty_nt_purchases: 0, loyalty_nt_referrals: 0,
  };
}

export interface KlaviyoEvent { metric: MetricName; email: string; time: Date; uniqueId: string; properties: Record<string, unknown>; profileProperties?: Record<string, unknown> }
