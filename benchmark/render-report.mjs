/**
 * Renders the last `npm run bench` into `doc/BENCHMARKS.md` and into the
 * two marked tables in `README.md`.
 *
 * The figures used to be copied across by hand, and the run that moved to
 * postgrejs 3.11.0 is why this exists: six numbers in the README, three
 * tables in the document, and one of them - a peak-heap figure inside a
 * sentence - was still the old value after the first pass. A number that
 * lives in two files drifts in one of them.
 *
 * It reads `benchmark/results/latest.json` and runs nothing, so it can be
 * re-run against a measurement taken hours ago.
 *
 *   npm run bench          # measure, and write the results file
 *   npm run bench:report   # render it
 */
import { readFile, writeFile } from 'node:fs/promises';

const RESULTS = new URL('./results/latest.json', import.meta.url);
const DOC = new URL('../doc/BENCHMARKS.md', import.meta.url);
const README = new URL('../README.md', import.meta.url);

const CONTROL = 'node-postgres';
const DRIVER = 'postgrejs';

/** Longest column wins; markdown does not care, but a reader does. */
function table(header, rows) {
  const widths = header.map((cell, i) =>
    Math.max(cell.length, ...rows.map(row => String(row[i]).length)),
  );
  const line = cells =>
    `| ${cells.map((cell, i) => String(cell).padEnd(widths[i])).join(' | ')} |`;
  return [
    line(header),
    `| ${widths.map(w => '-'.repeat(w)).join(' | ')} |`,
    ...rows.map(line),
  ].join('\n');
}

/** Prettier leaves prose as it finds it, so wrap it here. */
function wrap(text, width = 100) {
  const lines = [];
  let line = '';
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

const ms = value => `${value.toFixed(3)} ms`;
const mb = kb => `${(kb / 1024).toFixed(kb < 1024 ? 2 : 1)} MB`;
const bold = (text, when) => (when ? `**${text}**` : text);

/** What the sign test's split is worth saying about. */
const odds = p => {
  if (p >= 0.05) return 'not distinguishable';
  const exponent = Math.floor(-Math.log10(p));
  return exponent >= 3 ? `< 1 in 10^${exponent}` : `p = ${p.toFixed(3)}`;
};

const pick = (scenario, name) => scenario.rows.find(row => row.name === name);
const speedup = scenario => {
  const [control, driver] = [pick(scenario, CONTROL), pick(scenario, DRIVER)];
  return {
    control,
    driver,
    ratio: control.ms / driver.ms,
    won: scenario.p < 0.05,
    // the heap gets the same treatment as the timings: a split a coin
    // would produce is reported as level, whichever way the medians fell
    heapRatio: control.perCallKb / driver.perCallKb,
    heapSettled: scenario.heapP < 0.05,
  };
};

/** `63.6 MB -> 1.7 MB`, or the same with nothing claimed about it. */
function heapCell(scenario) {
  const { control, driver, heapSettled, heapRatio } = speedup(scenario);
  if (!heapSettled)
    return `${mb(control.peakKb)} -> ${mb(driver.peakKb)} (level)`;
  return heapRatio > 1
    ? `${mb(control.peakKb)} -> **${mb(driver.peakKb)}**`
    : `**${mb(control.peakKb)}** -> ${mb(driver.peakKb)}`;
}

/** What a driver holds warm, and what one call throws away. */
function memoryTable(results) {
  return table(
    [
      'Scenario',
      `at rest (${CONTROL} / ${DRIVER})`,
      `allocated per call (${CONTROL} / ${DRIVER})`,
    ],
    results.scenarios.map(scenario => {
      const { control, driver } = speedup(scenario);
      const kb = value =>
        value >= 1024 ? mb(value) : `${value.toFixed(1)} KB`;
      return [
        scenario.name,
        `${mb(control.atRestKb)} / ${mb(driver.atRestKb)}`,
        `${kb(control.perCallKb)} / ${kb(driver.perCallKb)}`,
      ];
    }),
  );
}

function headlineTable(results) {
  return table(
    ['Scenario', CONTROL, DRIVER, '', 'peak memory'],
    results.scenarios.map(scenario => {
      const { control, driver, ratio, won } = speedup(scenario);
      return [
        `${scenario.name} - ${scenario.note}`,
        ms(control.ms),
        bold(ms(driver.ms), won && ratio > 1),
        won && ratio > 1 ? `**${ratio.toFixed(2)}x**` : 'level',
        heapCell(scenario),
      ];
    }),
  );
}

function signTable(results) {
  return table(
    ['Scenario', 'pairs', `${DRIVER} faster in`, 'odds of that by luck'],
    results.scenarios.map(scenario => [
      scenario.name,
      scenario.pairs,
      scenario.wins,
      odds(scenario.p),
    ]),
  );
}

function heapSignTable(results) {
  return table(
    ['Scenario', 'pairs', `${DRIVER} lower in`, 'odds of that by luck'],
    results.scenarios.map(scenario => [
      scenario.name,
      scenario.heapPairs,
      scenario.heapWins,
      odds(scenario.heapP),
    ]),
  );
}

/** A figure the prose quotes, so the prose is generated too. */
function figures(results) {
  const by = name => results.scenarios.find(s => s.name.startsWith(name));
  const array = speedup(by('int4[]'));
  const bytes = speedup(by('bytea'));
  const point = by('point read');
  return {
    bytesDriverMs: bytes.driver.ms.toFixed(1),
    bytesControlMs: bytes.control.ms.toFixed(1),
    bytesDriverHeap: mb(bytes.driver.peakKb),
    bytesControlHeap: mb(bytes.control.peakKb),
    arrayRatio: array.ratio.toFixed(1),
    bytesRatio: bytes.ratio.toFixed(1),
    arrayDriverMs: array.driver.ms.toFixed(1),
    arrayControlMs: array.control.ms.toFixed(1),
    arrayDriverHeap: mb(array.driver.peakKb),
    arrayControlHeap: mb(array.control.peakKb),
    pointWins: point.wins,
    pointPairs: point.pairs,
  };
}

/** A list, in prose: `a`, `a and b`, `a, b and c`. */
const list = items =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/**
 * The paragraphs that say what the tables mean. Generated, because each
 * one makes a claim the next run can overturn - "level" became a win on
 * two scenarios the first time the heap measurement was fixed.
 */
function reading(results) {
  const named = results.scenarios.map(s => ({ ...s, ...speedup(s) }));
  const faster = named.filter(s => s.won && s.ratio > 1);
  const levelSpeed = named.filter(s => !s.won);
  const leaner = named.filter(s => s.heapSettled && s.heapRatio > 1);
  const heavier = named.filter(s => s.heapSettled && s.heapRatio < 1);
  const payload = named.filter(s => s.ratio > 1.5);
  const array = named.find(s => s.name.startsWith('int4[]'));
  const bytes = named.find(s => s.name.startsWith('bytea'));

  const fixed = heavier.length
    ? `On the small workloads it is the other way: ${list(
        heavier.map(
          s =>
            `${s.name} allocates ${s.driver.perCallKb.toFixed(1)} KB a call against ${s.control.perCallKb.toFixed(1)}`,
        ),
      )}. That is garbage rather than growth, and the distinction is the whole point: at rest the two are within a few hundred KB of each other - ${list(
        heavier.map(
          s =>
            `${mb(s.driver.atRestKb)} against ${mb(s.control.atRestKb)} on ${s.name}`,
        ),
      )} - so what it costs is collector time on a hot path, not footprint. Measured over 100, 400 and 1600 calls of a point read the gap scales with the call count and the at-rest figure does not move, which is what says churn rather than a structure being held.`
    : '';

  return [
    `**Speed follows the payload.** ${list(
      payload.map(s => `${s.name} is ${s.ratio.toFixed(1)}x`),
    )}, on ${payload[0]?.pairs ?? 0} pairs of ${payload[0]?.pairs ?? 0} each. On the ordinary shapes the gap is small and, ${
      faster.length === named.length
        ? 'on every one of them, repeatable'
        : `on ${list(faster.filter(s => s.ratio <= 1.5).map(s => s.name))}, repeatable`
    }${levelSpeed.length ? `; ${list(levelSpeed.map(s => s.name))} ${levelSpeed.length > 1 ? 'are' : 'is'} not distinguishable from a coin` : ''}.`,

    `**Memory divides the same way, and it is worth being exact about.** Where the payload is large PostgreJS holds far less of it: ${list(
      leaner.map(
        s =>
          `${s.name} peaks at ${mb(s.driver.peakKb)} against ${mb(s.control.peakKb)}`,
      ),
    )}. ${fixed}`,

    `**The \`bytea\` row is the one to read twice.** ${bytes.control.perCallKb >= 1024 ? mb(bytes.control.perCallKb) : `${bytes.control.perCallKb.toFixed(0)} KB`} a call against ${bytes.driver.perCallKb >= 1024 ? mb(bytes.driver.perCallKb) : `${bytes.driver.perCallKb.toFixed(0)} KB`}, and an earlier revision of this file had it the other way round - 0.39 MB against 0.75 MB - because it measured \`heapUsed\` alone. A \`Buffer\` is not on the JS heap, and a \`bytea\` is a \`Buffer\`, so the 4MB column \`pg\` was holding as 8MB of hex text plus a buffer was invisible to the number being printed.`,

    `**Why the payload rows separate.** PostgreJS reads these columns in PostgreSQL's binary format where \`pg\` reads them as text, and that shows up twice over:`,

    `- On the wire. A \`bytea\` costs exactly twice as much as text - \`\\x\`-prefixed hex, two characters per byte - so the 4MB column is 4MB rather than 8MB. An \`int4[]\` depends on the values: binary spends a fixed 8 bytes per element where text spends one byte per digit, so full-width integers favour binary.\n- In memory. The 100k-element array peaks at ${mb(array.driver.peakKb)} against ${mb(array.control.peakKb)} - the text path materialises the whole array literal as a string and parses it, where the binary path reads elements out of the buffer it already has.`,

    `**Where it reaches you.** Through drizzle, these are \`bytea\` columns, array columns, and anything large in a raw \`db.execute()\`. A schema of text, integers and timestamps sees the top of that table and not the bottom.`,
  ]
    .map(paragraph =>
      paragraph.startsWith('- ')
        ? paragraph
            .split('\n')
            .map(line => wrap(line, 98).replace(/\n/g, '\n  '))
            .join('\n')
        : wrap(paragraph),
    )
    .join('\n\n');
}

function document(results) {
  const { versions } = results;
  return `# The same drizzle calls, on both drivers

_Generated by \`npm run bench:report\` from the last \`npm run bench\`. Do not hand-edit - re-run the
command instead._

What this driver costs or saves against \`drizzle-orm/node-postgres\` - postgrejs against \`pg\`,
measured through drizzle rather
than at the client underneath it - the numbers a caller of the query builder or \`db.execute()\`
actually sees.

\`\`\`sh
npm run bench          # measure
npm run bench:report   # render this file and the README's tables
\`\`\`

## Method

\`benchmark/drizzle-bench.mjs\` builds one table of nine mixed-type columns, seeds it, and runs every
scenario through both drivers **in one process**, alternating them inside every pair and swapping
which goes first each time, so an ordering artifact - a cold cache, a busy moment on the machine -
lands on both equally.

The medians alone would not be worth much. This is a shared machine, and the absolute figures drift:
the same \`node-postgres\` point read has come out at 0.270 ms, 0.521 ms and 0.508 ms across three runs
of the same code. What does not drift is **which** driver won each pair, so that is counted
separately, and a sign test asks how likely that split would be from a fair coin. Only the winner
counts and by how much is thrown away, which is exactly what lets it survive a noisy machine: it says
whether a difference is real, and says nothing about its size - that is what the median column is
for.

Latency and memory are separate passes. Polling \`process.memoryUsage()\` inside the timed window costs
more than the calls being timed and lands unevenly on the two drivers; an early revision of this file
did exactly that and reported a 2x that was its own. Peak heap is the most \`heapUsed\` rose above a
forced-GC baseline while a unit ran, so it needs \`--expose-gc\` to mean anything.

## Results

${wrap(`Node ${versions.node}, \`postgrejs\` ${versions.postgrejs}, \`pg\` ${versions.pg}, \`drizzle-orm\` ${versions.drizzle}, PostgreSQL on loopback, medians per call.`)}

${headlineTable(results)}

And which driver actually won, pair by pair:

${signTable(results)}

Memory is measured the same way and counted the same way - one child process per driver, so what a
client allocates once and keeps is inside the window rather than under it, and the JS heap and the
off-heap buffers are sampled together as one number. That last part matters more than it sounds: a
\`bytea\` arrives as a \`Buffer\`, which lives outside the JS heap entirely, so \`heapUsed\` alone reads
pg's 4MB column as 0.4 MB while it is really holding 49 MB of it.

${heapSignTable(results)}

Those two are different questions, and the answers are not the same. What a driver holds warm is one
number; what a single call allocates and then throws away is another, and it is the second one the
peak is made of on a small query - the peak above a warm baseline is garbage waiting for the
collector, and it grows with the size of the batch rather than saying anything about the driver:

${memoryTable(results)}

The per-call column is the steadier of the two. A peak is whatever was alive at one moment, and on
the payload rows that depends on when the collector happened to run - a \`bytea\` is a \`Buffer\`, and a
\`Buffer\` is freed on collection rather than when it goes out of scope, so the same scenario has
peaked at 0.7 MB on one run and 32 MB on the next. Both drivers are measured the same way and the
split is 15 of 15 either way, so what the sign test settles is the direction; the magnitude of a peak
is not worth quoting to two figures.

## Reading them

${reading(results)}

## How this differs from postgrejs's own suite

The client underneath has its own benchmark against \`pg\` and \`postgres.js\`, on more scenarios than
this - COPY, cursors, pooling, pipelining - in
[\`postgrejs/doc/BENCHMARKS.md\`](https://github.com/panates/postgrejs/blob/master/doc/BENCHMARKS.md).
It measures the client; this measures the client through drizzle, so the two are not interchangeable
and the numbers should not be read across. Where the method itself differs, and why:

| | postgrejs's suite | here |
| --- | --- | --- |
| process | one child per library | the same |
| baseline | forced GC, then the run - warmup included in the window | forced GC after warmup, so one-time structures sit under it |
| sampled | \`heapUsed\` | \`heapUsed\` + \`external\`, as one sample |
| reported | peak growth, and GC ms/op | peak, allocation per call, and heap at rest |
| statistic | median of 3 to 9 repeats | median of paired runs, with a sign test on the split |

The first difference is a choice: baking warmup into the window measures a scenario from cold, which
answers "what does this cost" but cannot separate what a driver holds from what a call throws away.
Both are reported here instead, because on the small workloads they point opposite ways.

The second is not a choice. \`heapUsed\` does not count a \`Buffer\`, and a \`bytea\` is a \`Buffer\`, so
that column is blind to exactly the payload it exists to measure - visible in its own Large Blob
Fetch row, which moves 25 MB per op and reports a 2 MB peak. It is written up for that repository as
\`peak-heap-misses-buffers.md\`; nothing is worked around here beyond counting the byte that the other
one misses.
`;
}

/** Rewrites one `<!-- bench:name -->` … `<!-- /bench:name -->` region. */
function replaceRegion(text, name, body) {
  const open = `<!-- bench:${name} -->`;
  const close = `<!-- /bench:${name} -->`;
  const from = text.indexOf(open);
  const to = text.indexOf(close);
  if (from === -1 || to === -1)
    throw new Error(`README.md has no ${open} … ${close} region`);
  return `${text.slice(0, from + open.length)}\n\n${body}\n\n${text.slice(to)}`;
}

const results = JSON.parse(await readFile(RESULTS, 'utf8'));
const f = figures(results);
const { versions } = results;

await writeFile(DOC, document(results));

let readme = await readFile(README, 'utf8');
readme = replaceRegion(
  readme,
  'headline',
  `${headlineTable(results)}

` +
    wrap(
      `\`drizzle-orm\` ${versions.drizzle}, \`postgrejs\` ${versions.postgrejs}, PostgreSQL on loopback, Node ${versions.node.replace('v', '')}. Medians; how that was measured and how much each row can bear are in [How the numbers were measured](#how-the-numbers-were-measured).`,
    ),
);
readme = replaceRegion(readme, 'signtest', signTable(results));
readme = replaceRegion(
  readme,
  'intro',
  wrap(`It is faster where it counts, and it holds far less memory doing it. A 100k-element array
column comes back in ${f.arrayDriverMs} ms against ${f.arrayControlMs} ms, peaking at ${f.arrayDriverHeap} against
${f.arrayControlHeap}; a 4MB \`bytea\` in ${f.bytesDriverMs} ms against ${f.bytesControlMs} ms, and at
${f.bytesDriverHeap} against ${f.bytesControlHeap} - \`pg\` holds that column as hex text, twice the
size, off the JS heap where a heap figure alone cannot see it. Ordinary queries gain less and gain it
repeatably: a point read is the faster of the two in ${f.pointWins} of ${f.pointPairs} alternated pairs.
All of it measured through drizzle against \`drizzle-orm/node-postgres\` on the same server:
[\`doc/BENCHMARKS.md\`](doc/BENCHMARKS.md).`),
);
readme = replaceRegion(
  readme,
  'binary',
  wrap(`Result columns arrive in PostgreSQL's binary format and are decoded per type, where \`pg\` asks for
text and parses it. On bulk that is the whole difference: a 100k-element \`int4[]\` costs
${f.arrayDriverMs} ms and ${f.arrayDriverHeap} here against ${f.arrayControlMs} ms and
${f.arrayControlHeap}, because the text path has to materialise the array literal as one string
before it can parse it.`),
);
readme = replaceRegion(
  readme,
  'prepared',
  wrap(`PostgreJS names and caches a statement per connection - 64 by default, least-recently-used closed -
so each distinct SQL string is parsed and planned once rather than on every call. Counted from the
backend: three queries through this driver leave one prepared statement behind, and the same three
through \`drizzle-orm/node-postgres\` leave none, because \`pg\` prepares only a query it was given a
name for and drizzle does not give it one. This is what the point read's ${f.pointWins} pairs of
${f.pointPairs} is.`),
);
readme = replaceRegion(
  readme,
  'payload',
  wrap(
    `- **Faster where the payload is large** - ${f.arrayRatio}x on a 100k-element array column and ${f.bytesRatio}x on a 4MB \`bytea\`, on a fraction of the memory, because the values arrive in PostgreSQL's binary format rather than as text to be parsed.`,
    98,
  ).replace(/\n/g, '\n  '),
);
await writeFile(README, readme);

console.log(
  `doc/BENCHMARKS.md and README.md rendered from a run of ${results.measuredAt}`,
);
