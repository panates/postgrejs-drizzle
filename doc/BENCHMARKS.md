# The same drizzle calls, on both drivers

What this driver costs or saves against `drizzle-orm/node-postgres`, measured through drizzle rather
than at the client underneath it - the numbers a caller of `db.execute()` or the query builder
actually sees.

Run it yourself:

```sh
npm run bench            # or: node --expose-gc benchmark/drizzle-bench.mjs --repeats=9
```

## Method

`benchmark/drizzle-bench.mjs` builds one table of nine mixed-type columns, seeds it, and runs each
scenario through both drivers **in one process**, alternating them inside every repeat and swapping
which goes first each time, so an ordering artifact - a cold cache, a busy moment on the machine -
lands on both equally. What is reported is the median across repeats, never a single run, and the
observed spread is printed beside it.

Latency and memory are separate passes. Polling `process.memoryUsage()` inside the timed window
costs more than the calls being timed and lands unevenly on the two drivers; an early revision of
this file did exactly that and reported a 2x that was its own. Peak heap is the most `heapUsed` rose
above a forced-GC baseline while the batch ran, so it needs `--expose-gc` to mean anything.

**A gap smaller than the wider driver's own run-to-run spread is not a result**, and the script says
so on the line rather than leaving a reader to read one off the medians.

## Results

Node v24.15.0, `postgrejs` 3.10.1, `pg` 8.23.0, PostgreSQL on loopback, median of 9 repeats.

| Scenario                                  | node-postgres | this driver  |         | Peak heap        |
| ----------------------------------------- | ------------- | ------------ | ------- | ---------------- |
| point read - one row by primary key       | 0.270 ms      | 0.263 ms     | level   | 6.2 / 7.3 MB     |
| page of 200 - nine columns, mixed types   | 0.852 ms      | 0.876 ms     | level   | 21.6 / 17.8 MB   |
| insert returning - six parameters         | 0.359 ms      | 0.348 ms     | level   | 4.2 / 5.6 MB     |
| concurrent reads - 20 at once, pool of 10 | 1.472 ms      | 1.414 ms     | level   | 7.8 / 8.5 MB     |
| `int4[]` of 100k - one array column       | 26.363 ms     | **12.502 ms**| **2.1x**| **73.4 / 6.0 MB**|
| `bytea` of 4MB - one binary column        | 89.877 ms     | **31.519 ms**| **2.9x**| 0.6 / 0.4 MB     |

## Reading them

**The ordinary shapes are level.** A point read, a page of rows, an insert with parameters, twenty
reads at once - on each of those the two drivers land inside one another's run-to-run spread, and
which one leads changes between runs. Nothing here is worth switching a driver for, and nothing here
is a cost of switching either.

**The separation is on payload.** PostgreJS reads these columns in PostgreSQL's binary format where
`pg` reads them as text, and that shows up twice over:

- On the wire. A `bytea` costs exactly twice as much as text - `\x`-prefixed hex, two characters per
  byte - so the 4MB column is 4MB rather than 8MB. An `int4[]` depends on the values: binary spends a
  fixed 8 bytes per element where text spends one byte per digit, so full-width integers favour
  binary.
- In the heap. The 100k-element array peaks at 6.0MB here against 73.4MB - the text path materialises
  the whole array literal as a string and parses it, where the binary path reads elements out of the
  buffer it already has.

**Where it reaches you.** Through drizzle, these are `bytea` columns, array columns, and anything
large in a raw `db.execute()`. A schema of text, integers and timestamps will see the first four
rows of that table and nothing more.

The client underneath has its own benchmark suite against `pg` and `postgres.js`, on more scenarios
than this - COPY, cursors, pooling, pipelining - in
[`postgrejs/doc/BENCHMARKS.md`](https://github.com/panates/postgrejs/blob/master/doc/BENCHMARKS.md).
