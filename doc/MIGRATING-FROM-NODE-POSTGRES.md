# Migrating from `drizzle-orm/node-postgres`

Two lines of code, and a short list of things to check. Everything above the driver - the schema,
the query builder, relational queries, migrations, the generated SQL - is drizzle's and does not
change.

## The two lines

```diff
-import { drizzle } from 'drizzle-orm/node-postgres';
-import { Pool } from 'pg';
+import { drizzle } from 'drizzle-postgrejs';
+import { Pool } from 'postgrejs';

 const db = drizzle(new Pool({ connectionString: process.env.DATABASE_URL }), { schema });
```

`{ connectionString }` is `pg`'s spelling rather than PostgreJS's, so `new Pool({ connectionString })`
opens a pool on `localhost:5432/postgres` without complaining. Either pass the string as the first
argument, `new Pool(url)`, or let this package open the pool - it translates the `pg` spelling:

```ts
const db = drizzle({ connection: { connectionString: process.env.DATABASE_URL! }, schema });
```

If you typed the handle, `NodePgDatabase` becomes `PgjsDrizzle`:

```diff
-import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
-let db: NodePgDatabase<typeof schema>;
+import type { PgjsDrizzle } from 'drizzle-postgrejs';
+let db: PgjsDrizzle<typeof schema>;
```

`PgjsDatabase<typeof schema>` exists too and is the closer analogue of `NodePgDatabase`, but like it
does not carry `$client` - `PgjsDrizzle` is that plus the client, which is what `drizzle()` returns.

Then drop `pg` and `@types/pg` from `package.json`, unless something else uses them.

## What comes out the same

The values. That is the point of the exercise, and it is the part with the most work behind it: a
differential test suite runs the same drizzle calls through both drivers and compares the rows, and
drizzle's own PostgreSQL integration suite runs against both on the same server in the same
invocation. Selects, inserts, RETURNING, relational queries, joins, aggregates, transactions,
savepoints, prepared statements - same types, same values, same `null`s.

That includes the awkward ones: `numeric` keeps every digit, `timestamp` is the same instant,
`date` in string mode does not shift a day, `interval` and `time` are strings, `point` is a plain
`{ x, y }`, and an array keeps its empty-string elements.

Enums work with nothing registered anywhere.

## What to check

**Errors.** They are PostgreJS's `DatabaseError`, so `instanceof` against `pg`'s class does not hold.
Everything you would branch on is the same - `code`, `severity`, `detail`, `hint`, `schema`, `table`,
`column`, `constraint` - and drizzle still wraps them in `DrizzleQueryError` with the driver error as
`cause`. Three fields differ:

| field | `pg` | this driver |
| --- | --- | --- |
| `position` | `"8"`, a string | `8`, a number |
| `line` | PostgreSQL's own C source line | the line of SQL the error points at |
| `file`, `routine` | the server's source file and function | absent; `lineNr` and `colNr` instead |

`line` is the one to grep for: the same name means something else on each side and nothing fails
loudly.

**`db.execute()` results.** `command`, `rowCount` and `rows` are identical, including `rowCount` for
a SELECT and `null` for a command that carries no count. Two additions and one difference:

- `commandTag` is new - the server's whole tag, where `pg`'s `command` keeps only the first word.
  `CREATE INDEX` rather than `CREATE`.
- `fields` is PostgreJS's `FieldInfo[]`: `fieldName` and `dataTypeId` rather than `name` and
  `dataTypeID`, plus `jsType` and `isArray`. Code reading `fields[i].name` needs changing.
- `pg`'s other `Result` properties (`oid`, `_parsers`, `_types`, `RowCtor`) are not there.

**Ranges.** `int4range` and the rest come back as PostgreJS's `Range` object rather than the text
`pg` gives. Drizzle has no range column, so this only reaches you through a raw `db.execute()`.

**`pg`-specific configuration.** Pool sizing, SSL, timeouts and the rest are PostgreJS's options now,
not `pg`'s - the names differ. `PoolConfiguration` in PostgreJS's own documentation is the list.

## What you gain, and what it costs

PostgreJS speaks the wire protocol with no native bindings, decodes the built-in types in binary, and
caches prepared statements per connection by itself.

Two things this driver does that cost a little: every query carries a `fetchAsString` list, because
drizzle's column mappers are written against `pg`'s text shapes; and `unknownTypesAsString` prepares
a statement on first sight so that a type PostgreJS cannot decode can be asked for as text. That is
one extra round trip per distinct statement per connection, and it is what makes enums work without
being registered. Both are explained in the README, and `unknownTypesAsString: false` turns the
second off if you know your schema does not need it.

## Multi-statement `db.execute()`

Works, and nearly did not. `pg` accepts several statements in one call because a parameterless query
goes over PostgreSQL's simple protocol; PostgreJS's `query()` is always the extended one, which takes
a single statement. The driver retries through PostgreJS's `execute()` when the server says so, which
is safe because the server says so while parsing, before any of the statements has run. The result is
a bare array, one entry per statement, as `pg` returns it.
