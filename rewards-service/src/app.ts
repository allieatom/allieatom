import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { Db } from './db/index.js';
import type { Rules } from './domain/rules.js';
import { LoyaltyService } from './services/loyalty.js';
import type { ShopifyAdminApi } from './shopify/admin.js';
import { webhookRoutes } from './http/webhooks.js';
import { proxyRoutes } from './http/proxy.js';
import { adminRoutes } from './http/admin.js';

export interface AppDeps { db: Db; rules: Rules; shopify: ShopifyAdminApi; webhookSecret: string; proxySecret: string | null; adminToken: string; publicBaseUrl: string; logLevel?: string; now?: () => Date }

export function buildApp(deps: AppDeps): { app: FastifyInstance; loyalty: LoyaltyService } {
  const app = Fastify({ logger: { level: deps.logLevel ?? 'info' } });
  const loyalty = new LoyaltyService({ db: deps.db, rules: deps.rules, shopify: deps.shopify, publicBaseUrl: deps.publicBaseUrl, now: deps.now });
  app.register(cors, { origin: false });
  app.get('/healthz', async () => ({ ok: true }));
  app.register(async (i) => webhookRoutes(i, { db: deps.db, loyalty, shopifySecret: deps.webhookSecret }));
  app.register(async (i) => proxyRoutes(i, { loyalty, shopifySecret: deps.proxySecret }));
  app.register(async (i) => adminRoutes(i, { db: deps.db, loyalty, rules: deps.rules, token: deps.adminToken, shopify: deps.shopify }));
  return { app, loyalty };
}
