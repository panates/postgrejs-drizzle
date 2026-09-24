/**
 * One driver, one scenario, one process - and nothing else in it.
 *
 * Peak heap was measured with both drivers alive in the same process
 * until now, which cannot see what a client allocates once and keeps: the
 * baseline is taken after both are already up, so their pools, buffers and
 * decoders are under it rather than in it. Only the churn of a batch was
 * left, and on a small row that is mostly drizzle's, identical on both
 * sides. This is how postgrejs's own suite measures - a child per library,
 * spawned one at a time - so the figure is the whole cost of running that
 * scenario on that driver.
 *
 *   node --expose-gc benchmark/heap-worker.mjs <driver> <scenario>
 *
 * It prints one JSON line and exits.
 */
import {
  CONTROL,
  DRIVER,
  openDatabases,
  scenariosMatching,
} from './scenarios.mjs';

const [which, name] = process.argv.slice(2);
const scenario = scenariosMatching('all').find(s => s.name === name);
if (!scenario) throw new Error(`no scenario named ${name}`);
if (which !== CONTROL && which !== DRIVER)
  throw new Error(`no driver named ${which}`);

const { dbs, close } = openDatabases(scenario.pooled);
const db = dbs[which];

// Warm up first: the JIT, the pool's connections and - on this driver -
// the prepared statement each distinct SQL earns. What is measured is a
// scenario in its steady state, not its first call.
const warmup = Math.min(scenario.iters * 4, 60);
for (let i = 0; i < warmup; i++) await scenario.run(db, i);

globalThis.gc();
globalThis.gc();
// What the driver holds at rest, warm: its pool, its buffers, its
// prepared statements. Separate from what a batch churns through, and the
// two answer different questions - "how much does it need" against "how
// much garbage does a call make".
const atRest = process.memoryUsage();
const baseline = atRest.heapUsed;
const externalBaseline = process.memoryUsage().external;
let peak = 0;
let peakHeapOnly = 0;
let peakExternalOnly = 0;
const poll = setInterval(() => {
  const usage = process.memoryUsage();
  const heap = usage.heapUsed - baseline;
  // A Buffer lives outside the JS heap, and `bytea` is a Buffer: measured
  // on heapUsed alone, pg's 4MB column reads as 0.4 MB while it is really
  // holding 49 MB of it off-heap. What a process costs is both together,
  // sampled as one number so the two peaks cannot be added when they never
  // happened at once.
  const external = usage.external - externalBaseline;
  if (heap + external > peak) peak = heap + external;
  if (heap > peakHeapOnly) peakHeapOnly = heap;
  if (external > peakExternalOnly) peakExternalOnly = external;
}, 5);

const iterations = scenario.iters * 8;
for (let i = 0; i < iterations; i++) await scenario.run(db, i);

clearInterval(poll);
globalThis.gc();
const retained = process.memoryUsage().heapUsed - baseline;

const measured = {
  driver: which,
  scenario: name,
  iterations,
  // what the batch ever held at once - heap and off-heap together - and
  // what it did not give back
  atRestKb: (atRest.heapUsed + atRest.external) / 1024,
  perCallKb: 0, // filled in below
  peakKb: peak / 1024,
  peakHeapOnlyKb: peakHeapOnly / 1024,
  peakExternalOnlyKb: peakExternalOnly / 1024,
  retainedKb: retained / 1024,
  rssKb: process.memoryUsage().rss / 1024,
};
// the peak above a warm baseline is allocation churn, and it scales with
// the batch, so it only means something per call
measured.perCallKb = measured.peakKb / iterations;
console.log(JSON.stringify(measured));

await close();
process.exit(0);
