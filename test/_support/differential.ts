import { sql } from 'drizzle-orm';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { Pool as PgPool } from 'pg';
import { Pool } from 'postgrejs';
import { drizzle } from '../../src/index.js';

/**
 * The same drizzle calls, run through `drizzle-orm/node-postgres` and
 * through this driver, on the same server.
 *
 * The upstream suite is the broader instrument, but it asserts only what
 * its authors thought to write down - it passed while `db.execute()`
 * reported `rowCount: null` for a SELECT where `pg` reports the row count,
 * because nothing there reads it. This compares the values themselves, so
 * a difference has to be deliberate to survive.
 *
 * Both drivers work in the same schema, one after the other, with the
 * schema rebuilt in between: same starting state, same statements, and one
 * set of table definitions rather than two.
 */
export interface Differential {
  /** Runs `fn` against each driver and hands back both answers. */
  bothWays<T>(fn: (db: any) => Promise<T>): Promise<{ pg: T; pgjs: T }>;
  /** DDL every run starts from. */
  setSchema(statements: string[]): void;
  close(): Promise<void>;
}

/** What of a `db.execute()` result is a compatibility surface at all. */
export function comparableResult(result: any): unknown {
  if (Array.isArray(result))
    return result.map(entry => comparableResult(entry));
  return {
    command: result.command,
    rowCount: result.rowCount,
    rows: result.rows,
  };
}

export async function openDifferential(
  schemaName: string,
  /** drizzle's relational schema, when the cases use `db.query`. */
  drizzleSchema?: Record<string, unknown>,
): Promise<Differential> {
  const pgPool = new PgPool({ max: 4 });
  const jsPool = new Pool({ max: 4 });
  const config = { logger: false as const, schema: drizzleSchema };
  const dbs = {
    pg: drizzleNodePg(pgPool, config as any),
    pgjs: drizzle(jsPool, config as any),
  };
  let ddl: string[] = [];
  const schema = sql.identifier(schemaName);

  async function reset(db: any): Promise<void> {
    await db.execute(sql`drop schema if exists ${schema} cascade`);
    await db.execute(sql`create schema ${schema}`);
    for (const statement of ddl) await db.execute(sql.raw(statement));
  }

  return {
    setSchema(statements) {
      ddl = statements;
    },
    async bothWays(fn) {
      await reset(dbs.pg);
      const fromPg = await fn(dbs.pg);
      await reset(dbs.pgjs);
      const fromPgjs = await fn(dbs.pgjs);
      return { pg: fromPg, pgjs: fromPgjs };
    },
    async close() {
      await dbs.pg.execute(sql`drop schema if exists ${schema} cascade`);
      await pgPool.end();
      await jsPool.close();
    },
  };
}
