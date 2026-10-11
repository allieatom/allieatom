import type { Db } from '../db/index.js';
import type { KlaviyoEvent } from './events.js';

export type OutboxChannel = 'klaviyo_event' | 'klaviyo_profile' | 'shopify_tags' | 'shopify_metafields';
export interface OutboxRow { id: number; channel: OutboxChannel; payload: Record<string, unknown>; status: string; attempts: number }

export async function enqueue(db: Db, channel: OutboxChannel, payload: Record<string, unknown>): Promise<void> {
  await db.query('insert into outbox (channel, payload) values ($1, $2)', [channel, JSON.stringify(payload)]);
}
export async function enqueueEvent(db: Db, ev: KlaviyoEvent): Promise<void> {
  await enqueue(db, 'klaviyo_event', { ...ev, time: ev.time.toISOString() });
}

export interface OutboxSender { send(row: OutboxRow): Promise<'sent' | 'skipped'> }

/** Deliver pending outbox rows with exponential backoff. Returns counts. */
export async function processOutbox(db: Db, sender: OutboxSender, batch = 100): Promise<{ sent: number; skipped: number; failed: number }> {
  const rows = (await db.query<OutboxRow>(
    `select id, channel, payload, status, attempts from outbox where status = 'pending' and next_attempt_at <= now() order by id limit $1`, [batch],
  )).rows;
  const result = { sent: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
    try {
      const outcome = await sender.send(row);
      await db.query(`update outbox set status = $2, attempts = attempts + 1, sent_at = now() where id = $1`, [row.id, outcome]);
      result[outcome]++;
    } catch (err) {
      const attempts = row.attempts + 1;
      const delaySeconds = Math.min(3600, 30 * 2 ** attempts);
      const status = attempts >= 10 ? 'failed' : 'pending';
      await db.query(
        `update outbox set status = $2, attempts = $3, last_error = $4, next_attempt_at = now() + make_interval(secs => $5) where id = $1`,
        [row.id, status, attempts, String((err as Error).message ?? err).slice(0, 2000), delaySeconds],
      );
      result.failed++;
    }
  }
  return result;
}

/** Real sender: Klaviyo Events + Profile Import APIs; Shopify tags/metafields through the Admin client. */
export class LiveSender implements OutboxSender {
  constructor(private readonly deps: {
    klaviyoApiKey?: string; klaviyoEnabled: boolean; shopifyEnabled: boolean;
    shopify: { addCustomerTags(gid: string, t: string[]): Promise<void>; removeCustomerTags(gid: string, t: string[]): Promise<void>; setCustomerMetafields(gid: string, f: { namespace: string; key: string; type: string; value: string }[]): Promise<void> };
    fetchImpl?: typeof fetch; revision?: string;
  }) {}

  private async klaviyo(path: string, body: unknown): Promise<void> {
    const f = this.deps.fetchImpl ?? fetch;
    const res = await f(`https://a.klaviyo.com/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.api+json', Accept: 'application/vnd.api+json', Authorization: `Klaviyo-API-Key ${this.deps.klaviyoApiKey}`, revision: this.deps.revision ?? '2025-07-15' },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) throw new Error(`Klaviyo ${res.status} (retryable)`);
    if (!res.ok) throw new Error(`Klaviyo ${res.status}: ${await res.text()}`);
  }

  async send(row: OutboxRow): Promise<'sent' | 'skipped'> {
    const p = row.payload as Record<string, unknown>;
    switch (row.channel) {
      case 'klaviyo_event': {
        if (!this.deps.klaviyoEnabled || !this.deps.klaviyoApiKey) return 'skipped';
        await this.klaviyo('events', { data: { type: 'event', attributes: {
          properties: p['properties'], time: p['time'], unique_id: p['uniqueId'],
          metric: { data: { type: 'metric', attributes: { name: p['metric'] } } },
          profile: { data: { type: 'profile', attributes: { email: p['email'], properties: p['profileProperties'] ?? {} } } },
        } } });
        return 'sent';
      }
      case 'klaviyo_profile': {
        if (!this.deps.klaviyoEnabled || !this.deps.klaviyoApiKey) return 'skipped';
        await this.klaviyo('profile-import', { data: { type: 'profile', attributes: { email: p['email'], properties: p['properties'] } } });
        return 'sent';
      }
      case 'shopify_tags': {
        if (!this.deps.shopifyEnabled) return 'skipped';
        const gid = p['customerGid'] as string; const add = (p['add'] as string[]) ?? []; const remove = (p['remove'] as string[]) ?? [];
        if (remove.length) await this.deps.shopify.removeCustomerTags(gid, remove);
        if (add.length) await this.deps.shopify.addCustomerTags(gid, add);
        return 'sent';
      }
      case 'shopify_metafields': {
        if (!this.deps.shopifyEnabled) return 'skipped';
        await this.deps.shopify.setCustomerMetafields(p['customerGid'] as string, p['fields'] as { namespace: string; key: string; type: string; value: string }[]);
        return 'sent';
      }
    }
  }
}
