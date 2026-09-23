# drizzle-postgrejs

[![NPM Version][npm-image]][npm-url]
[![NPM Downloads][downloads-image]][downloads-url]
[![CI Tests][ci-test-image]][ci-test-url]
[![Test Coverage][coveralls-image]][coveralls-url]

A [Drizzle ORM](https://orm.drizzle.team) driver for
[PostgreJS](https://github.com/panates/postgrejs). Put it where `drizzle-orm/node-postgres` goes and
everything above it stays the same - your schema, your queries, your migrations. Large columns come
back two to three times faster on a fraction of the heap, and the client underneath can do things
drizzle has no way to ask for.

## Install

```sh
npm install drizzle-postgrejs drizzle-orm postgrejs
```

`drizzle-orm` (>=0.44.6 <0.46.0) and `postgrejs` (>=3.10.1 <4) are peer dependencies. Node >=22,
PostgreSQL 14 or later - 14 and 18 are what CI runs.

## Quick start

```ts
import { drizzle } from 'drizzle-postgrejs';

const db = drizzle('postgres://localhost:5432/mydb');

await db.select().from(users).where(eq(users.name, 'ada'));
```

That is the whole change.

## Usage

### Connecting

Four ways to say where the database is, the same four `drizzle-orm/node-postgres` takes:

```ts
drizzle('postgres://localhost:5432/mydb'); // a connection string
drizzle({ connection: 'postgres://…' }); // the same, named
drizzle({ connection: { host, port, database } }); // PostgreJS's own options
drizzle(pool); // a Pool you made yourself
```

A pool this package opened is on `db.$client`, and closing it is `await db.$client.close()`. A
`Connection` works in place of a `Pool` when one connection is what you want.

### Queries

Relational queries need the schema, as usual:

```ts
const db = drizzle(pool, { schema });

await db.query.users.findMany({ with: { posts: true } });
```

Transactions hold one connection for the whole block and give it back however it ends, and a nested
transaction is a savepoint:

```ts
await db.transaction(async tx => {
  await tx.insert(users).values({ name: 'ada' });
  await tx.transaction(async inner => {
    await inner.insert(posts).values({ userId: 1, title: 'one' });
  });
});
```

Everything drizzle's interface does not reach - COPY, LISTEN/NOTIFY, cursors, large objects, logical
replication - is still there on the PostgreJS pool you passed in, or on `db.$client`.

### Options

Drizzle's own options (`schema`, `logger`, `casing`, `cache`) work as they do on any driver. These
are this driver's:

| Option                 | Default          | What it does                                                        |
| ---------------------- | ---------------- | ------------------------------------------------------------------- |
| `unknownTypesAsString` | `true`           | Ask the server for text on any column PostgreJS has no decoder for   |
| `fetchAsString`        | `[]`             | Extra OIDs to fetch as text, on top of the ones drizzle needs        |
| `prepare`              | PostgreJS's own  | `false` keeps statements out of PostgreJS's prepared statement cache |

The defaults are set so that every column reaches drizzle in the shape its own column mappers were
written for, and so that PostgreSQL types each parameter from where it lands rather than from the
JavaScript value's own shape. [`doc/DRIVER-DESIGN.md`](doc/DRIVER-DESIGN.md) takes each one in turn,
with the measurement behind it.

### Migrations

`drizzle-kit generate` needs nothing from this package - it reads your schema files and writes SQL.
Applying them is `migrate()`, the same call `drizzle-orm/node-postgres/migrator` exposes, reaching
drizzle's own runner through this driver:

```ts
import { migrate } from 'drizzle-postgrejs';

await migrate(db, { migrationsFolder: './drizzle' });
```

`drizzle-kit migrate` and `drizzle-kit push` are the other way to apply them, and they connect on
their own rather than through a driver - `drizzle-kit` reaches for `pg` for a `postgresql` dialect
and has no seam a third-party driver can enter. So they need their own `dbCredentials` in
`drizzle.config.ts`, and nothing about that changes when the application switches driver.

## Why

It is a drop-in swap for `drizzle-orm/node-postgres`: the same `drizzle(client)` call, the same
schema, the same queries, the same migrations. What you get for it:

- **Faster where the payload is large** - 2.2x on a 100k-element array column and 3.2x on a 4MB
  `bytea`, on a fraction of the heap, because the values arrive in PostgreSQL's binary format rather
  than as text to be parsed.
- **Slightly faster on ordinary round trips**, repeatably - statements are prepared and reused
  without anyone asking for it.
- **A client that can do what drizzle has no way to ask for** - cursors, `COPY`, `LISTEN`/`NOTIFY`,
  large objects, logical replication and pipelining, on the same pool your queries use.
- **Checked against drizzle's own integration suite** - 183 of its tests pass, with
  `drizzle-orm/node-postgres` run over the same server in the same invocation as the control.

| Workload                                  | node-postgres | drizzle-postgrejs | speedup   |
| ----------------------------------------- | ------------- | ----------------- | --------- |
| point read - one row by primary key       | 0.521 ms      | 0.466 ms          | **1.12x** |
| insert returning - six parameters         | 0.559 ms      | 0.535 ms          | **1.04x** |
| page of 200 - nine columns, mixed types   | 1.092 ms      | 1.110 ms          | level     |
| concurrent reads - 20 at once, pool of 10 | 2.737 ms      | 2.459 ms          | level     |
| `int4[]` of 100k - one array column       | 28.526 ms     | 13.223 ms         | **2.16x** |
| `bytea` of 4MB - one binary column        | 111.767 ms    | 35.113 ms         | **3.18x** |

drizzle-orm 0.45.3, PostgreSQL on loopback, Node 24. Medians; how that was measured and how much
each row can bear are in [How the numbers were measured](#how-the-numbers-were-measured).

**The gain follows the payload, not the query.** An ordinary read or write gains a little and gains
it consistently; a column that carries bulk - an array, a `bytea`, anything large in a raw
`db.execute()` - gains twice over, in time and in memory. A schema of text, integers and timestamps
will see the top of that table and not the bottom. What earns each row is under the method below.

## How the numbers were measured

Both drivers run in one process and alternate inside every pair, with the order swapped each time, so
neither gets a warmer machine than the other. Each figure above is a median of 101 pairs, or 61 and
41 for the heavier workloads.

The medians alone would not be worth much: this is a shared machine, and the absolute figures drift -
the same `node-postgres` point read came out at 0.270 ms and 0.521 ms in two runs an hour apart. What
does not drift is *which* of the two won each pair, so that is counted separately:

| Workload                                  | pairs | drizzle-postgrejs faster in | odds of that by luck |
| ----------------------------------------- | ----- | --------------------------- | -------------------- |
| point read - one row by primary key       | 101   | 75                          | < 1 in 10^5          |
| insert returning - six parameters         | 101   | 68                          | < 1 in 10^3          |
| page of 200 - nine columns, mixed types   | 101   | 49                          | not distinguishable  |
| concurrent reads - 20 at once, pool of 10 | 61    | 31                          | not distinguishable  |
| `int4[]` of 100k - one array column       | 41    | 41                          | < 1 in 10^12         |
| `bytea` of 4MB - one binary column        | 41    | 41                          | < 1 in 10^12         |

That is a sign test - only which driver won counts, and by how much is thrown away, which is exactly
what makes it survive a noisy machine. Two drivers of equal speed would split the pairs evenly, so
the last column is the probability of seeing a split that lopsided from a fair coin. It says which
differences are real; it says nothing about their size, which is what the speedup column is for. Two
rows say "not distinguishable" and are printed that way rather than rounded into a win.

Result columns arrive in PostgreSQL's binary format and are decoded per type, where `pg` asks for
text and parses it. On bulk that is the whole difference: a 100k-element `int4[]` costs 13.2 ms and
1.7 MB of heap here against 28.5 ms and 65.2 MB, because the text path has to materialise the array
literal as one string before it can parse it.

It is also cheaper on the wire. A `bytea` in text is `\x`-prefixed hex, two characters per byte, so
the 4MB column costs 8MB of network under `pg` and 4MB here.

PostgreJS names and caches a statement per connection - 64 by default, least-recently-used closed -
so each distinct SQL string is parsed and planned once rather than on every call. Counted from the
backend: three queries through this driver leave one prepared statement behind, and the same three
through `drizzle-orm/node-postgres` leave none, because `pg` prepares only a query it was given a
name for and drizzle does not give it one. This is what the point read's 75 pairs of 101 is.

Drizzle's own `.prepare(name)` still works as it always did - it is no longer the only way to get a
statement prepared.

Where drizzle's column mappers want PostgreSQL's own text - `numeric`, the date and time family, and
their array forms - PostgreJS asks the *server* for text, as a Bind format code, rather than decoding
the value and printing it again. So the string is PostgreSQL's own and cannot drift from what `pg`
received, and nothing on this side has to track the session's `DateStyle`, `IntervalStyle` or
`TimeZone` to produce it.

PostgreJS can put several statements on one connection at a time. This driver does not ask it to -
every query gets a connection to itself, exactly as under `pg` - and the concurrency row above is
level because of that, not despite it. The headroom is real and unclaimed.

Run it yourself with `npm run bench`; [`doc/BENCHMARKS.md`](doc/BENCHMARKS.md) has the peak-heap
figures and the rest of the method.

## Tested against drizzle's own suite

`integration-tests/tests/pg/pg-common.ts` in the drizzle-orm repository is a shared suite every
driver drizzle ships points at itself, declaring what it cannot pass through `skipTests()`.
`scripts/run-drizzle-suite.sh` runs it here with no skips at all, twice - once on this driver and
once on `drizzle-orm/node-postgres` over the same server in the same invocation, as the control:

```
  node-postgres (control)  183 / 183
  drizzle-postgrejs        183 / 183
```

Same tests, and both pass every one of them: **not a single test that this driver loses and
`node-postgres` wins.** There is no expected-failure list either - the control run measures the
baseline on your machine, so that is the only thing the comparison can fail on. It has to be a
control rather than a number: the suite asserts row order in three places without writing an
`ORDER BY`, so its score moves with the PostgreSQL version - 183 of 183 on the 14 its own
`createDockerDB()` pins, 180 of 183 on 18, for both drivers alike.

On drizzle-orm 0.44.6, the other end of the peer range, the suite is 179 tests and both score 179.

Run it yourself with `scripts/run-drizzle-suite.sh`. It needs a server; without
`PG_CONNECTION_STRING` it starts a `postgres:14` container on a free port and removes it afterwards.
A weekly CI job runs the matrix of both drizzle versions against PostgreSQL 14 and 18.

On top of that, 203 tests of this package's own - and a differential suite among them that runs every
case through `drizzle-orm/node-postgres` as well and compares the two.

## What changes when you switch

Measured against `drizzle-orm/node-postgres` on the same schema and the same server.
[`doc/MIGRATING-FROM-NODE-POSTGRES.md`](doc/MIGRATING-FROM-NODE-POSTGRES.md) is the checklist.

### Values

Drizzle has a column for none of these, so they reach you only through a raw `db.execute()`.

| case                                  | `node-postgres`         | `drizzle-postgrejs`      |
| ------------------------------------- | ----------------------- | ------------------------ |
| `money`                               | `"$12.34"`              | `12.34`                  |
| `int4range` and the rest of the family | `"[1,5)"`              | a `Range`                |
| `path`, `polygon`, `box`, `lseg`      | the text literal        | their own classes        |
| `circle`                              | `{ x, y, radius }`      | a `Circle` - same fields |
| `point`                               | `{ x, y }`              | the text `"(1,2)"`       |
| `line`                                | `"{1,2,3}"`             | the same                 |

`point` is the one that runs the other way, and on purpose: drizzle's own `point` column hands the
driver's value back untouched, so a class instance would reach the caller where `pg` gives a plain
object. It is asked for as text instead and drizzle parses it - which is why **through drizzle's
columns both drivers answer `[1, 2]` and `[1, 2, 3]`**, identically, and the difference above exists
only in a raw execute.

Everywhere else the two agree, and `test/C-differential` is what says so: the same drizzle calls
through both drivers, deep-compared. The table itself is a test - `test/C-differential/values.spec.ts`
runs every row through `pg` as well, which is how the `circle` row got corrected.

### Results

`db.execute()` results carry a `commandTag` as well as `command`. `pg` keeps only the first word of
the server's command tag, so four kinds of `CREATE` and four kinds of `DROP` are one word each;
`command` matches `pg` for compatibility and `commandTag` is the whole tag - `CREATE INDEX` rather
than `CREATE`.

`fields` is PostgreJS's, with `fieldName` and `dataTypeId` rather than `pg`'s `name` and
`dataTypeID`, plus the JS type and whether the column is an array.

### Errors

Errors are PostgreJS's `DatabaseError`. Every structured field you would branch on is the same:
`code`, `severity`, `detail`, `hint`, `schema`, `table`, `column`, `constraint`. `position` is a
number where `pg` gives a string, and `line` means something else on each side - `pg`'s is
PostgreSQL's own C source line, PostgreJS's is the line of SQL. `instanceof` against `pg`'s class
does not hold.

### Several statements in one `db.execute()`

It works here too, and it is worth knowing how: `pg` takes several statements in one call because a
parameterless query goes over the simple protocol. This driver reaches the same place through
PostgreJS's `execute()`, and switches to it on the server's own word - which the server gives while
parsing, before any statement has run, so the retry costs nothing and risks nothing.

### `connectionString`

Accepted. `pg`'s spelling is translated into PostgreJS's own options, so a `DATABASE_URL` and the
rest of an existing `node-postgres` setup move over unchanged.

## Development

The unit tests need nothing; the live and differential ones need a PostgreSQL at `127.0.0.1:5432`
(`postgres`/`postgres`, database `postgres`), which `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and
`PGDATABASE` override.

```sh
npm test          # unit, live and differential tests
npm run citest    # the same, with coverage
npm run qc        # lint and circular dependency check
npm run compile   # type check without emitting

scripts/run-drizzle-suite.sh   # drizzle's own suite, on a database of its own
```

The tests come in three kinds, and the split is deliberate:

- `test/A-common` - against fakes, no server. What SQL the driver sends, in what order, with which
  options.
- `test/B-live` - against a real server. Value shapes as an explicit table, so a change in PostgreJS's
  decoding names itself.
- `test/C-differential` - the same drizzle calls through this driver and through
  `drizzle-orm/node-postgres`, deep-compared. It is what catches a difference nobody thought to
  assert.

## Status

Complete. Selects, inserts, updates, deletes, RETURNING, relational queries, joins, transactions,
savepoints, prepared statements, migrations and `db.execute()` all work against a live server, and
drizzle's own suite passes in full on the PostgreSQL version it is written for, with nothing
skipped.

Drizzle itself is pre-1.0 and its 1.0 line rewrites the driver seam - `PgPreparedQuery` becomes
`PgBasePreparedQuery`, row mode moves from a flag to a method, and type handling becomes a per-driver
codec table. This package targets the 0.45 line; a 1.0 driver will be a rewrite rather than an
adaptation. [`doc/DRIVER-DESIGN.md`](doc/DRIVER-DESIGN.md) §10 has the detail.

## License

BSD-3-Clause

[npm-image]: https://img.shields.io/npm/v/drizzle-postgrejs
[npm-url]: https://npmjs.org/package/drizzle-postgrejs
[downloads-image]: https://img.shields.io/npm/dm/drizzle-postgrejs.svg
[downloads-url]: https://npmjs.org/package/drizzle-postgrejs
[ci-test-image]: https://github.com/panates/postgrejs-drizzle/actions/workflows/test.yml/badge.svg
[ci-test-url]: https://github.com/panates/postgrejs-drizzle/actions/workflows/test.yml
[coveralls-image]: https://img.shields.io/coveralls/panates/postgrejs-drizzle/dev.svg
[coveralls-url]: https://coveralls.io/r/panates/postgrejs-drizzle
