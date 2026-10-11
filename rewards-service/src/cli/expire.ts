import { createPgDb } from '../db/index.js';
import { Ledger } from '../domain/ledger.js';
import { loadRules } from '../domain/rules.js';
import { runExpiry } from '../domain/expiry.js';
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }
const rules = await loadRules(process.env.RULES_PATH ?? './config/rules.json');
const db = createPgDb(url);
const result = await runExpiry(db, new Ledger(db, { expiryMonths: rules.expiry.mode === 'inactivity' ? rules.expiry.months : null }), rules);
console.log(JSON.stringify(result));
await db.close();
