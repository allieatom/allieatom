import { createPgDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }
const db = createPgDb(url);
const ran = await migrate(db);
console.log(ran.length ? `applied: ${ran.join(', ')}` : 'up to date');
await db.close();
