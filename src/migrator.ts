import { type MigrationConfig, readMigrationFiles } from 'drizzle-orm/migrator';
import type { PgDialect, PgSession } from 'drizzle-orm/pg-core';
import type { PgjsDatabase } from './driver.js';

/**
 * `PgDatabase`'s two internal members this needs.
 *
 * `dialect` and `session` are constructor parameters marked
 * `/** @internal *\/`, so they exist at runtime and `stripInternal` takes
 * them out of the types - the same reason `drizzle-internals.ts` exists.
 * `migrate` itself is four lines in every driver drizzle ships, and this
 * is those four lines.
 */
interface PgDatabaseInternals {
  dialect: PgDialect & {
    migrate(
      migrations: unknown[],
      session: PgSession<any, any, any>,
      config: MigrationConfig,
    ): Promise<void>;
  };
  session: PgSession<any, any, any>;
}

/**
 * Runs the migration files drizzle-kit generated, through this driver.
 *
 * The same call `drizzle-orm/node-postgres/migrator` exposes, reading the
 * same journal: drizzle owns the table, the ordering and the hashing, and
 * a driver only carries the statements.
 *
 * ```ts
 * await migrate(db, { migrationsFolder: './drizzle' });
 * ```
 */
export async function migrate<TSchema extends Record<string, unknown>>(
  db: PgjsDatabase<TSchema>,
  config: MigrationConfig,
): Promise<void> {
  const migrations = readMigrationFiles(config);
  const internals = db as unknown as PgDatabaseInternals;
  await internals.dialect.migrate(migrations, internals.session, config);
}
