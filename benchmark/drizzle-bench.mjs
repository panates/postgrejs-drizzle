/**
 * The same drizzle calls through this driver and through
 * `drizzle-orm/node-postgres`, on one server, in one process.
 *
 * The two are alternated inside every repeat and the order is swapped each
 * time, so an ordering artifact - a cold cache, a busy moment on the
 * machine - lands on both equally. What is reported is the median across
 * repeats, never a single run. Peak heap is the most `heapUsed` rose above
 * a forced-GC baseline while the batch ran, polled, so it needs
 * `--expose-gc` to mean anything.
 *
 *   node --expose-gc benchmark/drizzle-bench.mjs
 *   node --expose-gc benchmark/drizzle-bench.mjs --repeats=7 --scenario=page
 */
import { sql } from 'drizzle-orm';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { Pool as PgPool } from 'pg';
import { Pool as PgjsPool } from 'postgrejs';
import { drizzle as drizzlePgjs } from '../build/index.js';

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const REPEATS = Number(arg('repeats', 5));
const ONLY = arg('scenario', 'all');
const SCHEMA = 'bench_drizzle';
const SEED_ROWS = 5000;

const CONN = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'postgres',
  database: process.env.PGDATABASE ?? 'postgres',
};

const DDL = [
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
const SCENARIOS = [
  {
    name: 'point read',
    note: 'one row by primary key',
    iters: 300,
    run: (db, i) =>
      db.execute(
        sql`select * from ${sql.raw(SCHEMA)}.rows where id = ${(i % SEED_ROWS) + 1}`,
      ),
  },
  {
    name: 'page of 200',
    note: 'nine columns, mixed types',
    iters: 60,
    run: (db, i) =>
      db.execute(
        sql`select * from ${sql.raw(SCHEMA)}.rows order by id offset ${(i % 10) * 200} limit 200`,
      ),
  },
  {
    name: 'insert returning',
    note: 'six parameters',
    iters: 200,
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
    iters: 20,
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
  {
    name: 'int4[] of 100k',
    note: 'one array column',
    iters: 8,
    run: db =>
      db.execute(sql`select array(select generate_series(1, 100000)) as v`),
  },
  {
    name: 'bytea of 4MB',
    note: 'one binary column',
    iters: 8,
    run: db => db.execute(sql`select repeat('x', 4194304)::bytea as v`),
  },
];

/**
 * One timed batch. Nothing is sampled while it runs: polling
 * `process.memoryUsage()` inside the timed window costs more than the
 * calls being timed and lands unevenly on the two drivers - it is what
 * made an early revision of this file report a 2x that was its own.
 */
async function timedBatch(scenario, db) {
  const started = performance.now();
  for (let i = 0; i < scenario.iters; i++) await scenario.run(db, i);
  return (performance.now() - started) / scenario.iters;
}

/**
 * The most `heapUsed` rose above a forced-GC baseline while the same batch
 * ran, polled. Run on its own, never against the clock.
 */
async function heapBatch(scenario, db) {
  let peak = 0;
  globalThis.gc?.();
  const base = process.memoryUsage().heapUsed;
  const poll = setInterval(() => {
    const delta = process.memoryUsage().heapUsed - base;
    if (delta > peak) peak = delta;
  }, 5);
  for (let i = 0; i < scenario.iters; i++) await scenario.run(db, i);
  clearInterval(poll);
  return peak / 1024;
}

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function main() {
  const pgPool = new PgPool({ ...CONN, max: 1 });
  const jsPool = new PgjsPool({ ...CONN, pool: { max: 1 } });
  const pgPoolN = new PgPool({ ...CONN, max: 10 });
  const jsPoolN = new PgjsPool({ ...CONN, pool: { max: 10 } });
  const dbs = {
    'node-postgres': drizzleNodePg(pgPool, { logger: false }),
    'this driver': drizzlePgjs(jsPool, { logger: false }),
  };
  // the same two drivers over a pool of ten, for the concurrent scenario
  const pooled = {
    'node-postgres': drizzleNodePg(pgPoolN, { logger: false }),
    'this driver': drizzlePgjs(jsPoolN, { logger: false }),
  };
  const dbFor = (scenario, name) =>
    scenario.pooled ? pooled[name] : dbs[name];

  for (const statement of DDL) await pgPool.query(statement);

  const scenarios = SCENARIOS.filter(
    s => ONLY === 'all' || s.name.replaceAll(' ', '-').includes(ONLY),
  );
  const names = Object.keys(dbs);
  const results = [];

  for (const scenario of scenarios) {
    for (const name of names) {
      for (let i = 0; i < Math.min(scenario.iters, 30); i++)
        await scenario.run(dbFor(scenario, name), i);
    }
    const samples = { [names[0]]: [], [names[1]]: [] };
    const heaps = { [names[0]]: [], [names[1]]: [] };
    for (let rep = 0; rep < REPEATS; rep++) {
      // swap the order every repeat, so neither driver always runs first
      const order = rep % 2 ? [names[1], names[0]] : names;
      for (const name of order)
        samples[name].push(await timedBatch(scenario, dbFor(scenario, name)));
      for (const name of order)
        heaps[name].push(await heapBatch(scenario, dbFor(scenario, name)));
    }
    results.push({
      scenario,
      rows: names.map(name => ({
        name,
        ms: median(samples[name]),
        lo: Math.min(...samples[name]),
        hi: Math.max(...samples[name]),
        peakKb: median(heaps[name]),
      })),
    });
  }

  await pgPool.query(`drop schema ${SCHEMA} cascade`);
  await pgPool.end();
  await jsPool.close(true);
  await pgPoolN.end();
  await jsPoolN.close(true);

  console.log(
    `\nmedian of ${REPEATS} repeats, drivers alternated, order swapped each repeat`,
  );
  console.log(
    `node ${process.version}, postgrejs ${(await import('postgrejs/package.json', { with: { type: 'json' } })).default.version}, pg ${(await import('pg/package.json', { with: { type: 'json' } })).default.version}\n`,
  );
  for (const { scenario, rows } of results) {
    console.log(
      `${scenario.name} - ${scenario.note} (${scenario.iters} calls per batch)`,
    );
    const slowest = Math.max(...rows.map(r => r.ms));
    for (const r of rows)
      console.log(
        `  ${r.name.padEnd(15)} ${r.ms.toFixed(3).padStart(9)} ms/op  ` +
          `${(slowest / r.ms).toFixed(2)}x  ` +
          `spread ${r.lo.toFixed(3)}-${r.hi.toFixed(3)}  ` +
          `peak heap ${r.peakKb.toFixed(0).padStart(7)} KB`,
      );
    // a gap smaller than the wider driver's own run-to-run spread is not a
    // result; say so here rather than let a reader read one off the medians
    const spread = Math.max(...rows.map(r => r.hi - r.lo));
    if (Math.abs(rows[0].ms - rows[1].ms) < spread)
      console.log("  -> level: the gap is inside one driver's own spread");
    console.log();
  }
}

await main();
