/**
 * What both the in-process timing run and the per-driver heap workers
 * measure - one definition, so the two cannot drift apart.
 */
import { sql } from 'drizzle-orm';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { Pool as PgPool } from 'pg';
import { Pool as PgjsPool } from 'postgrejs';
import { drizzle as drizzlePgjs } from '../build/index.js';

export const CONTROL = 'node-postgres';
export const DRIVER = 'postgrejs';

export const SCHEMA = 'bench_drizzle';
export const SEED_ROWS = 5000;

export const CONN = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'postgres',
  database: process.env.PGDATABASE ?? 'postgres',
};

export const DDL = [
  `create schema if not exists ${SCHEMA}`,
  `drop table if exists ${SCHEMA}.rows`,
  `create table ${SCHEMA}.rows (
     id serial primary key,
     name text not null,
     email text not null,
     age integer,
     balance numeric(14, 2),
     created timestamptz not null default now(),
     tags text[],
     meta jsonb,
     active boolean not null default true
   )`,
  `insert into ${SCHEMA}.rows (name, email, age, balance, tags, meta)
     select 'name ' || i, 'user' || i || '@example.com', (i % 80) + 18,
            (i % 100000)::numeric / 100, array['a', 'b', 'c'],
            jsonb_build_object('i', i, 'nested', jsonb_build_object('k', 'v'))
     from generate_series(1, ${SEED_ROWS}) as i`,
];

/** Each one is a single drizzle call, the way a caller would write it. */
export const SCENARIOS = [
  {
    name: 'point read',
    note: 'one row by primary key',
    iters: 50,
    pairs: 101,
    run: (db, i) =>
      db.execute(
        sql`select * from ${sql.raw(SCHEMA)}.rows where id = ${(i % SEED_ROWS) + 1}`,
      ),
  },
  {
    name: 'page of 200',
    note: 'nine columns, mixed types',
    iters: 20,
    pairs: 101,
    run: (db, i) =>
      db.execute(
        sql`select * from ${sql.raw(SCHEMA)}.rows order by id offset ${(i % 10) * 200} limit 200`,
      ),
  },
  {
    name: 'insert returning',
    note: 'six parameters',
    iters: 50,
    pairs: 101,
    run: (db, i) =>
      db.execute(
        sql`insert into ${sql.raw(SCHEMA)}.rows (name, email, age, balance, tags, meta)
            values (${'n' + i}, ${'e' + i + '@example.com'}, ${(i % 60) + 18},
                    ${'12.34'}, ${'{a,b}'}, ${'{"i":1}'})
            returning id`,
      ),
  },
  {
    name: 'concurrent reads',
    note: '20 point reads at once, pool of 10',
    iters: 4,
    pairs: 61,
    pooled: true,
    run: (db, i) =>
      Promise.all(
        Array.from({ length: 20 }, (_, k) =>
          db.execute(
            sql`select * from ${sql.raw(SCHEMA)}.rows where id = ${((i * 20 + k) % SEED_ROWS) + 1}`,
          ),
        ),
      ),
  },
  /**
   * The same 100k-element `int4[]` at three value widths, because the
   * width decides the answer and one row would be a choice dressed as a
   * measurement. PostgreJS reads the column in binary, which costs 8 bytes
   * an element whatever the value; `pg` reads it as text, which costs a
   * byte a digit. So an `int4` column holding single digits flatters the
   * text form, and one holding values that use the type flatters the
   * binary one - measured, 195 KB against 781 on the first and 1074
   * against 781 on the last. Neither is "the" int4 array, so all three run.
   */
  {
    name: 'int4[] of 100k, single digits',
    note: 'values 1-9, the width text is cheapest at',
    iters: 3,
    pairs: 41,
    run: db =>
      db.execute(
        sql`select array(select (i % 9) + 1 from generate_series(1, 100000) i) as v`,
      ),
  },
  {
    name: 'int4[] of 100k, mixed widths',
    note: 'values 1-100000',
    iters: 3,
    pairs: 41,
    run: db =>
      db.execute(sql`select array(select generate_series(1, 100000)) as v`),
  },
  {
    name: 'int4[] of 100k, full width',
    note: 'values that use the whole type',
    iters: 3,
    pairs: 41,
    run: db =>
      db.execute(
        sql`select array(select 2147383646 + i from generate_series(1, 100000) i) as v`,
      ),
  },
  {
    name: 'bytea of 4MB',
    note: 'one binary column',
    iters: 3,
    pairs: 41,
    run: db => db.execute(sql`select repeat('x', 4194304)::bytea as v`),
  },
];

/**
 * A drizzle instance per driver, and its pool, so a caller can close what
 * it opened. `max` is 1 except for the scenario that is about a pool.
 */
export function openDatabases(pooled = false) {
  const max = pooled ? 10 : 1;
  const pgPool = new PgPool({ ...CONN, max });
  const jsPool = new PgjsPool({ ...CONN, pool: { max } });
  return {
    dbs: {
      [CONTROL]: drizzleNodePg(pgPool, { logger: false }),
      [DRIVER]: drizzlePgjs(jsPool, { logger: false }),
    },
    async close() {
      await pgPool.end();
      await jsPool.close(true);
    },
  };
}

export const scenariosMatching = only =>
  SCENARIOS.filter(
    s => !only || only === 'all' || s.name.replaceAll(' ', '-').includes(only),
  );
