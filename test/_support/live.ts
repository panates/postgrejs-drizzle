import { sql } from 'drizzle-orm';
import { Pool } from 'postgrejs';
import { drizzle, type PgjsDrizzleConfig } from '../../src/index.js';

/**
 * A database on the server `test/_support/env.ts` points at, with a schema
 * of its own.
 *
 * The schema matters: drizzle qualifies a `pgSchema` table in the SQL it
 * writes, so nothing here depends on `search_path` - which a pool could
 * not carry anyway, since it hands out a different connection per call.
 */
export interface LiveDb {
  db: ReturnType<typeof drizzle>;
  pool: Pool;
  close(): Promise<void>;
}

export async function openLiveDb(
  schemaName: string,
  config: PgjsDrizzleConfig = {},
): Promise<LiveDb> {
  const pool = new Pool({ max: 4 });
  const db = drizzle(pool, { logger: false, ...config });
  const schema = sql.identifier(schemaName);
  await db.execute(sql`drop schema if exists ${schema} cascade`);
  await db.execute(sql`create schema ${schema}`);
  return {
    db,
    pool,
    async close() {
      await db.execute(sql`drop schema if exists ${schema} cascade`);
      await pool.close();
    },
  };
}
