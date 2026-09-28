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
          bold(mb(control.allocPerCallKb), heapSettled && heapRatio < 1),
        ),
        pair(
          bold(ms(driver.ms), won && ratio > 1),
          bold(mb(driver.allocPerCallKb), heapSettled && heapRatio > 1),
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
  const reads = named.filter(s => s.group === 'Read');
  const writes = named.filter(s => s.group === 'Write');
  const payload = reads.filter(s => s.ratio > 1.5);
  const ordinary = reads.filter(s => s.ratio <= 1.5);
  const leaner = named.filter(s => s.heapSettled && s.heapRatio > 1);
  const heavier = named.filter(s => s.heapSettled && s.heapRatio < 1);
  const array = named.find(s => s.name.startsWith('int4[]'));
  const bytes = named.find(s => s.name.startsWith('bytea of 4MB'));

  const says = s =>
    !s.won
      ? 'level'
      : s.ratio > 1
        ? `${s.ratio.toFixed(2)}x`
        : `${(1 / s.ratio).toFixed(2)}x to \`pg\``;
  // the row where one client holds most more than the other, which is
  // the one the buffer paragraph is about
  const grown = [...named].sort(
    (a, b) =>
      b.driver.heldKb - b.control.heldKb - (a.driver.heldKb - a.control.heldKb),
  )[0];
  const peakGap = mb(
    Math.abs(grown.driver.allocPerCallKb - grown.control.allocPerCallKb),
  );
  const sustainedLower = named.filter(
    s => s.driver.sustainedKb < s.control.sustainedKb,
  );
  const sustainedHigher = named.filter(
    s => s.driver.sustainedKb >= s.control.sustainedKb,
  );
  // `-29%` where PostgreJS needs less of it, `+25%` where it needs more
  const sustainedSays = s => {
    const change =
      ((s.driver.sustainedKb - s.control.sustainedKb) / s.control.sustainedKb) *
      100;
    return `${s.name.split(' - ')[0]} ${change > 0 ? '+' : ''}${change.toFixed(0)}%`;
  };
  const decisive = named.every(
    s => s.sustainedWins === 0 || s.sustainedWins === s.sustainedPairs,
  );
  const blobWrite = writes.find(s => s.name.includes('bytea'));
  const arrayWrite = writes.find(s => s.name.includes('int4[]'));
  const bulkWrite = writes.find(s => s.name.includes('500 rows'));

  const paragraphs = [
    `**Reading is where the payload decides it.** ${list(
      payload.map(s => `${s.name.split(' - ')[0]} is ${s.ratio.toFixed(1)}x`),
    )}. The ordinary shapes move much less - ${list(
      ordinary.map(s => `${s.name.split(' - ')[0]} ${says(s)}`),
    )} - because a short result is mostly a round trip, and a round trip is the same round trip.`,

    `**Writing moves less, and one row goes the other way.** ${list(
      writes.map(s => `${s.name.split(' - ')[0]} ${says(s)}`),
    )}. The server does the work in a write - parsing, planning, the heap, the WAL - so a client can
     only save on its own share of it, and that share is smaller than the decoding it saves on a
     read.`,

    `**And the wire is the same on both sides of every write.** Counted at the socket: ${kbOrMb(
      blobWrite.control.wireOutKb,
    )} for the 4MB \`bytea\`, which each driver sends as binary, and ${kbOrMb(
      arrayWrite.control.wireOutKb,
    )} for the 100k \`int4[]\`, which each sends as text. The array is text on purpose - PostgreJS
     stopped declaring an element type for an array of numbers because \`[1, 2]\` is one of six array
     types depending on where it lands and they have no casts between them, so declaring \`int4[]\`
     broke four of the six. With identical bytes going out, what separates the two is
     the writing of the literal, and that row has moved twice: it was ${says(arrayWrite)} after
     PostgreJS stopped quoting and re-escaping every element of an array it writes, and was 1.12x to
     \`pg\` before. Reported from here rather than worked around, measured there, fixed there.`,

    `**Where a write does save bytes, it is the statement and not the data.** ${bulkWrite.name.split(' - ')[0]}
     sends ${kbOrMb(bulkWrite.driver.wireOutKb)} against ${kbOrMb(bulkWrite.control.wireOutKb)} - the
     statement itself is 2500 placeholders long, and \`pg\` binds it unnamed, so the server is handed
     the whole text on every call. PostgreJS names it once and sends Bind and Execute after that.`,

    `**What a call allocates splits by payload, and by a lot where it splits at all.** PostgreJS
     allocates less on ${leaner.length} of the ${named.length} scenarios and more on
     ${heavier.length}, but the sizes are not comparable between the two groups. The wins are the
     payload rows and they are large - ${list(
       leaner
         .filter(
           s =>
             s.control.allocPerCallKb > 1024 || s.driver.allocPerCallKb > 1024,
         )
         .map(
           s =>
             `${s.name.split(' - ')[0]} at ${mb(s.driver.allocPerCallKb)} against ${mb(s.control.allocPerCallKb)}`,
         ),
     )}. The losses are the decoded scalar reads, where it builds more per row and the figures are
     single-digit MB either way: ${list(
       heavier
         .filter(
           s =>
             s.control.allocPerCallKb > 1024 || s.driver.allocPerCallKb > 1024,
         )
         .map(
           s =>
             `${s.name.split(' - ')[0]} at ${mb(s.driver.allocPerCallKb)} against ${mb(s.control.allocPerCallKb)}`,
         ),
     )}. On the ordinary short rows the two are within tens of KB of each other and the column is
     not worth reading.`,

    `**And what a call allocates is garbage rather than growth.** Between calls the two sit within
     a few hundred KB of each other on every scenario but the large writes. Measured over 100, 400
     and 1600 calls of a point read the gap scales with the call count and the between-calls figure
     does not move, which is what says churn rather than a structure being held.`,

    `**And the large writes are a buffer, not growth.** ${grown.name.split(' - ')[0]} leaves
     PostgreJS holding ${mb(grown.driver.heldKb)} where \`pg\` holds ${mb(grown.control.heldKb)},
     which reads as the one place it keeps materially more - and it is one buffer per connection,
     grown to the largest message it has had to write and handed back after five seconds of quiet.
     Waited out, the same process holds ${mb(grown.driver.idleHeldKb)} - where \`pg\`, which builds
     a fresh buffer for each message and drops it, has nothing to give back and reads within a few
     KB of itself either way. That is also why the two allocate within ${peakGap} of each other on
     that row while one of them appears to be holding
     ${mb(grown.driver.heldKb - grown.control.heldKb)} more. Which number is the right one depends
     on the question: under sustained writes it is the first, for a process that goes quiet between
     them the second. The read rows shrink on both drivers, so it is only the writes the two of
     them answer differently.`,

    `**The high-water splits differently from the allocation, and not all one way.** It is where the
     runtime chose to collect rather than what the client asked for, so the two need not agree.
     Measured over the same batch - each scenario's own call count, no fewer than 100, three
     paired repetitions - PostgreJS needs less on ${sustainedLower.length} of the ${named.length}
     scenarios and more on ${sustainedHigher.length}. Less: ${list(
       sustainedLower.map(sustainedSays),
     )}. More: ${list(sustainedHigher.map(sustainedSays))}.${
       decisive
         ? ' Every one of those splits was unanimous across the paired runs.'
         : ''
     }`,

    `**What decides it is the allocation column, not the buffer reuse.** The rows where PostgreJS
     needs less are the ones where it hands back a large payload without building a large
     intermediate - ${kbOrMb(bytes.driver.allocPerCallKb)} a call against
     ${kbOrMb(bytes.control.allocPerCallKb)} on the 4MB \`bytea\` read, which is the hex string \`pg\`
     has to materialise and it does not. The rows where it needs more are the ones where it builds
     more per row, and the sustained figure follows that at a few hundred KB a call. Buffer reuse
     is real - it is what the held column shows - but it only reaches this number where the
     message being reused for is itself large.`,

    `**One of those is the high-water's own answer rather than the client's.**
     ${arrayWrite.name.split(' - ')[0]} peaks at ${mb(arrayWrite.driver.sustainedKb)} against
     ${mb(arrayWrite.control.sustainedKb)} while sending ${kbOrMb(arrayWrite.driver.wireOutKb)}
     against ${kbOrMb(arrayWrite.control.wireOutKb)}, and it read the same at 25, 50, 100 and 200
     calls, so it is not where the batch stops. The allocation column goes the other way and not
     narrowly: \`pg\` asks for ${kbOrMb(arrayWrite.control.allocPerCallKb)} a call where PostgreJS
     asks for ${kbOrMb(arrayWrite.driver.allocPerCallKb)}, and a separate \`--trace-gc\` count of the
     same run agrees at ${kbOrMb(arrayWrite.control.reclaimedKb)} against
     ${kbOrMb(arrayWrite.driver.reclaimedKb)}. Both are measurements of the same batch. What
     separates them is that \`pg\` reaches the runtime's collection threshold three times as often
     and is collected back to a lower line, while PostgreJS asks for a third as much and is allowed
     to run further up first. The process really does peak higher on this driver; it is not because
     the driver asked for more, and it only does so here - the same insert on the bare clients with
     no drizzle in between puts PostgreJS at 37.8 MB against \`pg\`'s 60.6, the counted figures
     unmoved at 10.12 against 26.92. A high-water is partly a fact about the application around the
     client, which is worth knowing before carrying one of these rows anywhere.`,

    `**Where that garbage comes from is the array literal, on both sides.** Probed once rather than
     tabled, so the two figures in it do not move with a re-run: handed the same insert with the
     literal already built, so that only the send is measured, both clients collect 1.85 MB a call
     - level to two decimals - and both take 10.5 ms. Handed the array instead, each builds the
     literal itself, and that one step is the whole of the difference in both columns. Neither
     client's send path is what separates them here.`,

    `**Why the payload rows separate.** PostgreJS reads and writes these columns in PostgreSQL's
     binary format where \`pg\` uses text. On the wire that is worth less than it sounds and depends
     on the values: binary costs 8 bytes an \`int4\` element whatever the number, text a byte a digit,
     so the full-width array this table uses pulls ${kbOrMb(array.driver.wireKb)} against
     ${kbOrMb(array.control.wireKb)} while an array of single digits would pull 781 KB against 195
     and still not lose. A \`bytea\` has no such freedom - \`\\x\`-prefixed hex is two characters a byte
     whatever the bytes are - so there the saving is fixed at half: ${kbOrMb(bytes.control.wireKb)}
     against ${kbOrMb(bytes.driver.wireKb)}.`,

    `**What it is winning is mostly the parse, not the bytes.** The text path materialises the whole
     value as a string and walks it; the binary path reads it out of the buffer it already has. That
     is also why it allocates ${kbOrMb(array.driver.allocPerCallKb)} a call against
     ${kbOrMb(array.control.allocPerCallKb)} on the array, and why the single-digit case - where it pulls
     four times the bytes \`pg\` does - was still not behind when it was measured.`,

    `**Where it reaches you.** Through drizzle, these are \`bytea\` columns, array columns, and
     anything large in a raw \`db.execute()\`. A schema of text, integers and timestamps sees the
     ordinary rows and not the payload ones.`,
  ];

  return paragraphs.map(paragraph => wrap(paragraph)).join('\n\n');
}

function document(results) {
  const { versions } = results;
  const by = name => results.scenarios.find(s => s.name.startsWith(name));
  const blobWrite = speedup(by('insert a 4MB bytea'));
  const byName = name => speedup(by(name));
  const kb = value => (value >= 1024 ? mb(value) : `${value.toFixed(0)} KB`);
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

${wrap(`**The allocation column is what a call asks for in total, and it is measured over a batch rather
than over one call.** Every fall in \`heapUsed + external\` is a collection handing memory back;
summed across the batch and added to what the heap still holds at the end, that is everything the
calls allocated, whether or not any of it survived. Nothing in it depends on where a collection
happens to land.`)}

${wrap(`**A per-call figure was tried first and is not measurable**, which is worth writing down because
the number it produced was quoted here for several revisions. Measured as one call above a forced
collection, it failed three separate ways. Sampled at 1ms it mostly sampled nothing: a \`point read\`
returns in 0.6ms and took zero samples in five rounds of five, printing 0 KB for a call that
allocates about 30, and \`page of 200\` printed 282 KB against 41 - a \`-85%\` that was two coin
flips against the ${kb(byName('page of 200').control.allocPerCallKb)} and ${kb(byName('page of 200').driver.allocPerCallKb)} it really is. Sampled over a longer call it still
understated, and unevenly: on the 4MB \`bytea\` read it caught 24.7 MB of pg's 53.5 while catching
8.2 of PostgreJS's 8.4, which moves the comparison and not only the figure. Read exactly at the end
of the call instead, the baseline is the problem - the first call after a collection costs 52.5 KB
where the fourth costs 29.6, and by a different factor on each client. Spending calls to settle that
fixes the short rows and ruins the large ones, because a 50 MB call with no collection in front of
it meets one inside it and the delta comes back at 759 KB or negative. The two failures are
mutually exclusive, so the column is gone rather than patched.`)}

${wrap(`**It is checked against two instruments that share none of its machinery.** The children run under
\`--trace-gc\` and the parent adds up what each collection reported handing back; on the rows made of
strings the two agree closely - ${kbOrMb(byName('insert a 100k int4[]').control.allocPerCallKb)} against ${kbOrMb(byName('insert a 100k int4[]').control.reclaimedKb)} traced on the 100k \`int4[]\` write,
${kbOrMb(byName('int4[] of 100k, full width').control.allocPerCallKb)} against ${kbOrMb(byName('int4[] of 100k, full width').control.reclaimedKb)} reading one back. Where they part is where
\`--trace-gc\` is blind: it reports the JS heap only, so a \`Buffer\` is invisible to it and it reads
${kbOrMb(byName('bytea of 4MB').control.reclaimedKb)} a call on the 4MB \`bytea\` read against the ${kbOrMb(byName('bytea of 4MB').control.allocPerCallKb)} actually moved. That is the
\`heapUsed\`-without-\`external\` error in a better-looking instrument, and it is why the traced figure
is recorded in \`benchmark/results/latest.json\` as \`reclaimedKb\` rather than printed as a column.
The second check is the floor: the same point read on bare clients with no drizzle over them
allocates 15.9 KB and 20.3 KB, against ${kb(byName('point read').control.allocPerCallKb)} and ${kb(byName('point read').driver.allocPerCallKb)} here, so the tens of KB a small
query costs are real and mostly not this driver's.`)}

${wrap(`**The high-water column answers a different question and ranks the drivers differently on
purpose.** It is the highest \`heapUsed + external\` the same batch reached with nothing collected on
command, which is what the process has to be able to hold. It is not a second opinion on allocation:
it is where the runtime chose to collect. A client that allocates a third as much reaches the
threshold a third as often and is allowed to run further up first, so the two columns can and do
disagree - the 100k \`int4[]\` write is the row where they disagree outright. Read together they
say what a caller needs to know; read alone either one misleads.`)}

${wrap(`RSS is sampled in the same pass and is **not** a column, because it did not measure this. It runs
three to six times the live figure on both drivers - ${mb(blobWrite.control.sustainedRssKb)}
against ${mb(blobWrite.driver.sustainedRssKb)} on the 4MB \`bytea\` write - and it moves with V8's
reserved heap and the allocator's retained pages rather than with what the client is holding; over a
batch-length sweep it wandered by 80 MB on one driver while the live figure moved by 8. It is in the
results file for anyone who wants it.`)}

${wrap(`Latency and memory are separate passes. Polling \`process.memoryUsage()\` inside the timed window
costs more than the calls being timed and lands unevenly on the two drivers; an early revision of
this file did exactly that and reported a 2x that was its own. The memory pass forces a collection
to take its baseline, so it needs \`--expose-gc\` to mean anything.`)}

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
it. A 100k-element \`int4[]\` runs between ${f.widthLow}x and ${f.widthHigh}x depending on how much of the type its
values use, at ${f.arrayDriverHeap} against ${f.arrayControlHeap} on the widest of them - the range is quoted rather
than a single figure because the values decide it, not the driver. Ordinary queries gain less and
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
    `- **Faster where the payload is large** - ${f.bytesRatio}x on a 4MB \`bytea\`, and ${f.widthLow}x to ${f.widthHigh}x on a 100k-element \`int4[]\` according to how much of the type its values use, on a fraction of the memory, because the values arrive in PostgreSQL's binary format rather than as text to be parsed.`,
    98,
  ).replace(/\n/g, '\n  '),
);
await writeFile(README, readme);

console.log(
  `doc/BENCHMARKS.md and README.md rendered from a run of ${results.measuredAt}`,
);
