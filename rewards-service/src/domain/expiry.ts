import type { Db } from '../db/index.js';
import type { Ledger } from './ledger.js';
import type { Rules } from './rules.js';

export interface ExpiryRunResult { expiredMembers: number; expiredPoints: number }

/** Expire whole balances whose inactivity window has elapsed. Safe to run repeatedly (each member expires once per window). */
export async function runExpiry(db: Db, ledger: Ledger, rules: Rules, now: Date = new Date()): Promise<ExpiryRunResult> {
  if (rules.expiry.mode === 'never') return { expiredMembers: 0, expiredPoints: 0 };
  const due = await db.query<{ id: number; points_balance: number; points_expire_at: Date }>(
    'select id, points_balance, points_expire_at from members where points_balance > 0 and points_expire_at is not null and points_expire_at <= $1 order by id', [now],
  );
  let expiredPoints = 0;
  for (const m of due.rows) {
    const key = `expire:${m.id}:${new Date(m.points_expire_at).toISOString()}`;
    const r = await ledger.post({ memberId: m.id, kind: 'expire', points: -m.points_balance, reason: rules.expiry.title, campaignKey: 'expiry', idempotencyKey: key, occurredAt: now });
    if (!r.duplicate) expiredPoints += m.points_balance;
  }
  return { expiredMembers: due.rows.length, expiredPoints };
}

/** Members whose points will expire within the reminder window (for the "Loyalty Expiration Reminder" event). */
export async function membersDueForReminder(db: Db, rules: Rules, now: Date = new Date()): Promise<{ id: number; points_balance: number; points_expire_at: Date }[]> {
  const until = new Date(now.getTime() + rules.expiry.reminderDaysBefore * 86_400_000);
  return (await db.query<{ id: number; points_balance: number; points_expire_at: Date }>(
    'select id, points_balance, points_expire_at from members where points_balance > 0 and points_expire_at > $1 and points_expire_at <= $2 order by points_expire_at', [now, until],
  )).rows;
}
