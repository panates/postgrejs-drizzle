/**
 * One driver, one scenario, one process - and nothing else in it.
 *
 * Memory was measured with both drivers alive in the same process until
 * a child per driver replaced it, because that cannot see what a client
 * allocates once and keeps: the baseline is taken after both are already
 * up, so their pools, buffers and decoders are under it rather than in
 * it. This is also how postgrejs's own suite measures - a child per
 * library, spawned one at a time.
 *
 *   node --expose-gc benchmark/heap-worker.mjs <driver> <scenario> [idle]
 *
 * With `idle` it measures only what the client keeps: once with the calls
 * still coming, and once after long enough that a client which caches a
 * buffer between calls has had time to hand it back. That second reading
 * costs a wall-clock wait, so it is a pass of its own rather than part of
 * every one.
 *
 * It prints one JSON line and exits.
 *
 * ## Why there is no per-call peak here any more
 *
 * There was one, and it was wrong in three separate ways before it was
 * given up on. It measured a single call above a forced-GC baseline:
 *
 * - **Sampled, it mostly sampled nothing.** A timer cannot fire faster
 *   than once a millisecond, so a `point read` that returns in 0.6ms took
 *   zero samples in five rounds of five and the column printed 0 KB for a
 *   call that allocates about 30. `page of 200` took zero or one and
 *   printed 282 KB against 41 - a `-85%` that was two coin flips.
 * - **Sampled over a longer call it still understated, and unevenly.** On
 *   the 4MB `bytea` read it caught 24.7 MB of pg's 53.5 while catching
 *   8.2 of PostgreJS's 8.4, so one side read 2.2x low and the other
 *   1.03x. That moves the comparison, not only the figure.
 * - **Read exactly at the end of the call, the baseline is the problem.**
 *   The first call after a collection is not like the ones after it:
 *   call by call a `point read` costs 52.5 KB, 36.0, then 29.6 and flat
 *   on `pg`, and 48.7, 36.8, then 30.8 and flat here. Spending calls to
 *   settle that fixes the short rows and ruins the large ones, because
 *   without a collection in front of it a 50 MB call meets one inside it
 *   and the delta comes back at 759 KB, or negative. Collecting again
 *   after settling brings the surcharge straight back: 49.3 KB.
 *
 * The two failures are mutually exclusive, so the quantity is not
 * measurable that way. What replaced it is below, and agrees with two
 * independent instruments.
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
// prepared statements. Separate from what a call costs and from what a
// run peaks at - three different questions.
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
 * One batch, sampled at 1ms, answering two questions that are not the
 * same and were confused for each other until they were split.
 *
 * **What a call allocates.** Every fall in `heapUsed + external` is a
 * collection handing memory back; summed over the batch and added to what
 * the heap still holds at the end, that is everything the calls asked
 * for. Nothing in it depends on where a collection lands, which is what
 * made a per-call peak unmeasurable. Checked two ways: against a separate
 * `--trace-gc` count the parent takes from this child's output, which
 * reads 24.0 and 27.7 KB for a `point read` where this reads 24.7 and
 * 29.0; and against the same read on bare clients with no drizzle over
 * them, at 15.9 and 20.3. It is also the only one of the two that can see
 * a `Buffer`, which `--trace-gc` cannot.
 *
 * **What the process peaks at.** The high-water of the same samples, with
 * nothing collected on purpose, which is what the process has to be able
 * to hold. It is not the same ranking, and it is not meant to be: it is
 * where the runtime chose to collect, so a client that allocates a third
 * as much can sit higher for reaching the threshold a third as often.
 *
 * Long enough to settle - swept at 25, 50, 100 and 200 calls, the
 * `int4[]` write reads the same at every length - and longer where the
 * calls are cheap, because the per-call figure converges with the batch:
 * a `point read` reads 31.3 KB over 200 calls and 24.7 over 2000.
 */
const iterations = Math.max(scenario.iters * 20, 100);
let highest = 0;
let highestRss = 0;
let collected = 0;
let previous = 0;

if (scenario.setup) await scenario.setup(db);
globalThis.gc();
globalThis.gc();
const batchBase = usedBytes();
previous = batchBase;

const watch = setInterval(() => {
  const usage = process.memoryUsage();
  const used = usage.heapUsed + usage.external;
  if (used > highest) highest = used;
  if (used < previous) collected += previous - used;
  previous = used;
  if (usage.rss > highestRss) highestRss = usage.rss;
}, 1);

// The parent runs this child under `--trace-gc` and adds up what each
// collection gave back between these two marks, as a check on the
// sampled figure that is arrived at a completely different way.
console.log(`MARK ${performance.now().toFixed(0)}`);
const receivedBefore = received;
const sentBefore = sent;
for (let i = 0; i < iterations; i++) await scenario.run(db, i);
console.log(`END ${performance.now().toFixed(0)}`);

clearInterval(watch);
const batchEnd = usedBytes();
if (batchEnd < previous) collected += previous - batchEnd;

console.log(
  JSON.stringify({
    driver: which,
    scenario: name,
    iterations,
    // what it holds warm, what a call costs, what the run peaks at, and
    // what crossed the socket in each direction
    heldKb: (atRest - cold) / 1024,
    allocPerCallKb: (batchEnd - batchBase + collected) / iterations / 1024,
    sustainedKb: (highest - cold) / 1024,
    sustainedRssKb: highestRss / 1024,
    wireKb: (received - receivedBefore) / 1024 / iterations,
    wireOutKb: (sent - sentBefore) / 1024 / iterations,
  }),
);

await close();
process.exit(0);
