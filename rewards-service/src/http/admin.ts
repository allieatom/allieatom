import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import type { LoyaltyService } from '../services/loyalty.js';
import { runExpiry } from '../domain/expiry.js';
import type { Rules } from '../domain/rules.js';
import type { ShopifyAdminApi } from '../shopify/admin.js';

export interface AdminDeps { db: Db; loyalty: LoyaltyService; rules: Rules; token: string; shopify: ShopifyAdminApi }

export async function adminRoutes(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  app.addHook('preHandler', async (req, reply) => {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${deps.token}`) return reply.code(401).send({ error: 'unauthorized' });
  });

  app.get('/admin/members/search', async (req, reply) => {
    const q = z.object({ email: z.string().optional(), shopifyCustomerId: z.coerce.number().optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad query' });
    const m = q.data.email ? await deps.loyalty.members.byEmail(q.data.email) : q.data.shopifyCustomerId ? await deps.loyalty.members.byShopifyCustomerId(q.data.shopifyCustomerId) : null;
    if (!m) return reply.code(404).send({ error: 'not found' });
    return deps.loyalty.memberState(m.id);
  });

  app.post('/admin/members/:id/adjust', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = z.object({ points: z.number().int().refine((n) => n !== 0), reason: z.string().min(3), actor: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'points (non-zero int), reason, actor required' });
    const r = await deps.loyalty.ledger.post({ memberId: id, kind: 'adjust', points: body.data.points, reason: body.data.reason, campaignKey: 'manual', metadata: { actor: body.data.actor } });
    await deps.db.query(`insert into audit_log (actor, action, member_id, details) values ($1, 'manual_adjust', $2, $3)`, [body.data.actor, id, JSON.stringify(body.data)]);
    await deps.loyalty.syncProjections(id);
    return { balance: r.balance };
  });

  app.post('/admin/jobs/expire', async () => runExpiry(deps.db, deps.loyalty.ledger, deps.rules));
  app.post('/admin/jobs/birthdays', async () => ({ awarded: await deps.loyalty.awardBirthdays() }));
  app.post('/admin/jobs/tiers', async () => deps.loyalty.runTierMaintenance());
  app.post('/admin/jobs/reminders', async () => deps.loyalty.runReminders());
  app.post('/admin/jobs/daily', async () => deps.loyalty.runDaily());

  /** Verifies the Shopify credentials end to end (token grant + one read-only query). */
  app.get('/admin/shopify/ping', async (_req, reply) => {
    try { return { ok: true, shop: await deps.shopify.ping() }; }
    catch (err) { return reply.code(502).send({ ok: false, error: (err as Error).message }); }
  });

  app.get('/admin/stats', async () => {
    const [members, balance, outbox] = await Promise.all([
      deps.db.query<{ n: string }>('select count(*)::text as n from members where opted_in_at is not null'),
      deps.db.query<{ s: string }>('select coalesce(sum(points_balance),0)::text as s from members'),
      deps.db.query<{ status: string; n: string }>('select status, count(*)::text as n from outbox group by status'),
    ]);
    return { optedInMembers: Number(members.rows[0]?.n ?? 0), outstandingPoints: Number(balance.rows[0]?.s ?? 0), outbox: Object.fromEntries(outbox.rows.map((r) => [r.status, Number(r.n)])) };
  });
}
