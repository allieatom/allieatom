import { describe, expect, it } from 'vitest';
import { ShopifyAdmin } from '../src/shopify/admin.js';
import { loadConfig } from '../src/config.js';

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (c: Call, n: number) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} }; calls.push(c);
    const r = handler(c, calls.length);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('ShopifyAdmin auth', () => {
  it('uses a static token as-is', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 200, body: { data: { shop: { name: 'BR' } } } }));
    const admin = new ShopifyAdmin('x.myshopify.com', 'shpat_static', '2026-01', f);
    await admin.graphql('{ shop { name } }');
    expect((calls[0]!.init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_static');
  });

  it('exchanges client credentials, caches for 24h, refreshes early and on 401', async () => {
    let now = 1_000_000; let tokenN = 0;
    const { f, calls } = fakeFetch((c) => {
      if (c.url.endsWith('/admin/oauth/access_token')) {
        const body = String(c.init.body);
        expect(body).toContain('grant_type=client_credentials'); expect(body).toContain('client_id=cid'); expect(body).toContain('client_secret=csec');
        return { status: 200, body: { access_token: `tok${++tokenN}`, expires_in: 86399, scope: 'read_orders' } };
      }
      const tok = (c.init.headers as Record<string, string>)['X-Shopify-Access-Token'];
      if (tok === 'tok2') return { status: 401, body: { errors: 'expired' } }; // force one refresh via 401
      return { status: 200, body: { data: { ok: tok } } };
    });
    const admin = new ShopifyAdmin('x.myshopify.com', { kind: 'client_credentials', clientId: 'cid', clientSecret: 'csec' }, '2026-01', f, () => now);
    expect(await admin.graphql<{ ok: string }>('{ x }')).toEqual({ ok: 'tok1' });
    expect(await admin.graphql<{ ok: string }>('{ x }')).toEqual({ ok: 'tok1' });     // cached
    expect(calls.filter((c) => c.url.includes('oauth')).length).toBe(1);
    now += (86399 - 200) * 1000;                                                        // inside the 5-minute refresh window
    const r = await admin.graphql<{ ok: string }>('{ x }');                             // gets tok2 -> 401 -> refresh -> tok3
    expect(r).toEqual({ ok: 'tok3' });
    expect(calls.filter((c) => c.url.includes('oauth')).length).toBe(3);
  });

  it('builds the discount mutation input Yotpo-style', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 200, body: { data: { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/1' }, userErrors: [] } } } }));
    const admin = new ShopifyAdmin('x.myshopify.com', 'shpat', '2026-01', f);
    await admin.createDiscountCode({ code: 'ABCD1234', title: 'ABCD1234', discountType: 'fixed_amount', value: 15, customerGid: 'gid://shopify/Customer/9', minSubtotalCents: 100, combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false }, usageLimit: 1 });
    const sent = JSON.parse(String(calls[0]!.init.body)) as { variables: { input: Record<string, unknown> } };
    expect(sent.variables.input).toMatchObject({ code: 'ABCD1234', usageLimit: 1, appliesOncePerCustomer: true, customerSelection: { customers: { add: ['gid://shopify/Customer/9'] } }, customerGets: { value: { discountAmount: { amount: '15.00', appliesOnEachItem: false } }, items: { all: true } }, minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: '1.00' } } });
  });
});

describe('loadConfig', () => {
  const base = { SHOPIFY_SHOP_DOMAIN: 'x.myshopify.com', ADMIN_API_TOKEN: 'abcdefghij', PUBLIC_BASE_URL: 'https://www.betterrhodes.com' };
  it('accepts Path A (static token + store webhook secret) with no proxy secret', () => {
    const c = loadConfig({ ...base, SHOPIFY_ADMIN_ACCESS_TOKEN: 'shpat_x', SHOPIFY_WEBHOOK_SECRET: 'whsec' });
    expect(c.shopify).toEqual({ auth: { kind: 'token', accessToken: 'shpat_x' }, webhookSecret: 'whsec', proxySecret: null });
  });
  it('accepts Path B (client credentials) and derives both secrets from the client secret', () => {
    const c = loadConfig({ ...base, SHOPIFY_CLIENT_ID: 'cid', SHOPIFY_CLIENT_SECRET: 'csec' });
    expect(c.shopify).toEqual({ auth: { kind: 'client_credentials', clientId: 'cid', clientSecret: 'csec' }, webhookSecret: 'csec', proxySecret: 'csec' });
  });
  it('rejects a config with no usable credentials', () => {
    expect(() => loadConfig({ ...base })).toThrow(/SHOPIFY_ADMIN_ACCESS_TOKEN/);
    expect(() => loadConfig({ ...base, SHOPIFY_ADMIN_ACCESS_TOKEN: 'shpat_x' })).toThrow(/WEBHOOK_SECRET/);
  });
});
