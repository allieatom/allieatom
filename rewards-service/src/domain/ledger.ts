import type { Db } from '../db/index.js';

export type TransactionKind = 'earn' | 'redeem' | 'adjust' | 'expire' | 'reverse' | 'import';

export interface PostInput {
  memberId: number;
  kind: TransactionKind;
  points: number;              // signed: positive adds, negative removes
  reason: string;              // human-readable, mirrors Yotpo history titles ("Make a Purchase", "Points Expiration", ...)
  campaignKey?: string;
  shopifyOrderId?: number;
  redemptionId?: number;
  idempotencyKey?: string;     // same key => no-op, returns existing row
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface PointTransaction {
  id: number; member_id: number; kind: TransactionKind; points: number; reason: string; campaign_key: string | null;
  shopify_order_id: number | null; redemption_id: number | null; idempotency_key: string | null; occurred_at: Date; metadata: Record<string, unknown>;
}

export interface PostResult { transaction: PointTransaction; balance: number; duplicate: boolean }

export class InsufficientPointsError extends Error {
  constructor(public readonly balance: number, public readonly requested: number) {
    super(`insufficient points: balance ${balance}, requested ${requested}`);
  }
}

export interface LedgerOptions { expiryMonths: number | null }

export class Ledger {
  constructor(private readonly db: Db, private readonly opts: LedgerOptions) {}

  /** Append a transaction and update the cached balance atomically. Idempotent on idempotencyKey. */
  async post(input: PostInput): Promise<PostResult> {
    if (!Number.isInteger(input.points) || input.points === 0) throw new Error('points must be a non-zero integer');
    return this.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const existing = await tx.query<PointTransaction>('select * from point_transactions where idempotency_key = $1', [input.idempotencyKey]);
        if (existing.rows[0]) {
          const bal = await tx.query<{ points_balance: number }>('select points_balance from members where id = $1', [input.memberId]);
          return { transaction: existing.rows[0], balance: bal.rows[0]?.points_balance ?? 0, duplicate: true };
        }
      }
      const locked = await tx.query<{ points_balance: number; locked: boolean }>('select points_balance, locked from members where id = $1 for update', [input.memberId]);
      const member = locked.rows[0];
      if (!member) throw new Error(`member ${input.memberId} not found`);
      if (member.locked && input.kind !== 'adjust') throw new Error(`member ${input.memberId} is locked`);
      const newBalance = member.points_balance + input.points;
      if (newBalance < 0) throw new InsufficientPointsError(member.points_balance, -input.points);

      const occurredAt = input.occurredAt ?? new Date();
      const inserted = await tx.query<PointTransaction>(
        `insert into point_transactions (member_id, kind, points, reason, campaign_key, shopify_order_id, redemption_id, idempotency_key, occurred_at, metadata)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [input.memberId, input.kind, input.points, input.reason, input.campaignKey ?? null, input.shopifyOrderId ?? null,
         input.redemptionId ?? null, input.idempotencyKey ?? null, occurredAt, JSON.stringify(input.metadata ?? {})],
      );
      const earnedDelta = input.points > 0 && input.kind !== 'reverse' ? input.points : 0;
      // Inactivity-based expiry: any positive earning activity pushes the whole balance's expiry out by N months (Yotpo behaviour observed).
      const touchesExpiry = input.points > 0 && (input.kind === 'earn' || input.kind === 'import' || input.kind === 'adjust') && this.opts.expiryMonths !== null;
      await tx.query(
        `update members set points_balance = $2, points_earned_total = points_earned_total + $3,
           points_expire_at = case when $4::boolean then date_trunc('day', ($5::timestamptz + make_interval(months => $6::int)) at time zone 'UTC') at time zone 'UTC' else points_expire_at end,
           updated_at = now()
         where id = $1`,
        [input.memberId, newBalance, earnedDelta, touchesExpiry, occurredAt, this.opts.expiryMonths ?? 0],
      );
      if (newBalance === 0) await tx.query('update members set points_expire_at = null where id = $1', [input.memberId]);
      return { transaction: inserted.rows[0]!, balance: newBalance, duplicate: false };
    });
  }

  async balance(memberId: number): Promise<number> {
    const r = await this.db.query<{ points_balance: number }>('select points_balance from members where id = $1', [memberId]);
    return r.rows[0]?.points_balance ?? 0;
  }

  async history(memberId: number, limit = 50): Promise<PointTransaction[]> {
    return (await this.db.query<PointTransaction>(
      'select * from point_transactions where member_id = $1 order by occurred_at desc, id desc limit $2', [memberId, limit],
    )).rows;
  }

  /** Recompute a member's cached balance from the ledger (reconciliation / repair). */
  async recompute(memberId: number): Promise<number> {
    const r = await this.db.query<{ sum: string | null }>('select sum(points)::text as sum from point_transactions where member_id = $1', [memberId]);
    const sum = Number(r.rows[0]?.sum ?? 0);
    await this.db.query('update members set points_balance = $2, updated_at = now() where id = $1', [memberId, sum]);
    return sum;
  }
}
