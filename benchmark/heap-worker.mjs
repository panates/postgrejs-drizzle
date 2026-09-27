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
 *   node --expose-gc benchmark/heap-worker.mjs <driver> <scenario> [mode]
 *
 * With `idle` it measures only what the client keeps: once with the calls
 * still coming, and once after long enough that a client which caches a
 * buffer between calls has had time to hand it back. That second reading
 * costs a wall-clock wait, so it is a pass of its own rather than part of
 * every one.
 *
 * With `sustained` it measures the other thing the peak cannot say: the
 * high-water mark of a run with **no forced collection inside it**, which
 * is what the process actually has to be able to hold. A client that
 * allocates a fresh buffer per message leaves that buffer as garbage, and
 * garbage counts until the collector arrives; one that writes into a
 * buffer it reuses leaves none. The marginal peak is blind to this by
 * construction - it collects before every sample - so it reported level
 * where a run reports a third less.
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

const usedBytes = () => {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.external;
};

// Taken before a pool exists, so what the client grows by can be told
// apart from what Node and drizzle were already holding.
globalThis.gc();
globalThis.gc();
const cold = usedBytes();

const [which, name, mode] = process.argv.slice(2);
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
const atRest = usedBytes();

/**
 * The same question asked again after a pause, because one of these
 * clients answers it differently depending on when you ask.
 *
 * PostgreJS writes each message into one growing buffer per connection
 * and reclaims it after `houseKeepMs` (5s) of quiet, so a client that
 * just sent a 4MB parameter is still holding the 4MB it grew to. That is
 * real while the calls keep coming and gone shortly after they stop, and
 * a single figure cannot say both. `pg` builds a fresh buffer per message
 * and drops it, so it has nothing to give back and reads the same either
 * way - which is what makes the gap look like a leak until you wait.
 */
/**
 * What the process needs while the calls keep coming. Nothing is
 * collected on purpose here: the question is how high it goes between the
 * collections the runtime chooses, not how high one call goes above a
 * clean heap.
 *
 * Long enough to reach a steady collection cycle - swept at 25, 50, 100
 * and 200 calls, the `int4[]` write reads 77 MB against 92 at every
 * length and the 4MB `bytea` write settles by 100, so the answer is not
 * an artifact of where the batch stops.
 */
if (mode === 'sustained') {
  const iterations = Math.max(scenario.iters * 8, 100);
  let highest = 0;
  let highestRss = 0;
  const watch = setInterval(() => {
    const usage = process.memoryUsage();
    const used = usage.heapUsed + usage.external;
    if (used > highest) highest = used;
    if (usage.rss > highestRss) highestRss = usage.rss;
  }, 1);
  if (scenario.setup) await scenario.setup(db);
  // the parent runs this child under `--trace-gc` and adds up what each
  // collection gave back between these two marks. That total is additive
  // in a way the high-water is not: it is how much the client actually
  // asked for and threw away, rather than where the runtime happened to
  // decide to collect.
  console.log(`MARK ${performance.now().toFixed(0)}`);
  for (let i = 0; i < iterations; i++) await scenario.run(db, i);
  console.log(`END ${performance.now().toFixed(0)}`);
  clearInterval(watch);
  console.log(
    JSON.stringify({
      driver: which,
      scenario: name,
      iterations,
      sustainedKb: (highest - cold) / 1024,
      sustainedRssKb: highestRss / 1024,
    }),
  );
  await close();
  process.exit(0);
}

if (mode === 'idle') {
  await new Promise(resolve => setTimeout(resolve, 6000));
  globalThis.gc();
  globalThis.gc();
  console.log(
    JSON.stringify({
      driver: which,
      scenario: name,
      heldKb: (atRest - cold) / 1024,
      idleHeldKb: (usedBytes() - cold) / 1024,
    }),
  );
  await close();
  process.exit(0);
}

/**
 * What one more call adds: collect, take a baseline, run a single call,
 * keep the highest sample. Median of a few.
 *
 * Marginal rather than total, and it means nothing read alone - a client
 * that has already grown its read buffer adds little for the next call
 * precisely because it is holding one. That is what `heldKb` is beside
 * it, and the two want reading together.
 *
 * Read at the end of the call and not only sampled during it. Sampling
 * alone was wrong twice over: it missed short calls entirely, and on the
 * 4MB `bytea` read it caught 24.7 MB of pg's 53.5 while catching 8.2 of
 * PostgreJS's 8.4 - so it understated one side by 2.2x and the other by
 * 1.03, which distorts the comparison and not just the figure.
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
  // and the reading that needs no luck. A timer cannot fire faster than
  // once a millisecond, so a call that returns in 0.6ms is sampled once
  // or not at all - `point read` took zero samples in five rounds out of
  // five and reported 0 KB for a call that allocates 53. Nothing is
  // collected between the baseline and here, so the heap only goes up
  // and the reading at the end is exact rather than lucky; the sampler
  // is kept because it is the only thing that can see a peak a mid-call
  // collection has already taken away.
  const usage = process.memoryUsage();
  const atEnd =
    usage.heapUsed - base.heapUsed + (usage.external - base.external);
  peaks.push(Math.max(highest, atEnd) / 1024);
}
peaks.sort((a, b) => a - b);
const peakKb = peaks[Math.floor(peaks.length / 2)];

// and the churn: everything a batch allocates, per call, which is the
// collector's workload rather than the process's high-water mark.
// Collected first - the peak rounds above leave the heap high, and a
// baseline taken on top of that reads the whole batch as zero.
globalThis.gc();
globalThis.gc();
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
  heldKb: (atRest - cold) / 1024,
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
