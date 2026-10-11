import { createHmac, timingSafeEqual } from 'node:crypto';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Webhook: X-Shopify-Hmac-Sha256 is base64(HMAC-SHA256(secret, raw body)). */
export function verifyWebhookHmac(rawBody: Buffer | string, headerValue: string | undefined, secret: string): boolean {
  if (!headerValue) return false;
  const digest = createHmac('sha256', secret).update(rawBody).digest('base64');
  return safeEqual(digest, headerValue);
}

/** App proxy: `signature` = hex(HMAC-SHA256(secret, sorted "key=value" pairs joined with no separator)). */
export function verifyAppProxySignature(query: Record<string, string | string[] | undefined>, secret: string): boolean {
  const signature = query['signature'];
  if (typeof signature !== 'string') return false;
  const message = Object.keys(query)
    .filter((k) => k !== 'signature')
    .sort()
    .map((k) => { const v = query[k]; return `${k}=${Array.isArray(v) ? v.join(',') : (v ?? '')}`; })
    .join('');
  const digest = createHmac('sha256', secret).update(message).digest('hex');
  return safeEqual(digest, signature);
}

/** Helper for tests and tooling: produce a valid app-proxy signature. */
export function signAppProxyQuery(query: Record<string, string | string[]>, secret: string): string {
  const message = Object.keys(query).sort().map((k) => { const v = query[k]!; return `${k}=${Array.isArray(v) ? v.join(',') : v}`; }).join('');
  return createHmac('sha256', secret).update(message).digest('hex');
}
