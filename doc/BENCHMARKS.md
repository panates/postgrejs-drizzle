# The same drizzle calls, on both drivers

What this driver costs or saves against `drizzle-orm/node-postgres`, measured through drizzle rather
than at the client underneath it - the numbers a caller of the query builder or `db.execute()`
actually sees.

```sh
npm run bench     # node --expose-gc benchmark/drizzle-bench.mjs
```

## Method

`benchmark/drizzle-bench.mjs` builds one table of nine mixed-type columns, seeds it, and runs every
scenario through both drivers **in one process**, alternating them inside every pair and swapping
which goes first each time, so an ordering artifact - a cold cache, a busy moment on the machine -
lands on both equally.

The medians alone would not be worth much. This is a shared machine, and the absolute figures drift:
the same `node-postgres` point read came out at 0.270 ms and 0.521 ms in two runs an hour apart. What
does not drift is **which** driver won each pair, so that is counted separately, and a sign test asks
how likely that split would be from a fair coin. Only the winner counts and by how much is thrown
away, which is exactly what lets it survive a noisy machine: it says whether a difference is real,
and says nothing about its size - that is what the median column is for.

Latency and memory are separate passes. Polling `process.memoryUsage()` inside the timed window costs
more than the calls being timed and lands unevenly on the two drivers; an early revision of this file
did exactly that and reported a 2x that was its own. Peak heap is the most `heapUsed` rose above a
forced-GC baseline while a unit ran, so it needs `--expose-gc` to mean anything.

## Results

Node v24.15.0, `postgrejs` 3.10.1, `pg` 8.23.0, PostgreSQL on loopback, medians per call.

| Scenario                                  | node-postgres | this driver   |          |
| ----------------------------------------- | ------------- | ------------- | -------- |
| point read - one row by primary key       | 0.521 ms      | **0.466 ms**  | **1.12x**|
| page of 200 - nine columns, mixed types   | 1.092 ms      | 1.110 ms      | level    |
| insert returning - six parameters         | 0.559 ms      | **0.535 ms**  | **1.04x**|
| concurrent reads - 20 at once, pool of 10 | 2.737 ms      | 2.459 ms      | level    |
| `int4[]` of 100k - one array column       | 28.526 ms     | **13.223 ms** | **2.16x**|
| `bytea` of 4MB - one binary column        | 111.767 ms    | **35.113 ms** | **3.18x**|

And which driver actually won, pair by pair:

| Scenario          | pairs | this driver faster in | odds of that by luck |
| ----------------- | ----- | --------------------- | -------------------- |
| point read        | 101   | 75                    | < 1 in 10^5          |
| page of 200       | 101   | 49                    | not distinguishable  |
| insert returning  | 101   | 68                    | < 1 in 10^3          |
| concurrent reads  | 61    | 31                    | not distinguishable  |
| `int4[]` of 100k  | 41    | 41                    | < 1 in 10^12         |
| `bytea` of 4MB    | 41    | 41                    | < 1 in 10^12         |

Peak heap over the same units:

| Scenario         | node-postgres | this driver |
| ---------------- | ------------- | ----------- |
| `int4[]` of 100k | 65.2 MB       | **1.7 MB**  |
| `bytea` of 4MB   | 0.36 MB       | **0.24 MB** |
| page of 200      | 6.9 MB        | **5.4 MB**  |

## Reading them

**Round trips are slightly cheaper and it is repeatable.** A point read wins 75 pairs of 101 - small
in absolute terms, and not luck. A statement is parsed once per connection here and executed by name
after that, which is the part of a short query there is anything to save on.

**A page of rows and a burst of concurrent reads are level.** Neither split is distinguishable from a
coin. The concurrency one is worth naming: PostgreJS can put several statements on one connection at
a time, and this driver does not ask it to - every query gets a connection to itself, as under `pg`.
The headroom is real and unclaimed.

**The separation is on payload.** 2.2x and 3.2x, 41 pairs of 41 each. PostgreJS reads these columns
in PostgreSQL's binary format where `pg` reads them as text, and that shows up twice over:

- On the wire. A `bytea` costs exactly twice as much as text - `\x`-prefixed hex, two characters per
  byte - so the 4MB column is 4MB rather than 8MB. An `int4[]` depends on the values: binary spends a
  fixed 8 bytes per element where text spends one byte per digit, so full-width integers favour
  binary.
- In the heap. The 100k-element array peaks at 1.7 MB against 65.2 MB - the text path materialises
  the whole array literal as a string and parses it, where the binary path reads elements out of the
  buffer it already has.

**Where it reaches you.** Through drizzle, these are `bytea` columns, array columns, and anything
large in a raw `db.execute()`. A schema of text, integers and timestamps sees the first four rows of
that table and nothing more.

The client underneath has its own suite against `pg` and `postgres.js`, on more scenarios than this -
COPY, cursors, pooling, pipelining - in
[`postgrejs/doc/BENCHMARKS.md`](https://github.com/panates/postgrejs/blob/master/doc/BENCHMARKS.md).
