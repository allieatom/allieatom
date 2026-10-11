import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signAppProxyQuery, verifyAppProxySignature, verifyWebhookHmac } from '../src/shopify/hmac.js';

describe('Shopify signatures', () => {
  const secret = 'shpss_test_secret';
  it('verifies webhook HMAC (base64 of raw body)', () => {
    const body = Buffer.from('{"id":1}');
    const good = createHmac('sha256', secret).update(body).digest('base64');
    expect(verifyWebhookHmac(body, good, secret)).toBe(true);
    expect(verifyWebhookHmac(body, good.replace(/.$/, 'x'), secret)).toBe(false);
    expect(verifyWebhookHmac(body, undefined, secret)).toBe(false);
  });
  it('verifies app proxy signature (sorted key=value pairs, hex)', () => {
    const q = { shop: 'better-rhodes.myshopify.com', path_prefix: '/apps/rewards', timestamp: '1760200000', logged_in_customer_id: '6401308557446', extra: ['a', 'b'] };
    const signature = signAppProxyQuery(q, secret);
    expect(verifyAppProxySignature({ ...q, signature }, secret)).toBe(true);
    expect(verifyAppProxySignature({ ...q, logged_in_customer_id: '1', signature }, secret)).toBe(false);
    expect(verifyAppProxySignature({ ...q }, secret)).toBe(false);
  });
});
