import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyAppProxySignature } from '../shopify/hmac.js';
import type { LoyaltyService } from '../services/loyalty.js';

export interface ProxyDeps { loyalty: LoyaltyService; shopifySecret: string | null }

/**
 * Shopify forwards https://www.betterrhodes.com/apps/rewards/* to these routes, adding shop, path_prefix, timestamp,
 * logged_in_customer_id and a signature. Identity therefore comes from Shopify, never from the browser.
 */
export async function proxyRoutes(app: FastifyInstance, deps: ProxyDeps): Promise<void> {
  app.addHook('preHandler', async (req, reply) => {
    if (!deps.shopifySecret) return reply.code(503).send({ error: 'storefront proxy not configured (set SHOPIFY_API_SECRET or SHOPIFY_CLIENT_SECRET)' });
    const q = req.query as Record<string, string | string[] | undefined>;
    if (!verifyAppProxySignature(q, deps.shopifySecret)) return reply.code(401).send({ error: 'invalid signature' });
    const ts = Number(q['timestamp']);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return reply.code(401).send({ error: 'stale request' });
  });

  const customerId = (req: { query: unknown }): number | null => {
    const v = (req.query as Record<string, string | undefined>)['logged_in_customer_id'];
    return v && /^\d+$/.test(v) ? Number(v) : null;
  };
  const memberFor = async (req: { query: unknown }) => {
    const cid = customerId(req);
    return cid ? deps.loyalty.members.byShopifyCustomerId(cid) : null;
  };

  app.get('/proxy/me', async (req) => {
    const m = await memberFor(req);
    if (!m) return { authenticated: false, program: deps.loyalty.programSummary() };
    return deps.loyalty.memberState(m.id);
  });

  app.post('/proxy/opt-in', async (req, reply) => {
    const m = await memberFor(req);
    if (!m) return reply.code(401).send({ error: 'login required' });
    await deps.loyalty.optIn(m.id);
    return deps.loyalty.memberState(m.id);
  });

  app.post('/proxy/redeem', async (req, reply) => {
    const m = await memberFor(req);
    if (!m) return reply.code(401).send({ error: 'login required' });
    const body = z.object({ optionKey: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'optionKey required' });
    try {
      const r = await deps.loyalty.redeem(m.id, body.data.optionKey);
      return { code: r.code, title: r.title, pointsSpent: r.points_spent, state: await deps.loyalty.memberState(m.id) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/proxy/referral/share', async (req, reply) => {
    const m = await memberFor(req);
    if (!m) return reply.code(401).send({ error: 'login required' });
    const body = z.object({ channel: z.string().default('link'), recipients: z.array(z.string().email()).max(10).default([]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid body' });
    await deps.loyalty.recordReferralShare(m.id, body.data.channel, body.data.recipients);
    return { ok: true };
  });

  /** Friend side: works logged-out. */
  app.post('/proxy/referral/claim', async (req, reply) => {
    const body = z.object({ referralCode: z.string().min(4), email: z.string().email() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'referralCode and email required' });
    try {
      return await deps.loyalty.claimFriendCode(body.data.referralCode, body.data.email);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
