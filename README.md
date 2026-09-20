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

`drizzle-orm` (>=0.44.6 <0.46.0) and `postgrejs` (>=3.6.1) are peer dependencies.

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

### Why `unknownTypesAsString` is on

PostgreJS asks for binary on every column and has a decoder for the types it knows. A type it does
not know - an enum, a composite, an extension type - would arrive as a `Buffer` nothing can read, so
a schema with a single `pgEnum` would silently return bytes. With the option on, exactly those
columns are asked for as text and arrive as the string PostgreSQL would have printed, which is what
`pg` gives for the same column.

It is not free: result format codes are positional, so the column types have to be known before the
Bind that asks for them, and a statement that has not been prepared yet is prepared on first sight -
one extra round trip per distinct statement per connection. Turn it off if you know every type in
your schema has a decoder.

### Why some types are fetched as text

Drizzle's column mappers are written against what `pg` hands them, and `pg` asks for text and leaves
most of these as strings. PostgreJS decodes them into richer JavaScript values, which is better in
general and wrong here - `numeric` would arrive as a `number` that has already lost its digits,
`timestamp` as a `Date` read in the local zone rather than UTC, `date` in string mode a day early,
and `interval` and `time` as an `Interval` and a `Date` where drizzle's own columns do nothing to
them and a string was meant.

So these are asked for as text: `int8`, `numeric`, `date`, `timestamp`, `timestamptz`, `time`,
`interval`, `point`, `line`, and their array forms. The list is exported as `FETCH_AS_STRING` if you
want to see it; `fetchAsString` in the config adds to it rather than replacing it.

Asking the server is what makes this exact rather than approximately right: the string is
PostgreSQL's own rendering, so it cannot drift from what `pg` received. A decoder written on this
side could not be - the text form of the date and time types is decided by the session's
`DateStyle`, `IntervalStyle` and `TimeZone`, which the client does not track.

### Why parameter types are left to the server

PostgreJS derives an OID for each parameter from the value it is given, so a plain string is declared
`varchar` and PostgreSQL stops inferring the type from where the parameter lands. That is fatal here
rather than inconvenient, because drizzle stringifies nearly everything before the driver sees it -
`json` and `jsonb` through `JSON.stringify`, arrays through `makePgArray`, `numeric` and `bigint`
through `String`, `timestamp` and `date` through `toISOString`. Left alone, an ordinary insert fails
with `column "x" is of type json but expression is of type character varying`.

Strings, numbers, booleans, bigints and nulls therefore go out as `BindParam(0, value)` - OID 0,
"unspecified", which is what `pg` sends. A `Date`, a `Buffer`, a JS array and a plain object keep
PostgreJS's own typed binary encoder, because their JS text form is not something the server could
parse out of context.

### Why `rollbackOnError` is off

PostgreJS wraps each statement inside a transaction in a savepoint of its own by default, so a failed
statement leaves the transaction usable. That is neither PostgreSQL's own rule nor what a drizzle
user expects, so this driver turns it off: a failed statement aborts the block, exactly as under
`pg`.

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
- **Ranges decode.** `int4range` and the rest come back as PostgreJS's `Range`, where `pg` gives the
  text. Drizzle has no range column, so nothing it owns reads them either way.
- **`connectionString` is translated.** It is `pg`'s spelling and not one of PostgreJS's options;
  passed straight through it would be ignored and you would quietly get `localhost:5432/postgres`, so
  this driver translates it instead.

Multi-statement `db.execute()` works, which needs saying because it nearly did not: `pg` takes
several statements in one call because a parameterless query goes over the simple protocol, and
PostgreJS's `query()` is always the extended one. The driver falls back to PostgreJS's `execute()`
when the server says so, which is safe because it says so while parsing, before anything has run.

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
