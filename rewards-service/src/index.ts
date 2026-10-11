import { loadConfig } from './config.js';
import { createPgDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { loadRules } from './domain/rules.js';
import { ShopifyAdmin } from './shopify/admin.js';
import { buildApp } from './app.js';
import { LiveSender, processOutbox } from './klaviyo/outbox.js';

const config = loadConfig();
if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required');
const db = createPgDb(config.DATABASE_URL);
await migrate(db);
const rules = await loadRules(config.RULES_PATH);
const shopify = new ShopifyAdmin(config.SHOPIFY_SHOP_DOMAIN, config.shopify.auth, config.SHOPIFY_API_VERSION);
const { app } = buildApp({ db, rules, shopify, webhookSecret: config.shopify.webhookSecret, proxySecret: config.shopify.proxySecret, adminToken: config.ADMIN_API_TOKEN, publicBaseUrl: config.PUBLIC_BASE_URL, logLevel: config.LOG_LEVEL });

const sender = new LiveSender({ klaviyoApiKey: config.KLAVIYO_PRIVATE_API_KEY, klaviyoEnabled: config.KLAVIYO_EMIT_ENABLED, shopifyEnabled: config.SHOPIFY_SYNC_ENABLED, shopify });
const outboxTimer = setInterval(() => { processOutbox(db, sender).catch((err) => app.log.error({ err }, 'outbox failed')); }, 5000);

await app.listen({ port: config.PORT, host: '0.0.0.0' });
app.log.info({ klaviyoEmit: config.KLAVIYO_EMIT_ENABLED, shopifySync: config.SHOPIFY_SYNC_ENABLED }, 'rewards-service started');

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, async () => { clearInterval(outboxTimer); await app.close(); await db.close(); process.exit(0); });
