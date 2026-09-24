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
import net from 'node:net';

// Bytes the server actually sent, counted at the socket rather than taken
// from either client's own accounting - the same instrument postgrejs's
// suite uses, and the reason this is measured at all: the wire cost of the
// binary format was argued from the encoding here until it was counted,
// and for an int4[] of small numbers the argument had it backwards.
let received = 0;
let sent = 0;
const push = net.Socket.prototype.push;
net.Socket.prototype.push = function (chunk, ...rest) {
  if (chunk) received += chunk.length;
  return push.call(this, chunk, ...rest);
};
// and what goes out, which a write scenario is entirely made of - the
// received column reads 0.0 KB for every one of them
const write = net.Socket.prototype.write;
net.Socket.prototype.write = function (chunk, ...rest) {
  if (chunk) sent += chunk.length ?? Buffer.byteLength(chunk);
  return write.call(this, chunk, ...rest);
};

const { CONTROL, DRIVER, openDatabases, scenariosMatching } =
  await import('./scenarios.mjs');

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
if (scenario.setup) await scenario.setup(db);
const warmup = Math.min(scenario.iters * 4, 60);
for (let i = 0; i < warmup; i++) await scenario.run(db, i);
if (scenario.setup) await scenario.setup(db);

globalThis.gc();
globalThis.gc();
// What the driver holds at rest, warm: its pool, its buffers, its
// prepared statements. Separate from what a call needs and from what a
// batch churns through - three different questions.
const atRest = process.memoryUsage();

/**
 * What one call needs at once: collect, take a baseline, run a single
 * call, keep the highest sample. Median of a few.
 *
 * Measured over a batch instead, this reads as how much garbage piles up
 * before the collector arrives, which is a fact about GC scheduling
 * rather than about the driver - and it inverted the answer on the one
 * scenario it was checked against. A 100k `int4[]` insert peaks at 12.6
 * MB a call here and 30.4 MB under `pg`; over 24 calls the same sampling
 * said the opposite.
 */
const peaks = [];
const ROUNDS = 5;
for (let round = 0; round < ROUNDS; round++) {
  globalThis.gc();
  globalThis.gc();
  const base = process.memoryUsage();
  let highest = 0;
  const watch = setInterval(() => {
    const usage = process.memoryUsage();
    const delta =
      usage.heapUsed - base.heapUsed + (usage.external - base.external);
    if (delta > highest) highest = delta;
  }, 1);
  await scenario.run(db, round);
  clearInterval(watch);
  peaks.push(highest / 1024);
}
peaks.sort((a, b) => a - b);
const peakKb = peaks[Math.floor(peaks.length / 2)];

// and the churn: everything a batch allocates, per call, which is the
// collector's workload rather than the process's high-water mark
const baseline = process.memoryUsage().heapUsed;
const externalBaseline = process.memoryUsage().external;
let churn = 0;
const poll = setInterval(() => {
  const usage = process.memoryUsage();
  const delta = usage.heapUsed - baseline + (usage.external - externalBaseline);
  if (delta > churn) churn = delta;
}, 5);

const iterations = scenario.iters * 8;
const receivedBefore = received;
const sentBefore = sent;
for (let i = 0; i < iterations; i++) await scenario.run(db, i);
const wireKb = (received - receivedBefore) / 1024 / iterations;
const wireOutKb = (sent - sentBefore) / 1024 / iterations;

clearInterval(poll);
globalThis.gc();
const retained = process.memoryUsage().heapUsed - baseline;

const measured = {
  driver: which,
  scenario: name,
  iterations,
  // what it holds warm, what one call needs at once, what a batch
  // churns through per call, and what the batch did not give back
  atRestKb: (atRest.heapUsed + atRest.external) / 1024,
  peakKb,
  perCallKb: 0, // filled in below
  wireKb,
  wireOutKb,
  retainedKb: retained / 1024,
  rssKb: process.memoryUsage().rss / 1024,
};
// the batch's high-water mark is the garbage it left behind between
// collections, which only means anything divided by the calls that made it
measured.perCallKb = churn / 1024 / iterations;
console.log(JSON.stringify(measured));

await close();
process.exit(0);
