import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import type { MemberSnapshot } from './snapshot.js';

/**
 * Adapter for a Klaviyo profile export (Lists & Segments -> Export -> include the swell_* / loyalty_* properties).
 * Yotpo kept these properties in sync in real time, so they are a faithful balance snapshot while the Yotpo admin is locked.
 */
export interface KlaviyoRow { [column: string]: string }

const pick = (row: KlaviyoRow, ...names: string[]): string | null => {
  for (const n of names) {
    const key = Object.keys(row).find((k) => k.trim().toLowerCase() === n.toLowerCase());
    const v = key ? row[key]?.trim() : undefined;
    if (v && v !== 'none' && v !== 'null' && v !== 'undefined') return v;
  }
  return null;
};
const num = (v: string | null): number | null => { if (v === null) return null; const n = Number(v.replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : null; };
const date = (v: string | null): Date | null => { if (!v) return null; const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v); return Number.isNaN(d.getTime()) ? null : d; };
const bool = (v: string | null): boolean => v !== null && ['true', '1', 'yes'].includes(v.toLowerCase());

export function parseBirthday(v: string | null): { month: number; day: number; year: number | null } | null {
  if (!v) return null;
  let m: RegExpMatchArray | null;
  if ((m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  if ((m = v.match(/^(\d{1,2})-(\d{1,2})$/))) return { year: null, month: Number(m[1]), day: Number(m[2]) };
  if ((m = v.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/))) return { year: m[3] ? Number(m[3]) : null, month: Number(m[1]), day: Number(m[2]) };
  return null;
}

/** Extract Yotpo's referral code from a rwrd.io short link or a bare code. */
export function referralCodeFromLink(v: string | null): string | null {
  if (!v) return null;
  const m = v.match(/rwrd\.io\/([a-z0-9]+)/i) ?? v.match(/^([a-z0-9]{5,12})$/i);
  return m ? m[1]!.toLowerCase() : null;
}

export function klaviyoRowToSnapshot(row: KlaviyoRow, snapshotAt: Date, shopifyIdsByEmail: Map<string, { id: number; tags: string[] }> = new Map()): MemberSnapshot | null {
  const email = pick(row, 'Email', 'email', '$email');
  if (!email) return null;
  const balance = num(pick(row, 'swell_point_balance'));
  const optIn = bool(pick(row, 'loyalty_opt_in'));
  if (balance === null && !optIn) return null; // never a loyalty member
  const shopify = shopifyIdsByEmail.get(email.toLowerCase());
  const tagTier = shopify?.tags.find((t) => t.toLowerCase().startsWith('swell_vip_'))?.slice('swell_vip_'.length);
  const tierName = pick(row, 'swell_vip_tier_name') ?? (tagTier ? tagTier.charAt(0).toUpperCase() + tagTier.slice(1) : null);
  return {
    source: 'klaviyo', snapshotAt, email: email.toLowerCase(),
    shopifyCustomerId: shopify?.id ?? null,
    firstName: pick(row, 'First Name', 'first_name'), lastName: pick(row, 'Last Name', 'last_name'),
    pointsBalance: Math.max(0, Math.round(balance ?? 0)),
    pointsEarned: num(pick(row, 'swell_points_earned')),
    tierName, tierEndsAt: date(pick(row, 'swell_vip_tier_ends_at', 'swell_vt_ends_at_date')),
    pointsExpireAt: date(pick(row, 'swell_points_expire_at', 'swell_pea_date', 'loyalty_next_points_expire_on')),
    referralCode: referralCodeFromLink(pick(row, 'swell_referral_link')),
    optedInAt: optIn ? date(pick(row, 'loyalty_opt_in_date')) ?? snapshotAt : null,
    birthday: parseBirthday(pick(row, 'loyalty_birthday_date')),
  };
}

export async function readKlaviyoCsv(path: string): Promise<KlaviyoRow[]> {
  return parse(await readFile(path, 'utf8'), { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true }) as KlaviyoRow[];
}

/** Shopify customer export (Shopify admin CSV or Matrixify): maps email -> { id, tags }. */
export async function readShopifyCustomersCsv(path: string): Promise<Map<string, { id: number; tags: string[] }>> {
  const rows = parse(await readFile(path, 'utf8'), { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true }) as KlaviyoRow[];
  const map = new Map<string, { id: number; tags: string[] }>();
  for (const r of rows) {
    const email = pick(r, 'Email', 'email'); const id = num(pick(r, 'Customer ID', 'ID', 'Id', 'id'));
    if (!email || !id) continue;
    map.set(email.toLowerCase(), { id, tags: (pick(r, 'Tags', 'tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean) });
  }
  return map;
}
