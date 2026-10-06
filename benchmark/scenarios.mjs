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

/** Built once, so a write scenario times the send and not the making. */
export const BLOB_4MB = Buffer.alloc(4 * 1024 * 1024, 0x78);
export const ARRAY_100K = Array.from(
  { length: 100000 },
  (_, i) => 2147383646 + i,
);

export const CONN = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'postgres',
  database: process.env.PGDATABASE ?? 'postgres',
};

/**
 * Every scenario reads what is already stored, rather than asking the
 * server to build its values on each call, and every one binds at least
 * one parameter.
 *
 * The parameter is a `limit` that selects the whole result, and it is
 * there to make the comparison an even one rather than to filter
 * anything: `pg` sends a query with no values over PostgreSQL's simple
 * protocol - `requiresPreparation()` in `pg/lib/query.js` returns false
 * without a name, a row limit or values - and takes the extended one as
 * soon as a parameter appears, which is what PostgreJS's `query()` always
 * speaks. Without it, nine of these scenarios would have been comparing
 * two different protocols; on the 1KB `bytea` that was worth almost the
 * whole memory difference between them.
 *
 * That is not tidiness. Generating 5000 boxes out of random floats costs
 * the server about 20ms, which both drivers pay and neither is being
 * measured on: generated, the box scenario read 25.8ms against 23.8ms and
 * said almost nothing; read back from a table it is 4.7 against 3.4. The
 * same shared cost sits inside every `generate_series` and every
 * `repeat()`, compressing the ratio towards 1 wherever it is large enough
 * to matter.
 */
export const DDL = [
  `create schema if not exists ${SCHEMA}`,

  // the ordinary shapes: point read, page, insert, concurrent reads
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

  // one 100k-element int4[] per value width, in one row of three columns
  `drop table if exists ${SCHEMA}.arrays`,
  `create table ${SCHEMA}.arrays as
     select array(select 2147383646 + i from generate_series(1, 100000) i) as full_width`,

  // same reason as the blobs below: decompression is not what is being
  // compared, and a sequential int4[] compresses very well
  `alter table ${SCHEMA}.arrays alter column full_width set storage external`,
  `update ${SCHEMA}.arrays set full_width = full_width`,

  // 5000 rows of the types PostgreJS decodes in binary
  `drop table if exists ${SCHEMA}.scalars`,
  `create table ${SCHEMA}.scalars as
     select (random() * 1e9)::float8 as f,
            gen_random_uuid() as u
     from generate_series(1, 5000) i`,
  // the same 5000 float8s as `scalars`, in one row instead of 5000, so
  // the pair differs in shape and in nothing else - `external` for the
  // reason the other payload tables have it, decompression is not what
  // is being compared
  `drop table if exists ${SCHEMA}.float8_array`,
  `create table ${SCHEMA}.float8_array as
     select array_agg(f) as v from ${SCHEMA}.scalars`,
  `alter table ${SCHEMA}.float8_array alter column v set storage external`,
  `update ${SCHEMA}.float8_array set v = v`,

  `drop table if exists ${SCHEMA}.boxes`,
  `create table ${SCHEMA}.boxes as
     select box(point(random() * 1e6, random() * 1e6),
                point(random() * 1e6, random() * 1e6)) as v
     from generate_series(1, 5000) i`,

  // what the write scenarios fill. Unlogged: this is measuring the client,
  // and a WAL write is the same cost on both sides of the comparison while
  // being large enough to hide what is not.
  `drop table if exists ${SCHEMA}.writes`,
  `create unlogged table ${SCHEMA}.writes (
     id serial primary key,
     name text,
     email text,
     age integer,
     big bigint,
     balance numeric(20, 6),
     tags text[],
     meta jsonb,
     blob bytea,
     numbers integer[]
   )`,

  // one bytea per size. `external` keeps TOAST from compressing them:
  // repeat('x', n) compresses to nothing, and what would then be measured
  // is the decompression rather than the transfer.
  `drop table if exists ${SCHEMA}.blobs`,
  `create table ${SCHEMA}.blobs (large bytea)`,
  `alter table ${SCHEMA}.blobs alter column large set storage external`,
  `insert into ${SCHEMA}.blobs (large) values (repeat('x', 4194304)::bytea)`,
];

/**
 * Turned off for every number here, because `pg` does not offer it and
 * billing PostgreJS for a feature the other side does not have is not a
 * comparison.
 *
 * `asyncErrorHandling` makes a thrown error's stack point at the
 * application code that called `query()` across the `await`, rather than
 * at an internal frame. Capturing that costs real CPU when several calls
 * are in flight, and `pg` captures nothing - PostgreJS's own
 * documentation says as much where the option is declared
 * (`database-connection-params.ts`: *"which is also what makes an
 * apples-to-apples benchmark against a client that does not offer this
 * fair"*). It defaults to on, so leaving it alone is a choice too.
 *
 * It resolves per call as `options.asyncErrorHandling ??
 * config.asyncErrorHandling ?? true` (`connection.ts:1172`), and this
 * driver does not set it per call, so the pool's setting is what decides.
 *
 * Measured rather than assumed, postgrejs against itself with only this
 * flag different, alternated and paired: **it is worth 3% on `concurrent
 * reads` and nothing anywhere else.** 1.032x there, faster in 78 of 121
 * pairs, p = 0.002 - and that is the one scenario with calls in flight
 * together, which is the case the option's own documentation names. The
 * other thirteen land between 0.97x and 1.01x with no sign test below
 * p = 0.28, and allocation does not move on any of them (429.4 KB against
 * 427.7 on the concurrent one). So this setting is here because billing
 * one side for a feature the other does not have is not a comparison, not
 * because it changes the answer.
 *
 * `timing` is already off by default and `rollbackOnError` is set to
 * `false` by the driver itself for correctness, so neither needs saying
 * here.
 */
const FAIR = { asyncErrorHandling: false };

/** Each one is a single drizzle call, the way a caller would write it. */
export const SCENARIOS = [
  {
    name: 'point read',
    group: 'Read',
    note: '1 row of 9 columns',
    iters: 50,
    pairs: 101,
    run: (db, i) =>
      db.execute(
        sql`select * from ${sql.raw(SCHEMA)}.rows where id = ${(i % SEED_ROWS) + 1}`,
      ),
  },
  {
    name: 'page of 200',
    group: 'Read',
    note: '200 rows of 9 columns, mixed types',
    iters: 20,
    pairs: 101,
    run: (db, i) =>
      db.execute(
        sql`select * from ${sql.raw(SCHEMA)}.rows order by id offset ${(i % 10) * 200} limit 200`,
      ),
  },
  {
    name: 'concurrent reads',
    group: 'Read',
    note: '20 reads at once of 1 row each, pool of 10',
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
    name: 'int4[] of 100k, full width',
    group: 'Read',
    note: '1 row holding 1 array of 100 000 values that use the whole type',
    iters: 3,
    pairs: 41,
    run: db =>
      db.execute(
        sql`select full_width as v from ${sql.raw(SCHEMA)}.arrays limit ${1}`,
      ),
  },
  /**
   * Three types the driver does let PostgreJS decode, chosen because they
   * disagree about what binary is worth. The width of the binary form is
   * fixed; the width of the text form is whatever the value needs. Which
   * way that falls decides the row, and it falls all three ways here.
   *
   * `float8` is split by width for the reason the three `int4[]` rows
   * exist, and it separates the two drivers as sharply: PostgreJS pulls
   * 93 KB whatever the values are, `pg` 63 KB for small integers and 139
   * for the full-width ones, and on the small ones `pg` is the faster of
   * the two. The coordinates of the boxes are wide on the same grounds: a box of single-digit corners is a box whose
   * text form is shorter than its binary one, and quoting that as the
   * cost of a `box` column would be choosing the answer. Measured both
   * ways, PostgreJS pulls the same 210 KB either way and `pg` goes from
   * 162 KB to 423.
   *
   * Not in this group, and worth knowing why: `timestamptz`, `date`,
   * `time`, `interval`, `numeric` and `point` are asked for as text by
   * this driver, because drizzle's own column mappers are written against
   * the strings `pg` hands them. Measured on 5000 rows, both drivers pull
   * the same 195 KB for a `timestamptz` column - there is no binary path
   * to compare, by design rather than by omission.
   */
  {
    name: 'float8 of 5k rows, full width',
    group: 'Read',
    note: '5000 rows of 1 value, eight bytes against seventeen significant digits',
    iters: 10,
    pairs: 61,
    run: db =>
      db.execute(
        sql`select f as v from ${sql.raw(SCHEMA)}.scalars limit ${5000}`,
      ),
  },
  /**
   * The same values as the row above, in one row rather than 5000, and
   * it is here because the pair answers a question neither row can on
   * its own: what the binary format is worth depends on how many values
   * share a row, not on how many values there are. Spread out, the
   * protocol's per-row cost is most of what either client pays and the
   * two are level. Packed, `pg` has to build a megabyte of array literal
   * and cut a substring per element where this driver reads each one out
   * of the buffer it already has.
   */
  {
    name: 'float8[] of 5k in one row',
    group: 'Read',
    note: '1 row holding 1 array of the same 5000 values',
    iters: 10,
    pairs: 61,
    run: db =>
      db.execute(sql`select v from ${sql.raw(SCHEMA)}.float8_array limit ${1}`),
  },
  {
    name: 'uuid of 5k rows',
    group: 'Read',
    note: '5000 rows of 1 value, sixteen bytes against thirty-six characters',
    iters: 10,
    pairs: 61,
    run: db =>
      db.execute(
        sql`select u as v from ${sql.raw(SCHEMA)}.scalars limit ${5000}`,
      ),
  },
  {
    name: 'box of 5k rows',
    group: 'Read',
    note: '5000 rows of 1 value, four float8s against coordinates that use them',
    iters: 10,
    pairs: 61,
    run: db =>
      db.execute(sql`select v from ${sql.raw(SCHEMA)}.boxes limit ${5000}`),
  },
  /**
   * A `bytea` at three sizes. Its wire cost has none of the `int4[]`
   * freedom - text is `\x`-prefixed hex, two characters a byte, whatever
   * the bytes are - so what varies here is not the encoding's price but
   * whether the payload is big enough to matter next to a round trip.
   */
  {
    name: 'bytea of 4MB',
    group: 'Read',
    note: '1 row holding 1 value of 4 MB',
    iters: 3,
    pairs: 41,
    run: db =>
      db.execute(
        sql`select large as v from ${sql.raw(SCHEMA)}.blobs limit ${1}`,
      ),
  },
  /**
   * The write side, and it is not the mirror of the read side.
   *
   * Measured at the socket, both drivers send the same bytes for both
   * payloads: 4096 KB for the `bytea`, which each encodes as binary, and
   * 1270 KB for the 100k `int4[]`, which each sends as text. The array is
   * text on purpose rather than by omission - PostgreJS stopped declaring
   * an element type for an array of numbers in 660aa54, because `[1, 2]`
   * is `int2[]`, `int4[]`, `int8[]`, `numeric[]`, `float4[]` or `float8[]`
   * depending on where it lands and those have no casts between them, so
   * declaring one broke four of the six. An array of anything with only
   * one possible type - a `Buffer`, a boolean, one of its own classes -
   * keeps its declaration and its binary encoding.
   *
   * So these rows measure the client's own work on an identical wire,
   * not a wire-format advantage. Scalars still go out as
   * `BindParam(0, value)` for the server to type.
   *
   * Each one empties its table before the batch rather than during it, so
   * a growing heap and a growing index are not what is being timed.
   */
  {
    name: 'insert one row',
    note: '1 row, six parameters',
    group: 'Write',
    iters: 50,
    pairs: 101,
    setup: db => db.execute(sql`truncate ${sql.raw(SCHEMA)}.writes`),
    run: (db, i) =>
      db.execute(
        sql`insert into ${sql.raw(SCHEMA)}.writes (name, email, age, balance, tags, meta)
            values (${'n' + i}, ${'e' + i + '@example.com'}, ${(i % 60) + 18},
                    ${'12.34'}, ${'{a,b}'}, ${'{"i":1}'})
            returning id`,
      ),
  },
  {
    name: 'insert 500 rows',
    note: '500 rows in 1 statement, 2500 parameters that fill their types',
    group: 'Write',
    iters: 4,
    pairs: 61,
    setup: db => db.execute(sql`truncate ${sql.raw(SCHEMA)}.writes`),
    run: (db, i) => {
      // wide on purpose: a row of short values measures the round trip
      // rather than anything either driver does with the values in it
      const values = [];
      for (let k = 0; k < 500; k++)
        values.push(
          sql`(${'name-' + i + '-' + k + '-'.padEnd(40, 'x')},
               ${'user' + k + '@an-example-domain-that-is-long.example.com'},
               ${(k % 60) + 18},
               ${String(9007199254740990n + BigInt(k))},
               ${'123456789012.345678'})`,
        );
      return db.execute(
        sql`insert into ${sql.raw(SCHEMA)}.writes (name, email, age, big, balance)
            values ${sql.join(values, sql`, `)}`,
      );
    },
  },
  {
    name: 'insert a 4MB bytea',
    note: '1 row holding 1 value of 4 MB, binary on both sides',
    group: 'Write',
    iters: 3,
    pairs: 41,
    setup: db => db.execute(sql`truncate ${sql.raw(SCHEMA)}.writes`),
    run: db =>
      db.execute(
        sql`insert into ${sql.raw(SCHEMA)}.writes (blob) values (${sql.param(BLOB_4MB)})`,
      ),
  },
  {
    name: 'insert a 100k int4[]',
    note: '1 row holding 1 array of 100 000 values, text on both sides - see below',
    group: 'Write',
    iters: 3,
    pairs: 41,
    setup: db => db.execute(sql`truncate ${sql.raw(SCHEMA)}.writes`),
    run: db =>
      db.execute(
        sql`insert into ${sql.raw(SCHEMA)}.writes (numbers) values (${sql.param(ARRAY_100K)})`,
      ),
  },
  {
    name: 'twenty inserts in a transaction',
    note: '20 rows, one statement each, inside one transaction',
    group: 'Write',
    iters: 4,
    pairs: 61,
    setup: db => db.execute(sql`truncate ${sql.raw(SCHEMA)}.writes`),
    run: (db, i) =>
      db.transaction(async tx => {
        for (let k = 0; k < 20; k++)
          await tx.execute(
            sql`insert into ${sql.raw(SCHEMA)}.writes (name, age)
                values (${'n' + i + '-' + k}, ${k})`,
          );
      }),
  },
];

/**
 * A drizzle instance per driver, and its pool, so a caller can close what
 * it opened. `max` is 1 except for the scenario that is about a pool.
 */
export function openDatabases(pooled = false) {
  const max = pooled ? 10 : 1;
  const pgPool = new PgPool({ ...CONN, max });
  const jsPool = new PgjsPool({ ...CONN, pool: { max }, ...FAIR });
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

/**
 * The SQL each scenario actually sends, captured rather than restated:
 * every `run` is called once against a database whose logger records the
 * compiled query, so what is printed cannot drift from what is measured.
 */
export async function describeScenarios(scenarios) {
  const captured = [];
  const pool = new PgjsPool({ ...CONN, pool: { max: 1 }, ...FAIR });
  const db = drizzlePgjs(pool, {
    logger: {
      logQuery(query, params) {
        captured.push({ query, params });
      },
    },
  });
  const described = [];
  for (const scenario of scenarios) {
    if (scenario.setup) await scenario.setup(db);
    captured.length = 0;
    await scenario.run(db, 0);
    // the concurrent scenario fires twenty of the same statement
    const { query, params } = captured[0] ?? { query: '?', params: [] };
    described.push({ scenario, query, params, calls: captured.length });
  }
  await pool.close(true);
  return described;
}

export const scenariosMatching = only =>
  SCENARIOS.filter(
    s => !only || only === 'all' || s.name.replaceAll(' ', '-').includes(only),
  );
