# Drizzle driver for PostgreJS - what the seam is, and why this driver is shaped the way it is

Why `src/` looks the way it does: which of drizzle's contract is load-bearing, which of PostgreJS's
defaults had to be overridden and what each override costs. Everything here was run against a live
server rather than read out of documentation; a claim that says "verified" has a number behind it,
and the tests under `test/` hold most of them to it.

Measured against `drizzle-orm` 0.45.3 (npm `latest`) and `drizzle-orm@rc` 1.0.0-rc.4, PostgreJS
3.10.1, and PostgreSQL 14.24 and 18.4. The recon round that opened this document ran on 0.45.2 and
PostgreJS 3.6.1, and where a number below names those, that is the run it came from. Line references
are into the `drizzle-orm` git tree at tag `0.45.2`, path prefix `drizzle-orm/src/` - 0.45.3 changed
nothing under `pg-core`.

It started as reconnaissance, before any code existed, and the shape of that round is still visible -
ten questions, then an estimate and a recommendation. It has been re-measured since, whenever what it
rested on moved: three PostgreJS defects it turned up were fixed, `stripInternal` turned out to hide
half the seam from the type system, and the peer range went from inferred to tested.

The headline is that drizzle-orm's own PostgreSQL integration suite turned out to be reusable, so
this driver is held to the same 183 tests `drizzle-orm/node-postgres` is, on the same server, in the
same run - see §9 and `scripts/run-drizzle-suite.sh`.

---

## 1. The seam

A third-party PostgreSQL driver subclasses three abstract classes and nothing else:

| Class | Declared at | Driver subclass |
| --- | --- | --- |
| `PgPreparedQuery<T>` | `pg-core/session.ts:20` | `NodePgPreparedQuery`, `node-postgres/session.ts:21` |
| `PgSession<HKT, TFull, TSchema>` | `pg-core/session.ts:168` | `NodePgSession`, `node-postgres/session.ts:201` |
| `PgTransaction<HKT, TFull, TSchema>` | `pg-core/session.ts:236` | `NodePgTransaction`, `node-postgres/session.ts:278` |

plus two type-level pieces: `PgQueryResultHKT` (`pg-core/session.ts:284`), which is how the driver
declares what `db.execute()` resolves to, and `PgDatabase` (`pg-core/db.ts`), subclassed only to
brand the type (`node-postgres/driver.ts:43-47`). `PgDialect` is **used, never subclassed** -
`node-postgres/driver.ts:58` constructs the stock one.

**Every import `node-postgres/session.ts` and `driver.ts` make is reachable through a declared
`exports` subpath.** Verified against the published 0.45.2 `package.json`:

| Needed | Subpath |
| --- | --- |
| `PgSession`, `PgPreparedQuery`, `PgTransaction`, `PgDialect`, `PgDatabase`, `PgQueryResultHKT`, `PgTransactionConfig`, `PreparedQueryConfig` | `drizzle-orm/pg-core` (re-exported by `pg-core/index.ts:14`, `:4`, `:5`) |
| `entityKind`, `sql`, `fillPlaceholders`, `Query`, `SQL` | `drizzle-orm` |
| `mapResultRow`, `Assume`, `DrizzleConfig`, `isConfig` | `drizzle-orm/utils` |
| `Logger`, `NoopLogger`, `DefaultLogger` | `drizzle-orm/logger` |
| `Cache`, `NoopCache`, `WithCacheConfig` | `drizzle-orm/cache/core`, `drizzle-orm/cache/core/types` |
| `tracer` | `drizzle-orm/tracing` |
| `SelectedFieldsOrdered` | `drizzle-orm/pg-core/query-builders/select.types` |
| relational config helpers | `drizzle-orm/relations` |

**There is no deep-import requirement, in either the 0.45 line or the 1.0 line** (1.0-rc.4 publishes
718 subpaths, including `./pg-core/async/session`, `./pg-core/codecs` and `./query-name-generator`,
which is what its own `node-postgres` driver imports). This is the single biggest way the task's
opening assumption was wrong, and it is wrong in our favour.

**The churn risk is in the types, and it is worse than the export map suggests.** Several members a
driver must use are marked `/** @internal */`, and drizzle's `.d.ts` files are built with
`stripInternal` - so they exist at runtime and are *absent from the published types*. Found by
compiling against them, not by reading the source:

| needed | declared in `node_modules/drizzle-orm` |
| --- | --- |
| `tracer` | no - `tracing.d.ts` is `export {}`, while `tracing.js` exports it |
| `mapResultRow` | no - gone from `utils.d.ts` |
| `PgPreparedQuery.queryWithCache`, `.joinsNotNullableMap` | no |
| `PgPreparedQuery.all`, `.isResponseInArrayMode` | no - only `execute` survives of its four abstract members |
| `PgTransaction.getTransactionConfigSQL`, `.dialect`, `.session` | no |

`drizzle-orm/node-postgres` never meets this: it is compiled inside drizzle's monorepo, from source,
where nothing is stripped. Any driver outside it has to restate those shapes. This package keeps all
of them in one file, `src/drizzle-internals.ts`, so the blast radius of a drizzle upgrade is one
import list rather than five call sites - and so the size of the unsupported surface is countable.
It matters for the peer range in §10: the *typed* seam is narrower than the exported one, and nothing
in drizzle's release process would flag a change to it.

## 2. The session surface

Exactly nine members. Nothing else is abstract.

**`PgPreparedQuery<T>`** - constructor `(query: Query, cache: Cache | undefined, queryMetadata, cacheConfig)`
(`pg-core/session.ts:21-40`).

- `execute(placeholderValues?): Promise<T['execute']>` (`:149`). Two return shapes, chosen by the
  driver at `node-postgres/session.ts:141`: with neither `fields` nor `customResultMapper`, **the
  raw driver result object, passed through untouched** (`:149`); otherwise **an array of mapped
  rows** (`:165-169`), either `customResultMapper(rows)` or `rows.map(row => mapResultRow(fields, row, joinsNotNullableMap))`.
- `all(placeholderValues?): Promise<T['all']>` (`:156`). Always object rows, returns `result.rows`
  (`node-postgres/session.ts:173-188`). Only reached through `PgSession.all()` (`pg-core/session.ts:209-216`).
- `isResponseInArrayMode(): boolean` (`:159`). Returns the flag `prepareQuery` was handed; the driver
  stores and echoes it (`node-postgres/session.ts:191-193`).
- Inherited and **not** to be overridden: `getQuery()` (`:44`), `mapResult()` (`:48`), `setToken()` (`:53`),
  `queryWithCache()` (`:64`).

**`PgSession`** - constructor `(dialect: PgDialect)`.

- `prepareQuery(query, fields, name, isResponseInArrayMode, customResultMapper?, queryMetadata?, cacheConfig?): PgPreparedQuery<T>`
  (`:177-188`). Synchronous; just constructs the prepared query (`node-postgres/session.ts:221-246`).
- `transaction(fn, config?): Promise<T>` (`:230`). The only truly abstract method with behaviour.
- `count(sql)` (`:218-228`) - inherited, but `node-postgres` **overrides** it (`node-postgres/session.ts:270-275`)
  because the base reads `res[0]['count']` while `db.execute()` on this driver resolves to an object
  with a `rows` property, so the override reads `res['rows'][0]['count']`. A driver whose `execute()`
  returns a pg-shaped result must override it the same way.

**`PgTransaction`** - `transaction(fn)` (`:279`) only; `rollback()`, `getTransactionConfigSQL()` and
`setTransaction()` are inherited (`:256`, `:261`, `:275`).

Prepared queries are **not** a separate type from the driver's point of view: `.prepare(name)` on a
query builder simply passes `name` through to `prepareQuery`, and `node-postgres` forwards it to pg
as a named statement (`node-postgres/session.ts:45`, `:88`). PostgreJS caches prepared statements per
connection automatically, so the name has no natural counterpart - see §4 and decision D4.

## 3. Row shape

**Both, and it differs per method and per branch.** `node-postgres` keeps two query configs side by
side for exactly this reason: `rawQueryConfig` (`node-postgres/session.ts:44-86`, object rows) and
`queryConfig` (`:87-130`, identical but `rowMode: 'array'`).

| Call | Row mode | Why |
| --- | --- | --- |
| `execute()` with no `fields` and no `customResultMapper` | **objects** (`:149`) | the result is handed to the user verbatim |
| `execute()` otherwise | **arrays** (`:161`) | `mapResultRow` takes `row: unknown[]` and indexes positionally (`utils.ts:15-19`, `:43`) |
| `all()` | **objects** (`:184`) | returns `result.rows` unmapped |

Maps onto PostgreJS as `objectRows: true` / `false` per call. No friction; verified across 27
differential cases and the full upstream suite.

## 4. Parameter types - the expensive one, and it is worse here than under Kysely

Drizzle hands parameters over as a plain `unknown[]` positional array with `$1` placeholders and
**declares no types at all** (`node-postgres/session.ts:149`, `:161` - `client.query(config, params)`).
`fillPlaceholders` (`sql/sql.ts:612`) only substitutes named placeholders; it does not annotate.

What makes this sharper than the Kysely case is *what Drizzle puts in that array*. Its column
encoders stringify almost everything before the driver ever sees it:

- `json`/`jsonb` -> `JSON.stringify(value)` (`pg-core/columns/json.ts:44-46`, `jsonb.ts:42-44`)
- arrays -> `makePgArray(...)`, a `{a,b}` **string** (`pg-core/columns/common.ts:342-352`)
- `numeric` -> `String` (`pg-core/columns/numeric.ts:124`)
- `numeric` in `bigint` mode -> `String` (`pg-core/columns/numeric.ts:188`). Plain `bigint`
  columns are the exception: they have no `mapToDriverValue` at all, so a JS `bigint` or `number`
  reaches the driver and PostgreJS types it correctly on its own.
- `timestamp`/`date` -> `value.toISOString()` (`timestamp.ts:67-69`, `date.ts:46-48`)

So under PostgreJS's `typeMap.determine(value)` these all arrive declared `varchar`, and PostgreSQL
stops inferring. **This is not an edge case here - it is ordinary `INSERT`.** Verified, 24 query
shapes, one live connection each:

| | pg | PostgreJS raw | PostgreJS + `new BindParam(0, v)` |
| --- | --- | --- | --- |
| passed | 24/24 | **14/24** | **24/24** |

The ten raw failures: insert into `json`, `jsonb`, `numeric`, `timestamp`, `timestamptz`, `date`,
`int4[]`, `interval`, a string into `int8` (which is what `numeric`-in-`bigint`-mode and `sql`
templates produce), and `jsonb @> $1`. All ten are of the form
`column "x" is of type T but expression is of type character varying`. `BindParam(0, value)` fixes
all ten and regresses none.

`BindParam(0, …)` must be applied **selectively**, and the boundary is the same one the Kysely
dialect settled on - verified again here, one value per JS type:

| JS value | raw | `BindParam(0, v)` |
| --- | --- | --- |
| string, number, boolean, bigint, null, undefined | ok | **ok** |
| `Buffer` | ok | ok (either works) |
| `Date` | ok | **fails** - `invalid input syntax for type timestamp: "Tue Mar 05 2024 …"` |
| JS array | ok | **fails** - `malformed array literal: "1,2"` |
| plain object | ok | **fails** - `invalid input syntax for type json` |

**Settled, not a decision:** wrap `string | number | boolean | bigint | null | undefined` in
`new BindParam(0, v)`; leave `Date`, `Buffer`, arrays and objects to PostgreJS's typed binary
encoders. Drizzle's encoders mean the first group covers nearly every parameter in practice; the
second group only shows up through `sql` templates and custom types.

## 5. Transactions and savepoints

`PgSession.transaction()` is driver-implemented and sends plain SQL through its own prepared-query
path (`node-postgres/session.ts:248-268`): `begin` at `:257`, `commit` at `:260`, `rollback` at `:263`.
The isolation config is appended by the inherited `getTransactionConfigSQL()` (`pg-core/session.ts:261-273`),
which emits `isolation level …`, `read only`/`read write`, `deferrable`/`not deferrable` via `sql.raw`.

On a pool, `transaction()` checks out **one** connection for the whole transaction and releases it in
`finally` (`node-postgres/session.ts:252-254`, `:266`). PostgreJS's `pool.acquire()` / `pool.release()`
is the exact counterpart; `pool.query()` must not be used, for the same reason as in the Kysely dialect.

**Nested transactions become savepoints** (`node-postgres/session.ts:284-301`). Names are generated as
`` `sp${this.nestedIndex + 1}` `` (`:285`) and sent through `sql.raw` (`:292`, `:295`, `:298`), so they
are **not quoted** and not user-controllable. Nothing to validate or escape.

`rollbackOnError` matters and must be turned off. Verified on a live connection - a failing statement
inside a transaction, then another statement:

| | result |
| --- | --- |
| `pg` | `current transaction is aborted…` (PostgreSQL semantics) |
| PostgreJS, default `rollbackOnError: true` | **continues, commits** |
| PostgreJS, `rollbackOnError: false` | `current transaction is aborted…` |

**Settled, not a decision:** pass `rollbackOnError: false` on every query, as `postgrejs-kysely` does.

## 6. Result metadata

**Drizzle reads nothing off the result object.** Verified by grep: `rowCount`, `rowsAffected`,
`affectedRows` and `oid` appear nowhere in `pg-core/` or `node-postgres/`. RETURNING rows arrive as
ordinary rows through the `fields` path.

The result object is instead a **user-facing compatibility surface**: `db.execute()` resolves to
whatever the driver returns, typed by `NodePgQueryResultHKT = QueryResult<…>` from `pg`
(`node-postgres/session.ts:304-306`). Users read `.rows` and `.rowCount`; upstream tests do too
(`integration-tests/tests/pg/node-postgres.test.ts:89`).

Mapping from PostgreJS's `QueryResult`: `rows` -> `rows` (empty array when absent),
`rowsAffected` -> `rowCount` (`number` on both sides - no bigint conversion, unlike Kysely),
`command` -> `command`, `fields` -> `fields`. The one thing that has to be overridden because of this
shape is `count()` (§2).

**`command` needs both spellings.** `pg` takes the first word of the server's command tag, so it
collapses four different `CREATE`s and four different `DROP`s into one word each - measured across 16
statement kinds, 9 of them lose their object type:

| statement | `pg` | PostgreJS |
| --- | --- | --- |
| `create table` / `index` / `view` / `sequence` | `CREATE` (all four) | `CREATE TABLE` / `CREATE INDEX` / `CREATE VIEW` / `CREATE SEQUENCE` |
| `drop view` / `index` / `sequence` / `table` | `DROP` (all four) | `DROP VIEW` / `DROP INDEX` / `DROP SEQUENCE` / `DROP TABLE` |
| `alter table` | `ALTER` | `ALTER TABLE` |
| `truncate` | `TRUNCATE` | `TRUNCATE TABLE` |
| `insert` / `update` / `select` / `delete` / `merge` / `comment` / `analyze` | identical | identical |

So: **`command` carries `pg`'s first word** for compatibility, and **`commandTag` carries PostgreJS's
full tag**. `commandTag` is PostgreSQL's own term for the CommandComplete payload, which is why it
beats `commandFull` or `commandRaw` - although the value is the tag with its trailing counts removed
(`INSERT 0 2` -> `INSERT`), since those already live on `rowCount`. It goes on single-statement
results as well as on each element of a multi-statement one, and it is an addition of ours that
`node-postgres` does not have, so it belongs in the README as a PostgreJS-only extra. Safe to add:
the upstream suite never reads `.command` and never deep-compares a `db.execute` result.

**Multi-statement `db.execute` needs PostgreJS's `execute()`.** `db.execute()` with two statements in one template works on
`pg` because a parameterless query goes over the simple protocol; PostgreJS's `query()` is always the
extended protocol and answers `42601 cannot insert multiple commands into a prepared statement`.
`connection.execute()` is the counterpart, and three things make routing to it cheap and safe:
`42601` is raised at Parse, before anything runs (verified - the table was still empty after the
failed call), so falling back on that code needs no SQL parsing and cannot double a side effect;
`execute()` honours `fetchAsString` and `unknownTypesAsString`, so §8's value shapes are unchanged
(verified, identical values on both paths); and it takes no parameters (`42P02`), so the fallback
only applies when `params.length === 0` - which is the only case that can carry several statements
anyway. Its result is `{ totalCommands, results }` where `pg` returns a bare array, and each entry
uses `rowsAffected` with `rows`/`rowsAffected` left `undefined` where `pg` gives `[]`/`null`, so the
reshape is the single-statement mapping applied per element. `postgres-js` skips the suite's three
`db.execute` tests; with this we do not have to.

Error wrapping is **not** free: `DrizzleQueryError` is produced by `PgPreparedQuery.queryWithCache()`
(`pg-core/session.ts:64-147`, throw sites at `:73`, `:100`, `:109`, `:125`, `:145`). A driver that
calls the client directly loses it. Verified: routing every call through `queryWithCache` turned a
differential mismatch (`DatabaseError` vs `DrizzleQueryError`) into a match.

**Where the errors differ, measured field by field.** Every structured field a caller branches on is
identical - `code`, `severity`, `detail`, `hint`, `schema`, `table`, `column`, `dataType`,
`constraint`, `internalQuery`, `internalPosition`, `where`. What differs:

| field | `pg` | PostgreJS |
| --- | --- | --- |
| `message` | the bare sentence | the sentence plus a caret diagram pointing into the SQL |
| `position` | `"8"` - a string, straight off the wire | `8` - a number |
| `line` | **PostgreSQL's own C source line**, as a string | **the line of SQL** the error points at |
| `lineNr`, `colNr` | absent | where in the statement |
| `file`, `routine` | the server's source file and function | absent |

`line` is the one to write down: the same name means something else on each side, and nothing about
reading it fails loudly. Not worth papering over - the error a caller catches is PostgreJS's own
`DatabaseError`, not a `pg` lookalike, and faking `pg`'s field types would mean committing to all of
them. It is pinned by a differential test instead, so a change on either side is reported rather than
discovered.

## 7. Streaming

**There is none.** `grep -rn "asyncIterator|Cursor|createReadStream"` over the whole of
`drizzle-orm/src` matches only `durable-sqlite/`. `pg-core/` has no cursor, no stream, no async
iterator; neither does `postgres-js/session.ts`, whose underlying client does support streaming.

PostgreJS's portal-lifetime rule never comes into play. Nothing to implement, nothing to design.

## 8. Column types

**Drizzle maps from its own schema, not from driver-reported types.** `mapResultRow`
(`utils.ts:15-73`) picks a decoder per selected field from the Drizzle column, subquery or `SQL`
object (`:25-34`) and calls `decoder.mapFromDriverValue(rawValue)` (`:44`). The driver is never asked
what type a column was. So PostgreJS's type map is not the advantage it would be for a Prisma driver
adapter.

It is worse than neutral: because Drizzle maps from its schema, **it assumes the raw value has pg's
shape**, and `node-postgres` actively bends pg to produce that shape - `getTypeParser` is overridden
to return TIMESTAMPTZ, TIMESTAMP, DATE, INTERVAL and the `numeric[]`, `timestamp[]`, `timestamptz[]`,
`interval[]`, `date[]` array OIDs **as raw strings** (`node-postgres/session.ts:47-85` and `:91-129`).

Verified differential, 33 scalar and array types, `pg` with those overrides vs PostgreJS defaults:
**17 of 33 differ**, and the differences are not all cosmetic.

| | pg (as drizzle sees it) | PostgreJS default | consequence |
| --- | --- | --- | --- |
| `numeric` | `"1234567890123456789.12"` | `1234567890123456800` | **precision destroyed**; `numeric.mapFromDriverValue` is `String(value)` (`pg-core/columns/numeric.ts:52-56`), so the corruption reaches the user |
| `timestamp` | `"2024-03-05 06:07:08.9"` | `Date(2024-03-05T03:07:08.9Z)` | wall time read in the **local** zone; `timestamp.ts:62` builds the pg string as `+0000`. Same DB value, different `Date`. |
| `date` mode `'string'` | `"2024-03-05"` | `Date(2024-03-04T21:00Z)` -> `"2024-03-04"` | **off by one day** (`date.ts:87-91` slices `toISOString()`) |
| `interval`, `timetz`, `inet`, `cidr`, `macaddr`, `line` | strings | **`Buffer`** | PostgreJS has no decoder for these; `interval` and `time` columns have no `mapFromDriverValue` at all (`interval.ts:39-47`, `time.ts:43-55`) so the Buffer reaches the user |
| `int8` | `"9007…93"` | `9007…93n` | harmless - `bigint.ts:43` / `:88` accept both |

**The whole class is fixable with one constant.** `fetchAsString` on 3.6 takes any OID and is a
wire-format request. With the list below, the same differential is **byte-identical to pg on 19 of
20 cases**; the twentieth (`int8[]`) differs only in that PostgreJS returns the raw literal `{1,2}`
where pg returns `["1","2"]`, and `PgArray.mapFromDriverValue` handles both (`pg-core/columns/common.ts:334-340`
calls `parsePgArray` on a string), so it is correct either way.

```
int8, numeric, date, timestamp, timestamptz, time, timetz, interval,
inet, cidr, macaddr, macaddr8, line, money,
_numeric, _timestamp, _timestamptz, _date, _interval, _time, _timetz,
_inet, _cidr, _macaddr, _macaddr8, _line
```

**Settled, not a decision:** that list, passed as `fetchAsString` on every query - except that it
became shorter while this was being written. PostgreJS gained an `unknownTypesAsString`
option, which covers everything it has no decoder for and leaves only the types it decodes into an
unexpected shape. **The list to use is the one at the end of §9**, not this one; this one is
kept because it is what the measurement above was taken with.

What neither list covers on its own is user-defined OIDs - see §9.

## 9. A test oracle - yes, and it already runs

`integration-tests/tests/pg/pg-common.ts` is a 6,544-line **shared suite parameterised by driver**:
`export function tests()` at `:398`, driven entirely through a vitest context the driver file sets
(`ctx.pg = { db }`, e.g. `node-postgres.test.ts:52-60`). Four drivers already consume it -
`node-postgres.test.ts`, `postgres-js.test.ts`, `pglite.test.ts`, `vercel-pg.test.ts` - each
declaring its own known-incompatible list through `skipTests([...])` (`tests/common.ts`, which skips
by name inside the `common` describe). `createDockerDB()` (`pg-common.ts:367`) spins up a throwaway
container, and `PG_CONNECTION_STRING` bypasses it (`node-postgres.test.ts:23`).

`postgres-js`, the closest analogue to our situation, skips 13 of 183 - four migrator tests, three
`db.execute` tests, and **six timestamp/date mode tests**, i.e. precisely the type-shape class from §8.

I ran it. Vendored `pg-common.ts`, `common.ts` and `utils.ts` into a scratch directory, resolved
`drizzle-orm` to the published 0.45.2 build, wrote a ~150-line throwaway PostgreJS session
(`PgjsPreparedQuery` / `PgjsSession` / `PgjsTransaction` + a `drizzle()` mirroring `driver.ts`), and
pointed the suite at it with **no `skipTests` at all**:

| server | driver | tests | passed | failed |
| --- | --- | --- | --- | --- |
| PostgreSQL **14.24** (what `createDockerDB` pins, `pg-common.ts:370`) | `node-postgres` | 183 | **183** | 0 |
| PostgreSQL **14.24** | PostgreJS spike | 183 | **183** | 0 |
| PostgreSQL 18.4 | `node-postgres` | 183 | 180 | 3 |
| PostgreSQL 18.4 | PostgreJS spike | 183 | 180 | 3 |
| PostgreSQL 18.4, PostgreJS 3.6.1 (before the fixes below) | PostgreJS spike | 183 | 179 | 4 |

**On the version the suite is written against, the spike passes all 183 with no `skipTests` at all** -
where `postgres-js`, the closest comparable third-party driver, declares 13. On 18.4 both drivers lose
the same three, and they are the suite's own assumption rather than anyone's bug: `select with group
by as column + sql`, `select with group by as sql + column` and the `mySchema ::` variant group by
`id`, which is unique, so nothing is collapsed and the order is whatever the plan yields - and none
of the three writes an `ORDER BY`. On 14 the planner answers in the order they assert; on 18.4 it
does not. So `EXPECTED_FAILURES` has to be measured against a control run on the same server rather
than pinned, which is what `scripts/run-drizzle-suite.sh` should do.

A second
differential harness written from scratch (20 query/transaction cases + 7 relational-query cases
against `db.query.*`, `with`, nested `columns`, `extras`, lateral-style joins) is **27/27 identical**
to `node-postgres`, including `numeric` precision, nested JSON aggregation and left-join null rows.

So: the fallback differential harness to design if no oracle existed is worth
building anyway (it is cheap and catches value-shape drift the suite does not assert), but it is no
longer the primary instrument. The primary instrument is upstream's own suite, run the way
`scripts/run-kysely-suite.sh` runs Kysely's, with `EXPECTED_FAILURES` pinned to whatever
`node-postgres` scores on the same server in the same run - not to a hard-coded 0, because the
baseline moves with the PostgreSQL version.

### The three PostgreJS defects this turned up - all since fixed

All three were in PostgreJS, not in the driver, and all three affect `postgrejs-kysely` too. They
were written up as tasks in `../postgrejs/.claude/` and fixed the same day; what follows is what was
wrong and how the fix was verified, because the *shape* of each problem still decides how this driver
is written.

**(a) No text fallback for unknown OIDs.** PostgreJS requests binary for every column and has no
decoder for user-defined types, so an enum value arrives as a raw `Buffer` (`jsType: 'Buffer'`,
`dataTypeName: ''`). `pg` asks for text and gets `"happy"`. This breaks enums, and by the same
mechanism composites and extension types. `columnFormat: 0` fixes enums but forces text on *every*
column, which throws away the §8 parity. Passing the enum's dynamic OID in `fetchAsString` works
(verified: `"happy"`, and `"{happy,sad}"` for `mood[]`, matching pg exactly), which is what the spike
does with a `pg_type where typtype = 'e'` sweep - that is what lifted it from 177 to 179.

**Fixed** by a new `unknownTypesAsString` query option. `resolveColumnFormats` now takes the type map
and asks for text on any column it could not decode from binary, and - because Bind's result format
codes are positional and so can only be chosen once the column types are known - an unprepared
statement is prepared on first sight, one extra round trip per distinct statement per connection
(233µs -> 447µs on loopback, measured upstream). Off by default; a registered type is untouched.

Verified here: enum `"happy"`, `mood[]` `"{happy,sad}"`, and `interval`, `timetz`, `inet`, `cidr`,
`macaddr`, `macaddr8`, `line`, `money`, `bit`, `varbit` and `int4range` all now byte-identical to
`pg`, while `int4`, `text`, `jsonb`, `int4[]` and `bytea` still decode as before.

**(b) The text-format array decoder drops empty-string elements.** Isolated, no Drizzle involved:

```js
await c.query("select array['','b','c']::text[] as v", { objectRows: true })
// binary (default)      -> ["", "b", "c"]   correct
// { columnFormat: 0 }   -> ["b", "c"]       WRONG - element lost
```

The parser (`../postgrejs/src/util/parse-array.ts:34`) skips an element whose token is empty, so
every position is affected - first, middle, last, only, and nested - and `{""}` becomes
indistinguishable from `{}`. The array gets shorter, so every later index shifts.

Which paths reached it, measured: `columnFormat: 0` always; `prepare: false` **combined with**
`fetchAsString` always; `prepare: false` alone and `fetchAsString` alone did not. That mattered more
than it looks, because (a)'s whole purpose is to send more columns down the text path.

**Fixed.** Verified on the new build: all seven shapes above round-trip, including `{"",NULL}` ->
`['', null]`, and `{}`, `{1,NULL}` and `{1,"NULL"}` are unchanged.

**(c) A cached statement survived `DROP TYPE` and poisoned the connection.** PostgreJS's automatic
per-connection prepared-statement cache holds plans that carry resolved type OIDs, and a statement
cached before a `DROP TYPE` / `CREATE TYPE` failed afterwards with
`cache lookup failed for type 477170` (`XX000`, `where: 'unnamed portal parameter $2'`) - and kept
failing, because the existing recovery path only matched `0A000`. `pg` does not cache by default and
never sees it. The only workaround from outside was `prepare: false`, which then hit (b) - which is
why the spike sat at 179 either way rather than 180.

**Fixed.** Verified: the same SQL past `PREPARE_AFTER_USES`, then `DROP TYPE` / `CREATE TYPE`, then
the same SQL again - succeeds, and succeeds again, so the cache entry really is dropped.

### What the fixes change for this driver

Two things, and both shrink it.

**The enum workaround is gone.** No `pg_type` sweep, no cache to invalidate, no
`prepare: false`. One option, `unknownTypesAsString: true`, on every query.

**The `fetchAsString` list drops from 26 OIDs to 16**, because everything PostgreJS had no decoder
for is now covered by the option instead. Re-derived from scratch against the new build - 42 scalar
and array types, `pg` with drizzle's parsers versus PostgreJS - what is left is only the types
PostgreJS *does* decode, into a shape drizzle does not expect:

```
int8, numeric, date, timestamp, timestamptz, time, interval, point,
_int8, _numeric, _date, _timestamp, _timestamptz, _time, _interval, _point
```

`line` and `_line` joined them later, making 18, and one release early: drizzle's `line` column
parses `{a,b,c}` out of a string and copes with nothing else, and PostgreJS was in the middle of
giving the geometric family classes of their own. It landed in 3.10.0, and `line` is a `Line` there -
the pre-emptive entry is what keeps that column working. `src/constants.ts` is the list as it stands.

**What PostgreJS decodes that `pg` leaves as text, and this driver leaves alone.** By 3.10.0 that is
ranges, `money`, and `path`, `polygon`, `circle`, `box` and `lseg`. Drizzle has a column for none of
them, so nothing it owns is misread either way and they reach a caller only through a raw
`db.execute()` - where a decoded value is usually the more useful one. `money` is the one worth
naming: `pg` prints `"$12.34"` and PostgreJS answers `12.34`, so the currency rendering is gone
rather than reshaped, and a caller who wants the exact decimal wants PostgreJS's `decimalAsString`
rather than a double. All of them are pinned by tests in `test/B-live/types.spec.ts`, so the choice
stays a decision.

**Verified on the peer floor.** All 199 tests pass on PostgreJS 3.10.1, which is what the peer range
starts at, and drizzle's own suite scores 183 of 183 there - the same as the `node-postgres` control.

`point` is the one addition and the one that is easy to miss: PostgreJS decodes it into a `Point`
class instance, and drizzle's `point` column in `xy` mode returns the driver value **unchanged**
(`pg-core/columns/point.ts:94-100`), so the user would get a class instance where `pg` gives a plain
`{ x, y }` - same fields, different prototype, and `JSON.stringify` renders it as `"(24.5,49.6)"`.
`toEqual` does not notice; the suite's `toStrictEqual` does. Asking for the text form makes drizzle
parse it into the plain object itself.

`int8[]` and `time[]` are in the list for a subtler reason worth writing down: at the raw-driver
level they look *more* correct than `pg`'s (`[1, 2]` against `["1","2"]`). But the thing that has to
match is the value **after** drizzle's column mapping, not before it, and `PgArray.mapFromDriverValue`
reaches the same answer from either shape only for some base types. The lesson generalises - the
right place to decide this list is the differential harness, not a table of driver outputs.

**Why `fetchAsString` and not a custom `DataTypeMap`.** PostgreJS has a decoder for every one of
them - the list is not about absence, it is about shape - so the obvious alternative is to copy
`GlobalTypeMap`, override those decoders to produce pg's shapes, and stay on the binary wire.
Measured, that works for `point`, `int8` and `numeric`: all three come back identical to `pg`. It
cannot work for `date`, `time`, `timestamp`, `timestamptz` and `interval`, because their text form is
decided by session GUCs the client does not track - the same value renders six different ways across
`DateStyle`, `IntervalStyle` and `TimeZone`, verified on one connection.

The deciding argument is not that split, though; it is that a custom decoder is tied to a wire format
and `fetchAsString` pins one. Overriding only `decodeBinary` for `point` and asking the same query
three ways returns **three different JS types** - a plain object on binary, a `Point` on text, a
string when `fetchAsString` also applies. Covering that means owning `decodeText` and
`decodeTextBuffer` as well, per type. `fetchAsString` returns the same string under all three,
because the format *is* the contract. One mechanism for all 16, no decoders of our own, and the
string is the server's own rendering rather than one reconstructed from binary - which is what makes
it unable to drift.

Worth reporting upstream regardless: `numeric`'s binary decoder builds the exact decimal string and
then discards it with `parseFloat` (`../postgrejs/src/data-types/numeric-type.ts`, the line after
`numberBytesToString`), so `123456789012345678901234567890.123456` reads back as `1.2345678901234568e+29`
while the *encoder* goes out of its way to preserve exactly that. It affects every PostgreJS user,
not just this driver.

## 10. Peer range

Tracked by blob hash of the two seam files across every released tag:

| versions | `pg-core/session.ts` | `node-postgres/session.ts` |
| --- | --- | --- |
| 0.40.0 - 0.43.1 | `d77f2c4dbf` | changed once at 0.41.0 |
| **0.44.0** | `339fe75e7d` | `e5fb6ba7b7` |
| 0.44.6 | `2b111fa828` | `e5fb6ba7b7` |
| 0.45.0 - 0.45.2 | `2b111fa828` | `8a757fe22e` -> `8c668a695b` |
| 1.0.0-rc.x | complete rewrite | complete rewrite |

0.44.0 was a **breaking change to third-party drivers shipped in a minor release**: `PgPreparedQuery`'s
constructor grew three parameters (`cache`, `queryMetadata`, `cacheConfig`) and `queryWithCache` appeared.
A driver written against 0.43 does not compile against 0.44. 0.44.6 relaxed `cache: Cache` to
`Cache | undefined`. Since then the seam has been stable: `pg-core/session.ts` is **byte-identical
across 0.44.6, 0.45.0, 0.45.1, 0.45.2 and 0.45.3**, and `node-postgres/session.ts`'s only change in
that window is the pg-native `Pool` detection fix (`:252`).

**So the honest peer range is `>=0.44.6 <0.46.0`**, one breaking seam change in roughly six minors.
Since verified by running drizzle's own suite at both ends through
`scripts/run-drizzle-suite.sh`: 179 of 179 on 0.44.6 and 183 of 183 on 0.45.3, matching the
`node-postgres` control on each, with no skips.

**The problem is what sits outside that range.** npm `latest` moved for the first time in six months
on 2026-09-21, and only to add a driver: 0.45.3's `pg-core/session.js` and `session.d.ts` are
byte-identical to 0.45.2's, and the release adds `netlify-db`. The 0.45 line is maintained but not
developed, while the 1.0 line ships actively - `1.0.0-rc.4` on 2026-06-27 and prereleases through
`1.0.0-rc.5-5935859` on 2026-09-09, eleven days ago. And 1.0 is not a tidy-up:

- `PgPreparedQuery` becomes `PgBasePreparedQuery` with a bare `(query)` constructor and one abstract
  method, `execute()`. `all()` and `isResponseInArrayMode()` are gone.
- `PgSession` loses its generics and gains three abstract methods: `execute`, `arrays`, `objects` -
  row mode moves from a per-query flag to a named method, and `prepareQuery` takes
  `mode: 'arrays' | 'objects' | 'raw'` instead.
- Drivers now subclass `PgAsyncSession` / `PgAsyncTransaction` / `PgAsyncPreparedQuery` from
  `drizzle-orm/pg-core/async/session`.
- **Type handling becomes a first-class driver seam**: `node-postgres/codecs.ts` declares a per-driver
  codec table through `refineGenericPgCodecs({...})`, with `normalize`, `normalizeArray`, `cast`,
  `castArray` and `normalizeParam` hooks per type. This is exactly the extension point §8 wishes
  existed in 0.45 - in 1.0, "PostgreJS returns a `Date` here and a `BigInt` there" is something a
  driver *declares* rather than works around with `fetchAsString`.

A 0.45 driver is therefore not a head start on a 1.0 driver in code. It is a head start in
understanding, which is most of what this document is.

---

## Effort estimate

**Mechanical - 1 to 2 days.** The seam is 306 lines in upstream's own driver and the spike reproduced
working behaviour in ~150. `prepareQuery`, `all`, `isResponseInArrayMode`, the two row modes, the
transaction/savepoint SQL, the result reshape and `count()` are all transcription with a known-good
reference. The parameter policy (§4) and the `fetchAsString` list (§8) are both settled constants.
Config plumbing, `drizzle()` overloads, exports and types follow `postgrejs-kysely`'s shape.

**Known work, sized - 2 to 4 days.** Standing the upstream suite up as `scripts/run-drizzle-suite.sh`
with a `node-postgres` control run in the same invocation (the baseline moves with the server
version, so it has to be measured, not pinned). The `test/A-common` fakes. The differential harness.
Enum OID discovery is no longer on this list: `unknownTypesAsString` replaced it.

**Unknowns - close to none left.** This paragraph originally sized the three PostgreJS defects at 2
to 6 days. All three are fixed, and the fixes were verified here against the suite and against the
differential harnesses. What remains is ordinary: the `point` prototype question in §9, and D5.

**Biggest risk, and it is not technical.** It is that the 0.45 line is maintained but not developed.
Six months between `latest` releases, and the one that ended them - 0.45.3, 2026-09-21 - adds a
driver and leaves `pg-core` byte-identical, against an rc line that is still moving. Add a seam
rewrite that changes every class name a driver touches, and work done against 0.45 has to be done
again. The second-biggest
risk is that the 1.0 rewrite is still an **rc** - `rc.5` prereleases were landing eleven days ago -
so a driver targeting it is aiming at a surface that can still shift before 1.0 final.

There is no meaningful risk left in "can a PostgreJS driver satisfy Drizzle". That was the question
the first round existed to answer, and the answer is yes, at parity, measured.

## Proposed layout

Following `postgrejs-kysely`'s split, and its member-order and `protected`-over-`private` conventions.

```
src/
  index.ts          exports drizzle(), the database type, config types
  driver.ts         drizzle() overloads, PgjsDriver, PgjsDatabase        (mirrors node-postgres/driver.ts)
  session.ts        PgjsSession, PgjsTransaction
  prepared-query.ts PgjsPreparedQuery
  params.ts         the BindParam(0) policy of §4, one exported predicate
  types.ts          the fetchAsString OID list of §8 + enum OID discovery
  config.ts         PgjsDrizzleConfig: Pool | factory, prepare, fetchAsString extras, inferParameterTypes
                    NB: PostgreJS takes a connection string as its FIRST ARGUMENT.
                    `{ connectionString }` is not one of its options and is silently
                    ignored, landing you on localhost:5432/postgres - and that is `pg`'s
                    idiom and drizzle's documented one, so this config has to either
                    translate it or reject it loudly.
  constants.ts

test/
  _support/
    fakes.ts        a fake Connection/Pool recording every call, able to hold a query open
    schema.ts       the shared table set the differential cases run against
  A-common/         unit tests against the fakes: option plumbing, param policy, row-mode branch
                    selection, savepoint naming, result reshape, count() override, error wrapping
  B-live/           the same against 127.0.0.1:5432, plus the §8 type matrix and the §4 param matrix
                    as explicit regression tables
  C-differential/   every case run through drizzle-orm/node-postgres and through us in one process,
                    deep-compared - the instrument that catches value-shape drift the upstream suite
                    does not assert

scripts/
  run-drizzle-suite.sh   checks out drizzle-orm at a pinned tag, vendors tests/pg/pg-common.ts +
                         tests/common.ts + tests/utils.ts, adds tests/pg/postgrejs.test.ts, runs it
                         AND a node-postgres control in the same invocation, and fails only on a
                         delta between the two
```

## Decisions that need you

Everything settled by evidence is settled above and is not repeated here. These five are not.

**D1 - Which drizzle-orm line do we target?**
**(A)** 0.45.x now, peer `>=0.44.6 <0.46.0`, accept that 1.0 means a rewrite.
**(B)** 1.0.0-rc now, peer `>=1.0.0-rc.4`, accept an rc-tracking package and a still-moving surface.
**(C)** 0.45.x now and port when 1.0 goes final.
My recommendation is **(C)**, for the reason under "recommendation" below - but it is a product call,
not a technical one, and (B) is defensible if you would rather ship into the line that will be
`latest` a year from now.

~~**D2 - How do we find user-defined (enum) OIDs?**~~ **Settled by the fix.**
`unknownTypesAsString: true`, always on. No catalog sweep, no config, nothing to invalidate.

~~**D3 - Do we fix the PostgreJS defects upstream before writing `src/`?**~~ **Done**, all three.

~~**D4 - Should the driver disable the prepared-statement cache by default (`prepare: false`)?**~~
**No, and the reason it was a question is gone.** It existed only to work around §9c, which is fixed;
leaving the cache on is what makes PostgreJS faster than `pg` here. Still worth **exposing** as a
config option for PgBouncer in transaction pooling mode, exactly as `postgrejs-kysely` does.

**D2' - Does `unknownTypesAsString` stay on unconditionally, or become a config option?**
**(A)** Always on. Without it a schema with a single `pgEnum` silently returns `Buffer`s, which is
not a thing to make users opt into. Costs one extra round trip per distinct statement per connection.
**(B)** On by default, switchable off for someone who knows their schema has no unregistered type
and wants that round trip back.
I would take (B): the default is what matters, and the escape hatch is one line.

**D5 - Do we normalise PostgreJS's `DatabaseError.message`** (strip the caret diagram) so error text
matches `pg` for people migrating? Yes / no. `code`, `position` and the structured fields already
match; this is only the human-readable string. **This is now the only value-shape difference left**
between the two drivers across the suite and both differential harnesses.

## Recommendation: proceed, but not on 0.45 alone

The seam is public, small, and stable within its line. There is a real conformance oracle, and on the
PostgreSQL version that suite is written against the spike passes **all 183 of it with no skips** -
`node-postgres` scores the same, and on 18.4 the two lose the same three to an assertion the suite
makes without an `ORDER BY`. The parameter problem that cost the Kysely round the most time recurs exactly as
predicted and has exactly the same answer. None of the reasons to walk away that the first round
anticipated - internals-only seam, no oracle, unbounded scope - actually hold.

What does hold is that **0.45 is very likely the last of its line**, and a driver for it will need
rewriting rather than adapting. So I would not build only for 0.45.

Concretely, what I would do next, in this order:

1. ~~**Fix the PostgreJS defects first**~~ - **done**, and it was the right order. The three fixes
   removed the enum workaround entirely, cut the `fetchAsString` list from 26 OIDs to 16, and took
   the spike from 179 to 180 of 183, which is parity. They improve `postgrejs-kysely` at the same
   time. Worth re-running that dialect's suite against the new build before anything else.
2. ~~**Stand up `scripts/run-drizzle-suite.sh` with the control run**~~ - **done**, and it earned its
   keep twice on the first day. It vendors the three files the suite needs and resolves `drizzle-orm`
   from npm rather than building the monorepo, so what is tested is the published package a user
   installs; it runs `node-postgres` against the same server in the same invocation; and it fails
   only on a test this driver loses that the control wins. Two guards were added after the first run
   lied: a run that collects nothing is a failure rather than a clean sweep, and the two runs have to
   have collected the same number of tests.
3. **Then write the driver**, against whichever line D1 picks - the code is one to two days once the
   above two are in place, because everything it has to decide has already been decided by
   measurement here.

The one thing I would not do is start `src/` first. Not because it is hard, but because on this
evidence it is the cheapest part - and step 2 is what keeps it honest.
