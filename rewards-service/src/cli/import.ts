import { parseArgs } from 'node:util';
import { createPgDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { loadRules } from '../domain/rules.js';
import { klaviyoRowToSnapshot, readKlaviyoCsv, readShopifyCustomersCsv } from '../import/klaviyo-csv.js';
import { applyAll } from '../import/snapshot.js';
import type { MemberSnapshot } from '../import/snapshot.js';

const { values } = parseArgs({ options: {
  klaviyo: { type: 'string' }, shopify: { type: 'string' }, snapshot: { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
} });
if (!values.klaviyo) { console.error('usage: npm run import -- --klaviyo profiles.csv [--shopify customers.csv] [--snapshot YYYY-MM-DD] [--dry-run]'); process.exit(1); }
const url = process.env.DATABASE_URL; if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }

const snapshotAt = values.snapshot ? new Date(`${values.snapshot}T00:00:00Z`) : new Date();
const rules = await loadRules(process.env.RULES_PATH ?? './config/rules.json');
const shopifyIds = values.shopify ? await readShopifyCustomersCsv(values.shopify) : new Map();
const rows = await readKlaviyoCsv(values.klaviyo);
const snaps = rows.map((r) => klaviyoRowToSnapshot(r, snapshotAt, shopifyIds)).filter((s): s is MemberSnapshot => s !== null);
console.log(`rows=${rows.length} loyalty members=${snaps.length} shopify ids matched=${snaps.filter((s) => s.shopifyCustomerId).length} dryRun=${values['dry-run']}`);

const db = createPgDb(url);
await migrate(db);
const report = await applyAll(db, rules, snaps, { dryRun: values['dry-run'] });
console.log(JSON.stringify({ ...report, warnings: report.warnings.slice(0, 50), errors: report.errors.slice(0, 50) }, null, 2));
await db.close();
