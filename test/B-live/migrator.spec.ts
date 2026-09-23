import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { expect } from 'expect';
import { migrate } from '../../src/index.js';
import { type LiveDb, openLiveDb } from '../_support/live.js';

/**
 * `migrate()` is drizzle's own migration runner reached through this
 * driver: drizzle owns the journal, the ordering, the hashing and the
 * `__drizzle_migrations` table, and the driver only carries the
 * statements. What is worth asserting here is therefore that the
 * statements arrive, that a second run is a no-op, and that the bookkeeping
 * drizzle does lands on the server.
 */
describe('live: migrate()', () => {
  let live: LiveDb;
  let folder: string;

  /** What drizzle-kit would have written, without running drizzle-kit. */
  const writeMigrations = (statements: string[]): string => {
    const root = mkdtempSync(join(tmpdir(), 'drizzle-pgjs-migrations-'));
    mkdirSync(join(root, 'meta'));
    const entries = statements.map((statement, index) => {
      const tag = `000${index}_case`;
      writeFileSync(join(root, `${tag}.sql`), statement);
      return {
        idx: index,
        version: '7',
        when: 1700000000000 + index,
        tag,
        breakpoints: true,
      };
    });
    writeFileSync(
      join(root, 'meta', '_journal.json'),
      JSON.stringify({ version: '7', dialect: 'postgresql', entries }),
    );
    return root;
  };

  before(async () => {
    live = await openLiveDb('drizzle_pgjs_migrator');
    folder = writeMigrations([
      `create table drizzle_pgjs_migrator.people (id serial primary key, name text not null)`,
      `alter table drizzle_pgjs_migrator.people add column age integer`,
    ]);
  });

  after(async () => {
    await live?.close();
  });

  it('runs the statements in the journal, in order', async () => {
    await migrate(live.db, {
      migrationsFolder: folder,
      migrationsSchema: 'drizzle_pgjs_migrator',
    });
    const columns = await live.db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns
          where table_schema = 'drizzle_pgjs_migrator' and table_name = 'people'
          order by ordinal_position`,
    );
    expect(columns.rows.map(row => row.column_name)).toStrictEqual([
      'id',
      'name',
      'age',
    ]);
  });

  it('does nothing the second time', async () => {
    await migrate(live.db, {
      migrationsFolder: folder,
      migrationsSchema: 'drizzle_pgjs_migrator',
    });
    const applied = await live.db.execute<{ n: number }>(
      sql`select count(*)::int as n from drizzle_pgjs_migrator."__drizzle_migrations"`,
    );
    expect(applied.rows[0]!.n).toStrictEqual(2);
  });
});
