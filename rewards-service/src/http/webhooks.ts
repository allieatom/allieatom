import type { FastifyInstance } from 'fastify';
import { verifyWebhookHmac } from '../shopify/hmac.js';
import { toEarnableOrder, type ShopifyCustomerPayload, type ShopifyOrderPayload, type ShopifyRefundPayload } from '../shopify/orders.js';
import type { LoyaltyService } from '../services/loyalty.js';
import type { Db } from '../db/index.js';

export interface WebhookDeps { db: Db; loyalty: LoyaltyService; shopifySecret: string }

export async function webhookRoutes(app: FastifyInstance, deps: WebhookDeps): Promise<void> {
  // Raw body is required for HMAC verification; scoped to this plugin.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/webhooks/shopify', async (req, reply) => {
    const raw = req.body as Buffer;
    const hmac = req.headers['x-shopify-hmac-sha256'] as string | undefined;
    if (!verifyWebhookHmac(raw, hmac, deps.shopifySecret)) return reply.code(401).send({ error: 'invalid hmac' });
    const topic = String(req.headers['x-shopify-topic'] ?? '');
    const webhookId = String(req.headers['x-shopify-webhook-id'] ?? '');
    if (webhookId) {
      const dup = await deps.db.query('select 1 from processed_webhooks where webhook_id = $1', [webhookId]);
      if (dup.rows.length) return reply.code(200).send({ ok: true, duplicate: true });
    }
    let payload: unknown;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return reply.code(400).send({ error: 'invalid json' }); }

    try {
      switch (topic) {
        case 'orders/paid': {
          const o = payload as ShopifyOrderPayload;
          await deps.loyalty.handlePaidOrder(o, toEarnableOrder(o));
          break;
        }
        case 'orders/cancelled': await deps.loyalty.handleCancelledOrder(payload as ShopifyOrderPayload); break;
        case 'refunds/create': await deps.loyalty.handleRefund(payload as ShopifyRefundPayload); break;
        case 'customers/create':
        case 'customers/update': await deps.loyalty.handleCustomerUpsert(payload as ShopifyCustomerPayload); break;
        case 'customers/delete':
        case 'customers/redact': {
          const id = (payload as { id?: number; customer?: { id?: number } }).customer?.id ?? (payload as { id?: number }).id;
          if (id) await deps.loyalty.anonymizeCustomer(id);
          break;
        }
        case 'customers/data_request':
        case 'shop/redact':
          await deps.db.query(`insert into audit_log (actor, action, details) values ('shopify', $1, $2)`, [topic, JSON.stringify(payload)]);
          break;
        default:
          req.log.info({ topic }, 'unhandled webhook topic');
      }
      if (webhookId) await deps.db.query('insert into processed_webhooks (webhook_id, topic) values ($1, $2) on conflict do nothing', [webhookId, topic]);
      return reply.code(200).send({ ok: true });
    } catch (err) {
      req.log.error({ err, topic }, 'webhook processing failed');
      return reply.code(500).send({ error: 'processing failed' }); // Shopify retries on 5xx
    }
  });
}
