import { readFileSync } from 'node:fs';
import { createPgliteDb, type Db } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { parseRules, type Rules } from '../src/domain/rules.js';

export async function testDb(): Promise<Db> {
  const db = await createPgliteDb();
  await migrate(db);
  return db;
}
export function testRules(): Rules {
  return parseRules(JSON.parse(readFileSync(new URL('../config/rules.json', import.meta.url), 'utf8')));
}
