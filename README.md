# drizzle-postgrejs

A [Drizzle ORM](https://orm.drizzle.team) driver for
[PostgreJS](https://github.com/panates/postgrejs) - run a Drizzle schema on PostgreJS's
wire-protocol client instead of `pg`.

Everything above the driver is unchanged: the query builder, relational queries, schema and
migrations are drizzle's, and the same code runs either way. What changes is underneath.

## Install

```sh
npm install drizzle-postgrejs drizzle-orm postgrejs
```

`drizzle-orm` (>=0.44.6 <0.46.0) and `postgrejs` (>=3.10.1) are peer dependencies.

## Usage

```ts
import { drizzle } from 'drizzle-postgrejs';

const db = drizzle('postgres://localhost:5432/mydb');

await db.select().from(users).where(eq(users.name, 'ada'));
```

Four ways to say where the database is, the same four `drizzle-orm/node-postgres` takes:

```ts
drizzle('postgres://localhost:5432/mydb');            // a connection string
drizzle({ connection: 'postgres://…' });              // the same, named
drizzle({ connection: { host, port, database } });    // PostgreJS's own options
drizzle(pool);                                        // a Pool you made yourself
```

A pool this package opened is on `db.$client`, and closing it is `await db.$client.close()`. A
`Connection` works in place of a `Pool` when one connection is what you want.

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

## Config

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

## What you get

**Large columns arrive about twice as fast, on a fraction of the memory.** PostgreJS reads results in
PostgreSQL's binary format where `pg` reads them as text. Measured through drizzle, on the same
server, alternating between the two drivers in one run:

| Scenario                            | node-postgres | this driver | Peak heap             |
| ----------------------------------- | ------------- | ----------- | --------------------- |
| `int4[]` of 100k, one array column  | 26.4 ms       | **12.5 ms** | 73.4 MB -> **6.0 MB** |
| `bytea` of 4MB, one binary column   | 89.9 ms       | **31.5 ms** | 0.6 MB -> 0.4 MB      |

**Half the bytes on the wire for binary columns.** `pg` reads a `bytea` as `\x`-prefixed hex, two
characters per byte, so a 4MB column costs 8MB of network. Here it costs 4MB. On metered egress that
is the same saving again, on every row that carries one.

**Ordinary queries cost you nothing.** A point read, a page of two hundred mixed-type rows, an insert
with parameters, twenty reads at once over a pool - on each of those the two drivers land inside one
another's run-to-run spread, and which one leads changes between runs.
[`doc/BENCHMARKS.md`](doc/BENCHMARKS.md) has the method, the spreads and the script that produced
them.

**Your statements are prepared and reused without being asked for.** PostgreJS keeps a cache of named
statements per connection (64 by default, least-recently-used closed), so the SQL drizzle sends is
parsed once and executed by name after that. Run three queries and the connection holds one prepared
statement; the same three through `drizzle-orm/node-postgres` leave none, because `pg` prepares only
a query it was given a name for and drizzle does not give it one. Drizzle's own `.prepare(name)`
still works as it always did - it is no longer the only way to get a statement prepared.

**A client that can do what drizzle has no way to ask for.** All of it on the pool you passed in, or
on `db.$client`, over the same connections your queries use:

- **cursors and streaming** through real portals, and `COPY` in and out - including PostgreSQL's
  binary `COPY` format, which needs a binary encoder per type that `pg` has no equivalent for;
- **`LISTEN`/`NOTIFY`**, large objects, and logical replication;
- **pipelining**, which closes a batch of statements with one round trip.

**Types that arrive as types.** A range comes back as a `Range`, and `path`, `polygon`, `circle`,
`box` and `lseg` as their own classes, where `pg` leaves you the text and the parser to write.
Drizzle has no column for any of these, so they reach you through a raw `db.execute()` - and through
`db.$client`, where PostgreJS's own options are open to you: `Temporal` values that keep the
microseconds a `Date` cannot hold, and exact decimal strings for `numeric` and `money` built while
decoding rather than re-parsed afterwards.

**More to go on when something goes wrong.** `db.execute()` results carry the server's whole command
tag, so a `CREATE INDEX` says so rather than `CREATE`. A `DatabaseError` carries the line of SQL the
server objected to and its position as a number. A pooled connection that dies arrives as a
`ConnectionLostError` - SQLSTATE `08006`, carrying the backend's process id and the socket error as
its `cause`.

**Held to drizzle's own suite.** `integration-tests/tests/pg/pg-common.ts` from the drizzle-orm
repository runs here with nothing skipped, against this driver and against
`drizzle-orm/node-postgres` on the same server in the same invocation - 183 of 183 on each. See
[drizzle's own test suite](#drizzles-own-test-suite).

**Nothing to change to try it.** The same four `drizzle()` forms, the same `DATABASE_URL`, the same
schema and queries. The list below is everything that is not identical.

## Differences from `drizzle-orm/node-postgres`

Small, and all of them measured.
[`doc/MIGRATING-FROM-NODE-POSTGRES.md`](doc/MIGRATING-FROM-NODE-POSTGRES.md) is the checklist;
[`doc/DRIVER-DESIGN.md`](doc/DRIVER-DESIGN.md) has the numbers behind it.

- **`db.execute()` results carry a `commandTag`.** `pg` keeps the first word of the server's command
  tag, so four kinds of `CREATE` and four kinds of `DROP` are one word each. `command` matches `pg`
  for compatibility; `commandTag` is the whole tag - `CREATE INDEX` rather than `CREATE`.
- **`fields` is PostgreJS's**, with `fieldName` and `dataTypeId` rather than `pg`'s `name` and
  `dataTypeID`, plus the JS type and whether the column is an array.
- **Errors are PostgreJS's `DatabaseError`.** Every structured field you would branch on is the
  same: `code`, `severity`, `detail`, `hint`, `schema`, `table`, `column`, `constraint`. `position`
  is a number where `pg` gives a string, and `line` means something else on each side - `pg`'s is
  PostgreSQL's own C source line, PostgreJS's is the line of SQL. `instanceof` against `pg`'s class
  does not hold.
- **Some types arrive decoded where `pg` leaves you the text to parse.** Ranges come back as
  PostgreJS's `Range`, `money` as a number rather than `"$12.34"`, and `path`, `polygon`, `circle`,
  `box` and `lseg` as their own classes. Drizzle has no column for any of them, so they reach you
  only through a raw `db.execute()` - where the decoded value is the one you would have written the
  parser for. `point` and `line`, which drizzle *does* have columns for, are asked for as text and
  come out exactly as under `pg`.
- **`connectionString` is accepted.** `pg`'s spelling is translated into PostgreJS's own options, so
  a `DATABASE_URL` and the rest of an existing `node-postgres` setup move over unchanged.

Multi-statement `db.execute()` works here too, and it is worth knowing how: `pg` takes several
statements in one call because a parameterless query goes over the simple protocol. This driver
reaches the same place through PostgreJS's `execute()`, and switches to it on the server's own word -
which the server gives while parsing, before any statement has run, so the retry costs nothing and
risks nothing.

## drizzle's own test suite

`integration-tests/tests/pg/pg-common.ts` in the drizzle-orm repository is a shared suite every
driver drizzle ships points at itself, declaring what it cannot pass through `skipTests()`.
`scripts/run-drizzle-suite.sh` runs it here with no skips at all, twice - once on this driver and
once on `drizzle-orm/node-postgres` - and fails only on a test this driver loses that the control
wins:

```sh
scripts/run-drizzle-suite.sh
```

```
  node-postgres (control)  183 / 183
  drizzle-postgrejs        183 / 183
```

The control run is the point. The suite asserts row order in three places without writing an
`ORDER BY`, so its score moves with the PostgreSQL version - 183 of 183 on the 14 its own
`createDockerDB()` pins, 180 of 183 on 18, for both drivers alike. A fixed expected-failure count
would be wrong on one of them.

On drizzle-orm 0.44.6, the other end of the peer range, the suite is 179 tests and both score 179.

It needs a server; without `PG_CONNECTION_STRING` it starts a `postgres:14` container on a free port
and removes it afterwards. A weekly CI job runs the matrix of both drizzle versions against
PostgreSQL 14 and 18.

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

Pre-1.0, and complete enough to use. Selects, inserts, updates, deletes, RETURNING, relational
queries, joins, transactions, savepoints, prepared statements and `db.execute()` all work against a
live server, and drizzle's own suite passes in full on the PostgreSQL version it is written for, with
nothing skipped.

Drizzle itself is pre-1.0 and its 1.0 line rewrites the driver seam - `PgPreparedQuery` becomes
`PgBasePreparedQuery`, row mode moves from a flag to a method, and type handling becomes a per-driver
codec table. This package targets the 0.45 line; a 1.0 driver will be a rewrite rather than an
adaptation. [`doc/DRIVER-DESIGN.md`](doc/DRIVER-DESIGN.md) §10 has the detail.

## License

BSD-3-Clause
