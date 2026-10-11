import pg from 'pg';

export interface QueryResult<T> { rows: T[]; rowCount: number }
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Run a multi-statement SQL script (migrations). No parameters. */
  exec(text: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class PgDb implements Db {
  constructor(private readonly runner: pg.Pool | pg.PoolClient, private readonly pool?: pg.Pool) {}
  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const r = await this.runner.query(text, params);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length };
  }
  async exec(text: string): Promise<void> { await this.runner.query(text); }
  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (!this.pool) return fn(this); // already inside a transaction: reuse client
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await fn(new PgDb(client));
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  async close(): Promise<void> { await this.pool?.end(); }
}

export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return new PgDb(pool, pool);
}

/** In-process Postgres (WASM) for tests and local experiments. */
export async function createPgliteDb(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = new PGlite();
  await lite.waitReady;
  type Q = { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>; exec(sql: string): Promise<unknown> };
  const wrap = (q: Q, inTx: boolean): Db => ({
    async query<T>(text: string, params: unknown[] = []) {
      const r = await q.query<T>(text, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
    async exec(text: string) { await q.exec(text); },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      if (inTx) return fn(wrap(q, true));
      return lite.transaction(async (tx) => fn(wrap(tx as unknown as Q, true)));
    },
    async close() { await lite.close(); },
  });
  return wrap(lite as unknown as Q, false);
}
