import type { Db } from '../db/index.js';
import { Ledger } from '../domain/ledger.js';
import { Members } from '../domain/members.js';
import type { Rules } from '../domain/rules.js';
import { tierByName } from '../domain/tiers.js';

/** One member as known by the legacy system at `snapshotAt`. Produced by the Klaviyo CSV and Yotpo API adapters. */
export interface MemberSnapshot {
  source: 'klaviyo' | 'yotpo';
  snapshotAt: Date;
  email: string;
  shopifyCustomerId?: number | null;
  firstName?: string | null;
  lastName?: string | null;
  pointsBalance: number;
  pointsEarned?: number | null;
  tierName?: string | null;
  tierEndsAt?: Date | null;
  pointsExpireAt?: Date | null;
  referralCode?: string | null;      // Yotpo's 7-char code; we keep it so /r/<code> matches the old rwrd.io/<code> path
  optedInAt?: Date | null;
  birthday?: { month: number; day: number; year: number | null } | null;
  legacyYotpoCustomerId?: number | null;
}

export interface ApplyResult { memberId: number; action: 'created' | 'updated' | 'unchanged'; pointsDelta: number; warnings: string[] }

export interface ApplyOptions { dryRun?: boolean }

export async function applyMemberSnapshot(db: Db, rules: Rules, snap: MemberSnapshot, opts: ApplyOptions = {}): Promise<ApplyResult> {
  const members = new Members(db, rules);
  const ledger = new Ledger(db, { expiryMonths: rules.expiry.mode === 'inactivity' ? rules.expiry.months : null });
  const warnings: string[] = [];
  const email = snap.email.trim().toLowerCase();
  if (!email.includes('@')) throw new Error(`invalid email: ${snap.email}`);

  if (opts.dryRun) {
    const existing = await members.byEmail(email);
    const delta = snap.pointsBalance - (existing?.points_balance ?? 0);
    return { memberId: existing?.id ?? 0, action: existing ? (delta ? 'updated' : 'unchanged') : 'created', pointsDelta: delta, warnings };
  }

  return db.transaction(async (tx) => {
    const txMembers = new Members(tx, rules);
    const txLedger = new Ledger(tx, { expiryMonths: rules.expiry.mode === 'inactivity' ? rules.expiry.months : null });
    const before = await txMembers.byEmail(email);
    const m = await txMembers.upsertFromShopify({ shopifyCustomerId: snap.shopifyCustomerId ?? null, email, firstName: snap.firstName ?? null, lastName: snap.lastName ?? null, optIn: Boolean(snap.optedInAt) });
    const action: ApplyResult['action'] = before ? 'updated' : 'created';

    if (snap.optedInAt) await tx.query('update members set opted_in_at = least(coalesce(opted_in_at, $2), $2) where id = $1', [m.id, snap.optedInAt]);

    if (snap.referralCode) {
      const code = snap.referralCode.toLowerCase();
      if (m.referral_code !== code) {
        const clash = await tx.query<{ id: number }>('select id from members where referral_code = $1 and id <> $2', [code, m.id]);
        if (clash.rows.length) warnings.push(`referral code ${code} already belongs to member ${clash.rows[0]!.id}; kept generated code`);
        else await tx.query('update members set referral_code = $2 where id = $1', [m.id, code]);
      }
    }

    const tier = tierByName(rules, snap.tierName ?? 'Bronze');
    if (snap.tierName && tier.name.toLowerCase() !== snap.tierName.toLowerCase()) warnings.push(`unknown tier "${snap.tierName}", stored as ${tier.name}`);
    await txMembers.setTier(m.id, tier.name, snap.tierEndsAt ?? null);

    if (snap.birthday) await txMembers.setBirthday(m.id, snap.birthday.month, snap.birthday.day, snap.birthday.year);
    if (snap.legacyYotpoCustomerId) await tx.query('update members set legacy_yotpo_customer_id = $2 where id = $1', [m.id, snap.legacyYotpoCustomerId]);

    const current = (await txMembers.byId(m.id))!.points_balance;
    const delta = snap.pointsBalance - current;
    if (delta !== 0) {
      // Date the import so the ledger-derived expiry equals the legacy expiry when we know it.
      const occurredAt = snap.pointsExpireAt ? new Date(Date.UTC(snap.pointsExpireAt.getUTCFullYear(), snap.pointsExpireAt.getUTCMonth() - rules.expiry.months, snap.pointsExpireAt.getUTCDate())) : snap.snapshotAt;
      await txLedger.post({
        memberId: m.id, kind: 'import', points: delta, reason: `Imported balance (${snap.source})`, campaignKey: 'import',
        idempotencyKey: `import:${snap.source}:${m.id}:${snap.snapshotAt.toISOString().slice(0, 10)}`, occurredAt,
        metadata: { snapshotBalance: snap.pointsBalance, previousBalance: current },
      });
    }
    // Authoritative legacy values override derived ones.
    await tx.query(
      `update members set points_expire_at = coalesce($2, points_expire_at), points_earned_total = coalesce($3, points_earned_total), updated_at = now() where id = $1`,
      [m.id, snap.pointsExpireAt ?? null, snap.pointsEarned ?? null],
    );
    if (snap.pointsBalance === 0) await tx.query('update members set points_expire_at = null where id = $1', [m.id]);

    return { memberId: m.id, action: delta === 0 && before ? 'unchanged' : action, pointsDelta: delta, warnings };
  });
}

export interface ImportReport {
  rows: number; created: number; updated: number; unchanged: number; errors: { email: string; error: string }[];
  pointsImported: number; missingShopifyId: number; warnings: string[];
}

export function emptyReport(): ImportReport {
  return { rows: 0, created: 0, updated: 0, unchanged: 0, errors: [], pointsImported: 0, missingShopifyId: 0, warnings: [] };
}

export async function applyAll(db: Db, rules: Rules, snaps: Iterable<MemberSnapshot>, opts: ApplyOptions = {}): Promise<ImportReport> {
  const report = emptyReport();
  for (const snap of snaps) {
    report.rows++;
    if (!snap.shopifyCustomerId) report.missingShopifyId++;
    try {
      const r = await applyMemberSnapshot(db, rules, snap, opts);
      report[r.action]++;
      report.pointsImported += Math.max(0, r.pointsDelta);
      report.warnings.push(...r.warnings.map((w) => `${snap.email}: ${w}`));
    } catch (err) {
      report.errors.push({ email: snap.email, error: (err as Error).message });
    }
  }
  return report;
}
