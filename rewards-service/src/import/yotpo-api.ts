import type { MemberSnapshot } from './snapshot.js';

/**
 * Yotpo Loyalty API v2 (https://loyalty.yotpo.com/api/v2, headers x-guid / x-api-key, 1,500 calls/min).
 * Usable once the Yotpo account is unlocked; the customer object shape below is the one Yotpo also embeds in its Klaviyo events.
 */
export interface YotpoCustomer {
  email: string; first_name?: string | null; last_name?: string | null; third_party_id?: string | null; id?: number;
  points_balance: number; points_earned?: number; vip_tier_name?: string | null; vip_tier_ends_at?: string | null; points_expire_at?: string | null;
  referral_code?: { code: string } | null; loyalty_opt_in_date?: string | null; is_opt_in?: boolean;
  birth_day?: number | null; birthday_month?: number | null; birth_year?: number | null;
  history_items?: { action: string; points: number; date: string; status?: string }[];
}

export function yotpoCustomerToSnapshot(c: YotpoCustomer, snapshotAt: Date): MemberSnapshot {
  const d = (v: string | null | undefined) => (v ? new Date(v) : null);
  return {
    source: 'yotpo', snapshotAt, email: c.email.toLowerCase(),
    shopifyCustomerId: c.third_party_id && /^\d+$/.test(c.third_party_id) ? Number(c.third_party_id) : null,
    firstName: c.first_name ?? null, lastName: c.last_name ?? null,
    pointsBalance: Math.max(0, Math.round(c.points_balance ?? 0)), pointsEarned: c.points_earned ?? null,
    tierName: c.vip_tier_name ?? null, tierEndsAt: d(c.vip_tier_ends_at), pointsExpireAt: d(c.points_expire_at),
    referralCode: c.referral_code?.code ?? null,
    optedInAt: c.is_opt_in === false ? null : d(c.loyalty_opt_in_date) ?? snapshotAt,
    birthday: c.birthday_month && c.birth_day ? { month: c.birthday_month, day: c.birth_day, year: c.birth_year ?? null } : null,
    legacyYotpoCustomerId: c.id ?? null,
  };
}

export class YotpoClient {
  constructor(private readonly guid: string, private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch, private readonly base = 'https://loyalty.yotpo.com/api/v2') {}
  private headers() { return { 'x-guid': this.guid, 'x-api-key': this.apiKey, Accept: 'application/json' }; }

  async fetchCustomer(email: string, withHistory = true): Promise<YotpoCustomer | null> {
    const res = await this.fetchImpl(`${this.base}/customers?customer_email=${encodeURIComponent(email)}&with_history=${withHistory}`, { headers: this.headers() });
    if (res.status === 404) return null;
    if (res.status === 429) throw new Error('Yotpo rate limited (429)');
    if (!res.ok) throw new Error(`Yotpo ${res.status}: ${await res.text()}`);
    return (await res.json()) as YotpoCustomer;
  }

  /** Customers updated in the last 7 days (for delta loads during the shadow period). */
  async fetchRecent(): Promise<YotpoCustomer[]> {
    const res = await this.fetchImpl(`${this.base}/customers/recent`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Yotpo ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as YotpoCustomer[] | { customers: YotpoCustomer[] };
    return Array.isArray(json) ? json : json.customers;
  }

  /** Pull many customers under the published rate limit. */
  async *fetchMany(emails: Iterable<string>, perSecond = 20): AsyncGenerator<{ email: string; customer: YotpoCustomer | null; error?: string }> {
    const interval = 1000 / perSecond;
    for (const email of emails) {
      const started = Date.now();
      try { yield { email, customer: await this.fetchCustomer(email) }; }
      catch (err) { yield { email, customer: null, error: (err as Error).message }; }
      const wait = interval - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }
}
