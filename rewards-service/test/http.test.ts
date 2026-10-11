import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/index.js';
import { buildApp } from '../src/app.js';
import { signAppProxyQuery } from '../src/shopify/hmac.js';
import { FakeShopifyAdmin, paidOrder } from './fakes.js';
import { testDb, testRules } from './helpers.js';

const secret = 'shpss_test'; let db: Db; let app: FastifyInstance;
beforeAll(async () => {
  db = await testDb();
  ({ app } = buildApp({ db, rules: testRules(), shopify: new FakeShopifyAdmin(), webhookSecret: secret, proxySecret: secret, adminToken: 'admintoken123', publicBaseUrl: 'https://www.betterrhodes.com', logLevel: 'silent' }));
  await app.ready();
});
afterAll(async () => { await app?.close(); await db?.close(); });

const webhook = (topic: string, payload: unknown, id: string, badHmac = false) => {
  const body = JSON.stringify(payload);
  const hmac = createHmac('sha256', badHmac ? 'wrong' : secret).update(body).digest('base64');
  return app.inject({ method: 'POST', url: '/webhooks/shopify', payload: body, headers: { 'content-type': 'application/json', 'x-shopify-topic': topic, 'x-shopify-hmac-sha256': hmac, 'x-shopify-webhook-id': id } });
};
const proxyQuery = (customerId?: string) => {
  const q: Record<string, string> = { shop: 'better-rhodes.myshopify.com', path_prefix: '/apps/rewards', timestamp: String(Math.floor(Date.now() / 1000)) };
  if (customerId) q['logged_in_customer_id'] = customerId;
  return new URLSearchParams({ ...q, signature: signAppProxyQuery(q, secret) }).toString();
};

describe('HTTP surface', () => {
  it('rejects webhooks with a bad HMAC', async () => {
    expect((await webhook('orders/paid', paidOrder(), 'wh-0', true)).statusCode).toBe(401);
  });
  it('processes orders/paid and dedupes by webhook id', async () => {
    expect((await webhook('orders/paid', paidOrder(), 'wh-1')).statusCode).toBe(200);
    const again = await webhook('orders/paid', paidOrder(), 'wh-1');
    expect(again.json()).toMatchObject({ duplicate: true });
  });
  it('serves the logged-in member state through the signed app proxy', async () => {
    const res = await app.inject({ method: 'GET', url: `/proxy/me?${proxyQuery('31277051641990')}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ authenticated: true, member: { pointsBalance: 106, tier: 'Bronze' } });
    expect(res.json().redemptionOptions.find((o: { key: string }) => o.key === 'off_5')).toMatchObject({ affordable: true });
  });
  it('serves the public program summary when logged out, and rejects bad signatures', async () => {
    const anon = await app.inject({ method: 'GET', url: `/proxy/me?${proxyQuery()}` });
    expect(anon.json()).toMatchObject({ authenticated: false });
    expect(anon.json().program.waysToRedeem).toHaveLength(4);
    const bad = await app.inject({ method: 'GET', url: '/proxy/me?shop=x&timestamp=1&signature=deadbeef' });
    expect(bad.statusCode).toBe(401);
  });
  it('redeems through the proxy', async () => {
    const res = await app.inject({ method: 'POST', url: `/proxy/redeem?${proxyQuery('31277051641990')}`, payload: { optionKey: 'off_5' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toMatch(/^[A-Z0-9]{8}$/);
    expect(res.json().state.member.pointsBalance).toBe(6);
  });
  it('guards the admin API with a bearer token', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/stats' })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url: '/admin/stats', headers: { authorization: 'Bearer admintoken123' } });
    expect(ok.json()).toMatchObject({ optedInMembers: 1 });
    const adj = await app.inject({ method: 'POST', url: '/admin/members/1/adjust', headers: { authorization: 'Bearer admintoken123' }, payload: { points: 50, reason: 'goodwill', actor: 'agatha' } });
    expect(adj.json()).toEqual({ balance: 56 });
  });
});
