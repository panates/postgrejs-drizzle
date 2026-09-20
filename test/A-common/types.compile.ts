/**
 * Not a test - a compile-time one. `npm run compile` and the test project's
 * own type check both build this file, so the shapes the README shows have
 * to keep type-checking: every accepted `drizzle()` form, a handle declared
 * with `PgjsDrizzle`, the row types a select and a returning insert give
 * back, and what `db.execute()` resolves to.
 *
 * It is never run - mocha only collects `*.spec.ts`.
 */
import { eq, sql } from 'drizzle-orm';
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core';
import { Pool } from 'postgrejs';
import {
  drizzle,
  type PgjsDrizzle,
  type PgjsQueryResult,
} from '../../src/index.js';

const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  age: integer('age'),
});
const schema = { users };

// every accepted form
const a = drizzle('postgres://localhost:5432/mydb');
const b = drizzle({ connection: 'postgres://localhost:5432/mydb' });
const c = drizzle({
  connection: { host: 'localhost', port: 5432, database: 'mydb' },
});
// pg's spelling, which this package translates rather than ignores
const e = drizzle({
  connection: { connectionString: 'postgres://localhost:5432/mydb', max: 4 },
});
const d = drizzle(new Pool('postgres://localhost:5432/mydb'), { schema });

// typed handle
const typed: PgjsDrizzle<typeof schema> = d;

async function main() {
  const rows = await typed.select().from(users).where(eq(users.name, 'ada'));
  const name: string = rows[0]!.name;
  const age: number | null = rows[0]!.age;

  const inserted = await typed
    .insert(users)
    .values({ name: 'ada' })
    .returning();
  const id: number = inserted[0]!.id;

  const relational = await typed.query.users.findMany();
  const alsoName: string = relational[0]!.name;

  const raw: PgjsQueryResult = await typed.execute(sql`select 1 as a`);
  const command: string | undefined = raw.command;
  const tag: string | undefined = raw.commandTag;
  const count: number | null = raw.rowCount;

  await typed.transaction(async tx => {
    await tx.insert(users).values({ name: 'bob' });
  });

  await a.$client.close();
  await b.$client.close();
  await c.$client.close();
  await e.$client.close();
  await typed.$client.close();
  return { name, age, id, alsoName, command, tag, count };
}
void main;
