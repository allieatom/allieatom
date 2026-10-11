import { randomInt } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { Rules } from './rules.js';

export interface Member {
  id: number; shopify_customer_id: number | null; email: string; first_name: string | null; last_name: string | null;
  opted_in_at: Date | null; birthday_month: number | null; birthday_day: number | null; birthday_year: number | null;
  tier: string; tier_ends_at: Date | null; referral_code: string | null; referred_by_member_id: number | null;
  points_balance: number; points_earned_total: number; points_expire_at: Date | null; legacy_yotpo_customer_id: number | null; locked: boolean;
}

export function randomCode(alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

export function normalizeEmail(email: string): string { return email.trim().toLowerCase(); }

export class Members {
  constructor(private readonly db: Db, private readonly rules: Rules) {}

  async byId(id: number): Promise<Member | null> {
    return (await this.db.query<Member>('select * from members where id = $1', [id])).rows[0] ?? null;
  }
  async byShopifyCustomerId(customerId: number): Promise<Member | null> {
    return (await this.db.query<Member>('select * from members where shopify_customer_id = $1', [customerId])).rows[0] ?? null;
  }
  async byEmail(email: string): Promise<Member | null> {
    return (await this.db.query<Member>('select * from members where email = $1', [normalizeEmail(email)])).rows[0] ?? null;
  }
  async byReferralCode(code: string): Promise<Member | null> {
    return (await this.db.query<Member>('select * from members where referral_code = $1', [code.toLowerCase()])).rows[0] ?? null;
  }

  /** Create or update a member from Shopify customer data. Email is the stable identity; Shopify id attaches when known. */
  async upsertFromShopify(input: { shopifyCustomerId?: number | null; email: string; firstName?: string | null; lastName?: string | null; optIn?: boolean }): Promise<Member> {
    const email = normalizeEmail(input.email);
    const existing = (await this.byEmail(email)) ?? (input.shopifyCustomerId ? await this.byShopifyCustomerId(input.shopifyCustomerId) : null);
    if (existing) {
      const r = await this.db.query<Member>(
        `update members set shopify_customer_id = coalesce($2, shopify_customer_id), email = $3,
           first_name = coalesce($4, first_name), last_name = coalesce($5, last_name),
           opted_in_at = case when $6::boolean and opted_in_at is null then now() else opted_in_at end, updated_at = now()
         where id = $1 returning *`,
        [existing.id, input.shopifyCustomerId ?? null, email, input.firstName ?? null, input.lastName ?? null, input.optIn ?? false],
      );
      return r.rows[0]!;
    }
    const code = await this.uniqueReferralCode();
    const r = await this.db.query<Member>(
      `insert into members (shopify_customer_id, email, first_name, last_name, opted_in_at, referral_code)
       values ($1,$2,$3,$4, case when $5::boolean then now() else null end, $6) returning *`,
      [input.shopifyCustomerId ?? null, email, input.firstName ?? null, input.lastName ?? null, input.optIn ?? false, code],
    );
    return r.rows[0]!;
  }

  async setTier(memberId: number, tier: string, endsAt: Date | null): Promise<void> {
    await this.db.query('update members set tier = $2, tier_ends_at = $3, updated_at = now() where id = $1', [memberId, tier, endsAt]);
  }

  async setBirthday(memberId: number, month: number, day: number, year: number | null): Promise<void> {
    await this.db.query('update members set birthday_month = $2, birthday_day = $3, birthday_year = $4, updated_at = now() where id = $1', [memberId, month, day, year]);
  }

  private async uniqueReferralCode(): Promise<string> {
    for (let i = 0; i < 10; i++) {
      const code = randomCode(this.rules.referral.codeAlphabet, this.rules.referral.codeLength);
      const clash = await this.db.query('select 1 from members where referral_code = $1', [code]);
      if (clash.rows.length === 0) return code;
    }
    throw new Error('could not generate a unique referral code');
  }
}
