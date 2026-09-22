# drizzle-postgrejs

A [Drizzle ORM](https://orm.drizzle.team) driver for
[PostgreJS](https://github.com/panates/postgrejs) - run a Drizzle schema on PostgreJS's
wire-protocol client instead of `pg`.

Drizzle is the ORM where the driver is the user's to pick: `drizzle(client)` names the PostgreSQL
client, and everything above it - the query builder, the relational queries, the schema, the
migrations - is the same either way.

It is held to drizzle's own PostgreSQL integration suite, run against this driver and against
`drizzle-orm/node-postgres` on the same server in the same invocation. See
[drizzle's own test suite](#drizzles-own-test-suite).

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

### What you get by default

**Every column arrives as something you can read.** `unknownTypesAsString` is on, so an enum, a
composite, an extension type - anything PostgreJS has no decoder for - comes back as the string
PostgreSQL printed, the same value `pg` hands you. A schema can use `pgEnum` and custom types freely.
It buys that with one extra round trip the first time a connection sees a given statement, so turn it
off when every type in your schema has a decoder.

**The types drizzle maps itself keep every digit.** `int8`, `numeric`, `date`, `timestamp`,
`timestamptz`, `time`, `interval`, `point`, `line` and their array forms are asked for in
PostgreSQL's own text rendering, which is the exact value the server holds: a `numeric` past a
double's reach survives, a `timestamp` is read as UTC, a `date` is the day it says, and drizzle's
column mappers - written against these strings - get what they expect. The string is the server's
own, so it cannot drift from what `pg` received, and no client-side renderer has to guess at the
session's `DateStyle`, `IntervalStyle` or `TimeZone`. The list is exported as `FETCH_AS_STRING`, and
`fetchAsString` in the config adds to it.

**PostgreSQL types each parameter, from where it lands.** Parameters go out as OID 0,
"unspecified" - what `pg` sends - so the server resolves each one from its context: `coalesce($1, 1)`
is a number, a parameter bound into a `json` column is json, and an overloaded function picks the
overload you meant. That is what lets drizzle hand the driver the strings it prefers - `JSON.stringify`
for `json` and `jsonb`, `makePgArray` for arrays, `String` for `numeric` and `bigint`, `toISOString`
for `timestamp` and `date` - and have every one of them land as the column's own type. A `Date`, a
`Buffer`, a JS array and a plain object keep PostgreJS's typed binary encoder, which carries them
whole rather than through a text form the server would have to parse back.

**Transactions behave the way PostgreSQL defines them.** `rollbackOnError` is off, so a failed
statement aborts the block and the rollback is yours to drive - exactly as under `pg`, and exactly
what drizzle's transaction API is written against.

[`doc/DRIVER-DESIGN.md`](doc/DRIVER-DESIGN.md) has the measurements behind each of these.

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
