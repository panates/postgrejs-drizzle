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
const kbOrMb = value =>
  value >= 1024 ? `${(value / 1024).toFixed(1)} MB` : `${value.toFixed(1)} KB`;
/** KB below a megabyte, MB above it - `0.00 MB` says nothing. */
const mb = kb =>
  kb < 1024
    ? `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
    : `${(kb / 1024).toFixed(1)} MB`;
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
    // the peak, because that is what the column shows and what the sign
    // test counted - the churn is its own column further down
    heapRatio: control.allocPerCallKb / driver.allocPerCallKb,
    heapSettled: scenario.heapP < 0.05,
  };
};

/** `**2.65x**`, `1.61x to \`pg\``, or `level` - for the timings. */
function verdict(settled, ratio) {
  if (!settled) return 'level';
  return ratio > 1
    ? `**${ratio.toFixed(2)}x**`
    : `${(1 / ratio).toFixed(2)}x to \`pg\``;
}

/**
 * Memory reads better as a percentage than as a multiple: `-51%` says
 * postgrejs held half again less than `node-postgres` did, `+29%` that it
 * held more, and the sign carries which way without a phrase for it.
 */
function percent(settled, control, driver) {
  if (!settled) return 'level';
  const change = ((driver - control) / control) * 100;
  const text = `${change > 0 ? '+' : ''}${change.toFixed(0)}%`;
  return change < 0 ? `**${text}**` : text;
}

/**
 * `4.7 MB` when a client keeps it, `4.7 MB -> 0.7 idle` when it hands it
 * back. Only written where the two differ by enough to be a fact about
 * the client rather than about a collection that happened to run.
 */
function heldCell(row) {
  const shown = mb(row.heldKb);
  if (row.idleHeldKb == null) return shown;
  const given = row.heldKb - row.idleHeldKb;
  if (given < 512 || given / row.heldKb < 0.25) return shown;
  return `${shown} \u2192 ${mb(row.idleHeldKb)} idle`;
}

/** What a driver holds warm, and what one call throws away. */
function memoryTable(results) {
  return table(
    [
      'Scenario',
      `held between calls (${CONTROL} / ${DRIVER})`,
      `high-water under load (${CONTROL} / ${DRIVER})`,
      `off the wire per call (${CONTROL} / ${DRIVER})`,
      `onto the wire per call (${CONTROL} / ${DRIVER})`,
    ],
    results.scenarios.map(scenario => {
      const { control, driver } = speedup(scenario);
      const kb = value =>
        value >= 1024 ? mb(value) : `${value.toFixed(1)} KB`;
      return [
        scenario.name,
        // and what is still held once the calls stop, where that is a
        // different number - a buffer a client grew and has not yet
        // handed back is not the same claim as one it keeps
        `${heldCell(control)} / ${heldCell(driver)}`,
        `${mb(control.sustainedKb)} / ${mb(driver.sustainedKb)}`,
        `${kb(control.wireKb)} / ${kb(driver.wireKb)}`,
        `${kb(control.wireOutKb)} / ${kb(driver.wireOutKb)}`,
      ];
    }),
  );
}

/**
 * Four columns, two lines to a cell: the time on the first and the peak
 * memory under it, for each driver, with both verdicts in the last one. A
 * row is two numbers about one call, and standing them side by side made
 * the table wider than it was informative.
 */
function headlineTable(results, group) {
  const pair = (top, bottom) => `${top}<br>${bottom}`;
  const rows = group
    ? results.scenarios.filter(s => s.group === group)
    : results.scenarios;
  return table(
    [
      'Scenario',
      `${CONTROL}<br>allocated per call`,
      `${DRIVER}<br>allocated per call`,
      '',
    ],
    rows.map(scenario => {
      const { control, driver, ratio, won, heapRatio, heapSettled } =
        speedup(scenario);
      return [
        `${scenario.name} - ${scenario.note}`,
        pair(
          bold(ms(control.ms), won && ratio < 1),
          `${bold(mb(control.allocPerCallKb), heapSettled && heapRatio < 1)}/call`,
        ),
        pair(
          bold(ms(driver.ms), won && ratio > 1),
          `${bold(mb(driver.allocPerCallKb), heapSettled && heapRatio > 1)}/call`,
        ),
        pair(
          verdict(won, ratio),
          percent(heapSettled, control.allocPerCallKb, driver.allocPerCallKb),
        ),
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
  const widths = results.scenarios
    .filter(s => s.name.startsWith('int4[]'))
    .map(speedup);
  const array = speedup(by('int4[] of 100k, full width'));
  const bytes = speedup(by('bytea of 4MB'));
  const point = by('point read');
  return {
    bytesDriverMs: bytes.driver.ms.toFixed(1),
    bytesControlMs: bytes.control.ms.toFixed(1),
    bytesDriverHeap: mb(bytes.driver.allocPerCallKb),
    bytesControlHeap: mb(bytes.control.allocPerCallKb),
    arrayRatio: array.ratio.toFixed(1),
    bytesRatio: bytes.ratio.toFixed(1),
    arrayDriverMs: array.driver.ms.toFixed(1),
    arrayControlMs: array.control.ms.toFixed(1),
    arrayDriverHeap: mb(array.driver.allocPerCallKb),
    arrayControlHeap: mb(array.control.allocPerCallKb),
    pointWins: point.wins,
    pointPairs: point.pairs,
    widthLow: Math.min(...widths.map(w => w.ratio)).toFixed(1),
    widthHigh: Math.max(...widths.map(w => w.ratio)).toFixed(1),
    // one `int4[]` row survives, the narrow variants having been dropped
    // once the wide one was shown to be the honest setting - so this used
    // to print "between 3.8x and 3.8x"
    widthRange:
      Math.min(...widths.map(w => w.ratio)).toFixed(1) ===
      Math.max(...widths.map(w => w.ratio)).toFixed(1)
        ? `${Math.max(...widths.map(w => w.ratio)).toFixed(1)}x`
        : `between ${Math.min(...widths.map(w => w.ratio)).toFixed(1)}x and ${Math.max(...widths.map(w => w.ratio)).toFixed(1)}x`,
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
/**
 * What the tables mean, in the fewest paragraphs that still say it.
 *
 * Generated rather than written, because every claim in here is one the
 * next run can overturn - two rows went from a loss to level the first
 * time the client stopped cutting a Buffer per row, and a hand-written
 * sentence would still be calling them losses.
 */
function reading(results) {
  const named = results.scenarios.map(s => ({ ...s, ...speedup(s) }));
  const reads = named.filter(s => s.group === 'Read');
  const writes = named.filter(s => s.group === 'Write');
  // grouped by what the memory column says, not the clock: a row where
  // this driver allocates a fifth of what `pg` does is a payload row
  // whatever its ratio, and `float8 of 5k rows` - level on memory - was
  // being called a payload win for being 1.5x on time
  const payload = reads.filter(s => s.heapSettled && s.heapRatio >= 1.2);
  const ordinary = reads.filter(s => !(s.heapSettled && s.heapRatio >= 1.2));
  const short = name => name.split(' - ')[0];
  const spread = named.find(s => s.name === 'float8 of 5k rows, full width');
  const packed = named.find(s => s.name === 'float8[] of 5k in one row');
  const arrayWrite = writes.find(s => s.name.includes('int4[]'));
  const bulkWrite = writes.find(s => s.name.includes('500 rows'));
  const grown = [...named].sort(
    (a, b) =>
      b.driver.heldKb - b.control.heldKb - (a.driver.heldKb - a.control.heldKb),
  )[0];
  const says = s =>
    !s.won
      ? 'level'
      : s.ratio > 1
        ? `${s.ratio.toFixed(2)}x`
        : `${(1 / s.ratio).toFixed(2)}x to \`pg\``;

  const paragraphs = [
    `**Large payloads are where it wins, and it wins them by a lot.** ${list(
      payload.map(
        s =>
          `${short(s.name)} ${says(s)} on ${mb(s.driver.allocPerCallKb)} against ${mb(s.control.allocPerCallKb)}`,
      ),
    )}. These columns arrive in PostgreSQL's binary format rather than as text to be parsed, and the
     parse is most of what that saves - \`pg\` has to materialise the whole value as a string
     first.`,

    `**What decides it is values per row, not values.** ${short(spread.name)} and
     ${short(packed.name)} hold the same 5000 \`float8\`s and differ in nothing but shape. Spread
     out, the two are level at ${mb(spread.driver.allocPerCallKb)} against
     ${mb(spread.control.allocPerCallKb)}, because the protocol's per-row cost is most of what
     either client pays. Packed into one row it is ${mb(packed.driver.allocPerCallKb)} against
     ${mb(packed.control.allocPerCallKb)} - and \`pg\` gets worse rather than this driver getting
     better, because one row of 5000 values is one megabyte of array literal with a substring cut
     per element.`,

    `**Everything else gains on the clock and not on memory.** ${list(
      ordinary.map(s => `${short(s.name)} ${says(s)}`),
    )} - and on memory those rows are level or a few percent the wrong way. A result of many narrow
     rows is mostly round trips and per-row protocol cost, which is the same work on both sides.`,

    `**Writing moves less, because the server does the work.** ${list(
      writes.map(s => `${short(s.name)} ${says(s)}`),
    )}. The one that moves on memory is ${short(arrayWrite.name)}, at
     ${mb(arrayWrite.driver.allocPerCallKb)} against ${mb(arrayWrite.control.allocPerCallKb)}:
     \`pg\` builds the array literal as a string in the JS heap, PostgreJS writes the integers into
     the send buffer from the numbers themselves. Reported from here, measured there, fixed there.`,

    `**The bytes on the wire are the same, or close.** Both clients send a \`bytea\` as binary and an
     array as text, so a write saves on the statement rather than the data:
     ${short(bulkWrite.name)} sends ${kbOrMb(bulkWrite.driver.wireOutKb)} against
     ${kbOrMb(bulkWrite.control.wireOutKb)} only because \`pg\` binds its 2500 placeholders unnamed
     and hands the server the whole text every call. Binary is a read-side property of this driver:
     every parameter it sends is text except a \`Buffer\`, which both send as binary.`,

    `**Memory held is small on both, with one exception.** Between calls the two sit within a few
     hundred KB of each other everywhere but ${short(grown.name)}, where PostgreJS holds
     ${mb(grown.driver.heldKb)} against ${mb(grown.control.heldKb)} - one send buffer per
     connection, grown to the largest message it has written and handed back after five seconds of
     quiet. Waited out, the same process holds ${mb(grown.driver.idleHeldKb)}.`,

    `**Where it reaches you.** Through drizzle, the wins are \`bytea\` columns, array columns, and
     anything large in a raw \`db.execute()\`. A schema of text, integers and timestamps sees the
     ordinary rows and not the payload ones - a little faster, and about the same memory.`,
  ];

  return paragraphs.map(paragraph => wrap(paragraph)).join('\n\n');
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

${wrap(`Every scenario runs through both drivers against the same server, alternating them inside each
pair and swapping which goes first, so a cold cache or a busy moment lands on both equally. The
medians are what the tables print; the sign test beside them counts only **which** driver won each
pair, which is what survives a shared machine - the same \`pg\` point read has come out at 0.270 ms,
0.521 ms and 0.508 ms across three runs of the same code, while the winner did not change.`)}

${wrap(`**Two numbers per row.** The time is one call. The memory is what one call **asks for** -
everything allocated while it runs, whether or not any of it survives - measured in a process of its
own per driver, so a client's own buffers are inside the window rather than under it. A call is one
\`db.execute()\` or one \`db.transaction()\`; where that is more than one query the scenario's name
says so. Nothing here is the cost of running a scenario end to end.`)}

${wrap(`Memory has more than one honest answer, so the table below the results carries three: what a
client keeps between calls, what a call allocates, and how high the process goes before the runtime
collects. They rank the drivers differently and are meant to - the last one is partly a fact about
the application around the client. \`benchmark/heap-worker.mjs\` has the rest, including a per-call
peak column that was quoted here for several revisions before it turned out not to be measurable.`)}

## Results

${wrap(`Node ${versions.node}, \`postgrejs\` ${versions.postgrejs}, \`pg\` ${versions.pg}, \`drizzle-orm\` ${versions.drizzle}, PostgreSQL on loopback, medians per call.`)}

### Reading

${headlineTable(results, 'Read')}

### Writing

${headlineTable(results, 'Write')}

And which driver actually won, pair by pair:

${signTable(results)}

The memory line of that last column is a percentage rather than a multiple, and it is postgrejs
against \`node-postgres\`: \`-51%\` is half again less held, \`+29%\` is more.

Memory is measured the same way and counted the same way - one child process per driver, so what a
client allocates once and keeps is inside the window rather than under it, and the JS heap and the
off-heap buffers are sampled together as one number. That last part matters more than it sounds: a
\`bytea\` arrives as a \`Buffer\`, which lives outside the JS heap entirely, so \`heapUsed\` alone reads
pg's 4MB column as 0.4 MB while it is really holding 49 MB of it.

${heapSignTable(results)}

${wrap(`Those are three different questions and the answers are not the same, which is the whole reason
they are three columns: what a client keeps between calls, what a call costs while it runs, and how
high the process goes before the runtime collects.`)}

${memoryTable(results)}

${wrap(`The first two are properties of the client. The third is partly a property of the application
around it - with a larger live heap under the same calls the collections halve and the ceiling
floats about twice as high, so two clients can change places on it between a bare harness and a real
process without either behaving differently. Take the allocation column as the comparison and the
high-water as the sizing.`)}

## Reading them

${reading(results)}

## Both sides speak the same protocol

They did not always. \`pg\` sends a query with no values over PostgreSQL's **simple** protocol -
\`requiresPreparation()\` in \`pg/lib/query.js\` returns false without a name, a row limit or values -
and takes the extended one as soon as a parameter appears, which is what PostgreJS's \`query()\` always
speaks. Nine of these scenarios read a stored value and needed no parameter, so nine of them were
comparing two different protocols.

That is worth knowing even though it is fixed, because it was not small where the payload was: on a
1KB \`bytea\`, the simple protocol accounted for almost the whole memory difference between the two
drivers. Measured at the time, by giving \`pg\` a statement name so it took the extended path:

| | \`pg\` simple | \`pg\` extended | PostgreJS |
| --- | ---: | ---: | ---: |
| \`select 1\` | 7.4 KB / 0.421 ms | 9.2 KB / 0.402 ms | 13.7 KB / 0.412 ms |
| \`bytea\` 1KB | 12.3 KB / 0.513 ms | 13.7 KB / 0.428 ms | 14.0 KB / 0.386 ms |
| \`bytea\` 256KB | 633.7 KB / 4.462 ms | 757.3 KB / 5.321 ms | 530.9 KB / 2.305 ms |
| \`int4[]\` full width | 2191 KB / 48.6 ms | 2205 KB / 42.0 ms | 1565 KB / 8.8 ms |

Every scenario now binds a parameter - a \`limit\` that selects the whole result, there to even the
comparison rather than to filter anything - and \`pg\` sends Parse, Bind and Execute for all fourteen,
checked by counting the messages its connection actually writes.

What is left is a difference between the drivers rather than between protocols, and it stays: \`pg\`
binds an unnamed statement, which the server parses again on every call, while PostgreJS names and
caches one and reuses it. That is each driver's own default on the same protocol, and it is what the
point read's margin is made of.

## How this differs from postgrejs's own suite

The client underneath has its own benchmark against \`pg\` and \`postgres.js\`, on more scenarios than
this - COPY, cursors, pooling, pipelining - in
[\`postgrejs/doc/BENCHMARKS.md\`](https://github.com/panates/postgrejs/blob/master/doc/BENCHMARKS.md).
It measures the client; this measures the client through drizzle, so the two are not interchangeable
and the numbers should not be read across. Where the method itself differs, and why:

| | postgrejs's suite | here |
| --- | --- | --- |
| process | one child per library | a child per driver for memory, one shared process for the timings |
| baseline | forced GC, then the run - warmup included in the window | forced GC after warmup, so one-time structures sit under it |
| sampled | \`heapUsed\` + \`external\`, as one sample | the same |
| reported | peak growth, and GC ms/op | peak, allocation per call, and heap at rest |
| statistic | median of 3 to 9 repeats | median of paired runs, with a sign test on the split |

Splitting the two is measured rather than assumed. For memory a child per driver is not optional:
with both alive in one process the baseline is taken with both already up, so what a client
allocates once and keeps sits under the window instead of in it - the point read's figures were 1.0
MB against 1.1 MB that way, which is noise, against 11.5 MB and 12.1 MB with a process each and
spreads of about 250 KB.

For the timings it buys nothing. Run one driver per process, 21 alternated rounds, the point read
comes out 0.507 ms against 0.481 with postgrejs ahead in 17 of 21 (p = 0.007); paired inside one
process it is 0.463 against 0.425, ahead in 73 of 101 (p < 1 in 10^5). Same direction, same order of
size - so sharing a process is not distorting the comparison, which is the thing isolation would be
bought to rule out. What it costs is power: a process per sample yields far fewer samples for the
same wall clock, and a wider spread with them (0.433-0.698 ms alone), because two runs on a shared
machine minutes apart are not the same experiment while two alternated inside one pair are.

The baseline's position is a choice: baking warmup into the window measures a scenario from cold,
which answers "what does this cost" but cannot separate what a driver holds from what a call throws
away. Both are reported here instead, because on the small workloads they point opposite ways.

The memory accounting used to differ and no longer does. That suite sampled \`heapUsed\` alone, which
cannot see a \`Buffer\` - and a \`bytea\` is a \`Buffer\` - so its Peak Heap was blind to exactly the
payload it exists to measure: its Large Blob Fetch row moved 25 MB per op and reported a 2 MB peak.
Reported from here, fixed there in \`f074d7a\`, and it turned up one more thing on the way: a large
string built out of a buffer is external too, at two bytes a character, which is how \`pg\` holds a
\`bytea\`. Both suites now count \`heapUsed + external\` from one sample, so their memory figures are
the same kind of number even though the workloads are not.
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
  wrap(`It is faster where it counts, and it holds far less memory doing it. A 4MB \`bytea\` comes back
in ${f.bytesDriverMs} ms against ${f.bytesControlMs} ms, and at ${f.bytesDriverHeap} against ${f.bytesControlHeap} - \`pg\`
holds that column as hex text, twice the size, off the JS heap where a heap figure alone cannot see
it. A 100k-element \`int4[]\` runs ${f.widthRange}, at ${f.arrayDriverHeap} against
${f.arrayControlHeap} - values that use the whole type on purpose, because a column of single digits
is shorter as text than as binary and quoting that would be choosing the answer. Ordinary queries gain less and
gain it repeatably: a point read is the faster of the two in ${f.pointWins} of ${f.pointPairs} alternated pairs.
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
    `- **Faster where the payload is large** - ${f.bytesRatio}x on a 4MB \`bytea\`, and ${f.widthRange} on a 100k-element \`int4[]\` whose values use the whole type, on a fraction of the memory, because the values arrive in PostgreSQL's binary format rather than as text to be parsed.`,
    98,
  ).replace(/\n/g, '\n  '),
);
await writeFile(README, readme);

console.log(
  `doc/BENCHMARKS.md and README.md rendered from a run of ${results.measuredAt}`,
);
