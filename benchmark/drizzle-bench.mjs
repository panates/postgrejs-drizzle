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
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Pool as PgPool } from 'pg';
import {
  CONN,
  CONTROL,
  DDL,
  describeScenarios,
  DRIVER,
  openDatabases,
  scenariosMatching,
  SCHEMA,
} from './scenarios.mjs';

const run = promisify(execFile);
const HEAP_WORKER = new URL('./heap-worker.mjs', import.meta.url).pathname;

const RESULTS_FILE = new URL('./results/latest.json', import.meta.url);

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const PAIRS = Number(arg('pairs', 0)); // 0: each scenario's own
const HEAP_PAIRS = Number(arg('heap-pairs', 15));
const SUSTAINED_PAIRS = Number(arg('sustained-pairs', 3));
const ONLY = arg('scenario', 'all');
/**
 * One timed batch. Nothing is sampled while it runs: polling
 * `process.memoryUsage()` inside the timed window costs more than the
 * calls being timed and lands unevenly on the two drivers - it is what
 * made an early revision of this file report a 2x that was its own.
 */
async function timedBatch(scenario, db) {
  // outside the clock on purpose: emptying the target is not the work
  if (scenario.setup) await scenario.setup(db);
  const started = performance.now();
  for (let i = 0; i < scenario.iters; i++) await scenario.run(db, i);
  return (performance.now() - started) / scenario.iters;
}

/**
 * Peak heap for one driver, measured in a process of its own.
 *
 * In-process measurement cannot see what a client allocates once and
 * keeps, because the baseline is taken with both of them already up. A
 * child per driver - which is how postgrejs's own suite does it - puts
 * the whole cost inside the window.
 */
async function heapInChild(scenario, driver) {
  const { stdout } = await run(
    process.execPath,
    ['--expose-gc', HEAP_WORKER, driver, scenario.name],
    { env: process.env },
  );
  const { heldKb, perCallKb, peakKb, wireKb, wireOutKb, iterations } =
    JSON.parse(stdout);
  return { heldKb, perCallKb, peakKb, wireKb, wireOutKb, iterations };
}

/**
 * What the same client still holds once the calls stop. One run per
 * driver per scenario rather than one per pair: it is a wall-clock wait,
 * and unlike the peak it does not move between pairs.
 */
async function idleHeapInChild(scenario, driver) {
  const { stdout } = await run(
    process.execPath,
    ['--expose-gc', HEAP_WORKER, driver, scenario.name, 'idle'],
    { env: process.env },
  );
  const { idleHeldKb } = JSON.parse(stdout);
  return idleHeldKb;
}

/**
 * The high-water mark of a run with nothing collected inside it - what
 * the process has to be able to hold while the calls keep coming, which
 * is a different question from what one call adds to a clean heap and
 * answers it differently. Paired and alternated like the timings, three
 * repetitions, median: fewer than the timings because the splits it
 * produces are 9-0 rather than close.
 */
async function sustainedInChild(scenario, driver) {
  const { stdout } = await run(
    process.execPath,
    [
      '--expose-gc',
      '--trace-gc',
      HEAP_WORKER,
      driver,
      scenario.name,
      'sustained',
    ],
    { env: process.env, maxBuffer: 64 * 1024 * 1024 },
  );
  const measured = JSON.parse(
    stdout.split('\n').find(line => line.startsWith('{')),
  );
  return { ...measured, reclaimedKb: reclaimedBetweenMarks(stdout) };
}

/**
 * What every collection handed back while the measured calls were running,
 * added up, from `--trace-gc`'s `before (capacity) -> after (capacity) MB`.
 *
 * This is the column the divided high-water was trying to be and could
 * not: a high-water is where the runtime chose to collect, so it is not
 * additive and two clients can swap places on it without either
 * allocating differently. This one repeats to two decimals across runs.
 */
function reclaimedBetweenMarks(stdout) {
  const mark = Number(/MARK (\d+)/.exec(stdout)?.[1]);
  const end = Number(/END (\d+)/.exec(stdout)?.[1]);
  if (!Number.isFinite(mark) || !Number.isFinite(end)) return 0;
  const line =
    /^\[\d+:0x[0-9a-f]+\]\s+(\d+) ms: \S+.*?([\d.]+) \([\d.]+\) -> ([\d.]+) \(/;
  let total = 0;
  for (const text of stdout.split('\n')) {
    const found = line.exec(text);
    if (!found) continue;
    const at = Number(found[1]);
    if (at >= mark && at <= end) total += Number(found[2]) - Number(found[3]);
  }
  return total * 1024;
}

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Two-sided probability of a split at least this lopsided from a fair
 * coin. Only which driver won each pair counts, and by how much is thrown
 * away - which is exactly what lets it survive a machine whose absolute
 * numbers drift between runs.
 */
function signTest(wins, n) {
  const logFactorial = [0];
  for (let i = 1; i <= n; i++)
    logFactorial[i] = logFactorial[i - 1] + Math.log(i);
  const logChoose = k =>
    logFactorial[n] - logFactorial[k] - logFactorial[n - k];
  const extreme = Math.min(wins, n - wins);
  let tail = 0;
  for (let k = 0; k <= extreme; k++)
    tail += Math.exp(logChoose(k) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

/** '< 1 in 10^12', or 'even' when the split says nothing. */
function odds(p) {
  if (p >= 0.05) return 'not distinguishable';
  const exponent = Math.floor(-Math.log10(p));
  return exponent >= 3 ? `< 1 in 10^${exponent}` : `p = ${p.toFixed(3)}`;
}

async function main() {
  const { dbs, close } = openDatabases(false);
  const { dbs: pooled, close: closePooled } = openDatabases(true);
  const dbFor = (scenario, name) =>
    scenario.pooled ? pooled[name] : dbs[name];

  const pgPool = new PgPool({ ...CONN, max: 1 });
  for (const statement of DDL) await pgPool.query(statement);

  const scenarios = scenariosMatching(ONLY);
  const names = [CONTROL, DRIVER];
  const results = [];

  // what is about to be measured, in the SQL each scenario really sends -
  // shortened, because one of them carries 1500 placeholders and another
  // 100000 parameters
  const shorten = (text, limit = 150) => {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > limit
      ? `${oneLine.slice(0, limit)} … (${oneLine.length} chars)`
      : oneLine;
  };
  const describeParams = params => {
    if (!params.length) return '';
    const shown = params
      .slice(0, 4)
      .map(p =>
        Array.isArray(p)
          ? `array[${p.length}]`
          : Buffer.isBuffer(p)
            ? `buffer[${p.length}]`
            : JSON.stringify(p),
      )
      .join(', ');
    return `    ${params.length} param${params.length > 1 ? 's' : ''}: ${shown}${params.length > 4 ? ', …' : ''}`;
  };

  console.log('\nscenarios');
  let group;
  for (const { scenario, query, params, calls } of await describeScenarios(
    scenarios,
  )) {
    if (scenario.group !== group) {
      group = scenario.group;
      console.log(`\n  ${group ?? 'Other'}`);
    }
    console.log(`\n    ${scenario.name} - ${scenario.note}`);
    console.log(
      `      ${scenario.iters} calls per timed unit, ${scenario.pairs} pairs` +
        (calls > 1 ? `, ${calls} statements a call` : ''),
    );
    console.log(`      ${shorten(query)}`);
    const described = describeParams(params);
    if (described) console.log(`  ${described}`);
  }

  for (const scenario of scenarios) {
    const pairs = PAIRS || scenario.pairs;
    for (const name of names) {
      if (scenario.setup) await scenario.setup(dbFor(scenario, name));
      for (let i = 0; i < Math.min(scenario.iters * 4, 60); i++)
        await scenario.run(dbFor(scenario, name), i);
    }
    const samples = { [names[0]]: [], [names[1]]: [] };
    let wins = 0;
    for (let pair = 0; pair < pairs; pair++) {
      // swap the order every pair, so neither driver always runs first
      const order = pair % 2 ? [names[1], names[0]] : names;
      const timed = {};
      for (const name of order)
        timed[name] = await timedBatch(scenario, dbFor(scenario, name));
      for (const name of names) samples[name].push(timed[name]);
      if (timed[names[1]] < timed[names[0]]) wins++;
    }

    // and the memory, one child process per driver per pair
    const churn = { [names[0]]: [], [names[1]]: [] };
    const held = { [names[0]]: [], [names[1]]: [] };
    const peaks = { [names[0]]: [], [names[1]]: [] };
    const wire = { [names[0]]: [], [names[1]]: [] };
    const wireOut = { [names[0]]: [], [names[1]]: [] };
    let memoryCalls = 0;
    let heapWins = 0;
    for (let pair = 0; pair < HEAP_PAIRS; pair++) {
      const order = pair % 2 ? [names[1], names[0]] : names;
      const measured = {};
      for (const name of order)
        measured[name] = await heapInChild(scenario, name);
      for (const name of names) {
        churn[name].push(measured[name].perCallKb);
        held[name].push(measured[name].heldKb);
        peaks[name].push(measured[name].peakKb);
        wire[name].push(measured[name].wireKb);
        wireOut[name].push(measured[name].wireOutKb);
        memoryCalls = measured[name].iterations;
      }
      // on the peak, because that is the number the report's column shows
      if (measured[names[1]].peakKb < measured[names[0]].peakKb) heapWins++;
    }

    const idleHeld = {};
    for (const name of names)
      idleHeld[name] = await idleHeapInChild(scenario, name);

    const sustained = { [names[0]]: [], [names[1]]: [] };
    const sustainedRss = { [names[0]]: [], [names[1]]: [] };
    const reclaimed = { [names[0]]: [], [names[1]]: [] };
    let sustainedCalls = 0;
    let sustainedWins = 0;
    for (let pair = 0; pair < SUSTAINED_PAIRS; pair++) {
      const order = pair % 2 ? [names[1], names[0]] : names;
      const measured = {};
      for (const name of order)
        measured[name] = await sustainedInChild(scenario, name);
      for (const name of names) {
        sustained[name].push(measured[name].sustainedKb);
        sustainedRss[name].push(measured[name].sustainedRssKb);
        reclaimed[name].push(
          measured[name].reclaimedKb / measured[name].iterations,
        );
        sustainedCalls = measured[name].iterations;
      }
      if (measured[names[1]].sustainedKb < measured[names[0]].sustainedKb)
        sustainedWins++;
    }

    results.push({
      scenario,
      pairs,
      wins,
      p: signTest(wins, pairs),
      heapPairs: HEAP_PAIRS,
      memoryCalls,
      sustainedPairs: SUSTAINED_PAIRS,
      sustainedCalls,
      sustainedWins,
      heapWins,
      heapP: signTest(heapWins, HEAP_PAIRS),
      rows: names.map(name => ({
        name,
        ms: median(samples[name]),
        lo: Math.min(...samples[name]),
        hi: Math.max(...samples[name]),
        perCallKb: median(churn[name]),
        perCallLoKb: Math.min(...churn[name]),
        perCallHiKb: Math.max(...churn[name]),
        heldKb: median(held[name]),
        idleHeldKb: idleHeld[name],
        sustainedKb: median(sustained[name]),
        sustainedRssKb: median(sustainedRss[name]),
        reclaimedKb: median(reclaimed[name]),
        peakKb: median(peaks[name]),
        wireKb: median(wire[name]),
        wireOutKb: median(wireOut[name]),
      })),
    });
  }

  await close();
  await closePooled();

  await pgPool.query(`drop schema ${SCHEMA} cascade`);
  await pgPool.end();

  // read off disk rather than imported: drizzle-orm's `exports` map does
  // not expose its own package.json, and an import of it throws
  const versionOf = async name =>
    JSON.parse(
      await readFile(
        new URL(`../node_modules/${name}/package.json`, import.meta.url),
        'utf8',
      ),
    ).version;
  const versions = {
    node: process.version,
    postgrejs: await versionOf('postgrejs'),
    pg: await versionOf('pg'),
    drizzle: await versionOf('drizzle-orm'),
  };

  // the run's own record, so `npm run bench:report` can render it without
  // running anything - and so nothing has to be copied by hand
  await mkdir(new URL('.', RESULTS_FILE), { recursive: true });
  await writeFile(
    RESULTS_FILE,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        versions,
        scenarios: results.map(
          ({
            scenario,
            pairs,
            wins,
            p,
            heapPairs,
            memoryCalls,
            heapWins,
            heapP,
            sustainedPairs,
            sustainedCalls,
            sustainedWins,
            rows,
          }) => ({
            name: scenario.name,
            note: scenario.note,
            group: scenario.group,
            iters: scenario.iters,
            pairs,
            wins,
            p,
            heapPairs,
            memoryCalls,
            heapWins,
            heapP,
            sustainedPairs,
            sustainedCalls,
            sustainedWins,
            rows,
          }),
        ),
      },
      null,
      2,
    ) + '\n',
  );

  console.log(
    `\nmedian per call, drivers alternated within every pair, order swapped each pair`,
  );
  console.log(
    `node ${versions.node}, postgrejs ${versions.postgrejs}, pg ${versions.pg}\n`,
  );
  for (const {
    scenario,
    rows,
    pairs,
    wins,
    p,
    heapPairs,
    heapWins,
    heapP,
  } of results) {
    console.log(
      `${scenario.name} - ${scenario.note} (${scenario.iters} calls per timed unit, ${pairs} pairs)`,
    );
    const slowest = Math.max(...rows.map(r => r.ms));
    for (const r of rows)
      console.log(
        `  ${r.name.padEnd(15)} ${r.ms.toFixed(3).padStart(9)} ms/op  ` +
          `${(slowest / r.ms).toFixed(2)}x  ` +
          `spread ${r.lo.toFixed(3)}-${r.hi.toFixed(3)}  ` +
          `${r.perCallKb.toFixed(1).padStart(6)} KB/call ` +
          `(${r.perCallLoKb.toFixed(1)}-${r.perCallHiKb.toFixed(1)}), ` +
          `holds ${(r.heldKb / 1024).toFixed(1)} MB, ` +
          `wire ${r.wireKb.toFixed(1)} in / ${r.wireOutKb.toFixed(1)} out KB`,
      );
    console.log(`  -> postgrejs won ${wins} of ${pairs} pairs, ${odds(p)}`);
    console.log(
      `     allocation: postgrejs lower in ${heapWins} of ${heapPairs}, ${odds(heapP)}`,
    );
    console.log();
  }
  console.log(
    'written to benchmark/results/latest.json - `npm run bench:report` renders it\n',
  );
}

await main();
