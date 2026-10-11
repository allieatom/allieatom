import { loadConfig } from '../config.js';
import { createPgDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { loadRules } from '../domain/rules.js';
import { ShopifyAdmin } from '../shopify/admin.js';
import { LoyaltyService } from '../services/loyalty.js';
import { LiveSender, processOutbox } from '../klaviyo/outbox.js';

const config = loadConfig();
if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required');
const db = createPgDb(config.DATABASE_URL);
await migrate(db);
const rules = await loadRules(config.RULES_PATH);
const shopify = new ShopifyAdmin(config.SHOPIFY_SHOP_DOMAIN, config.shopify.auth, config.SHOPIFY_API_VERSION);
const loyalty = new LoyaltyService({ db, rules, shopify, publicBaseUrl: config.PUBLIC_BASE_URL });
const result = await loyalty.runDaily();
const delivered = await processOutbox(db, new LiveSender({ klaviyoApiKey: config.KLAVIYO_PRIVATE_API_KEY, klaviyoEnabled: config.KLAVIYO_EMIT_ENABLED, shopifyEnabled: config.SHOPIFY_SYNC_ENABLED, shopify }), 1000);
console.log(JSON.stringify({ ...result, delivered }));
await db.close();
