# postgrejs-drizzle

A [Drizzle ORM](https://orm.drizzle.team) driver for
[PostgreJS](https://github.com/panates/postgrejs), so a Drizzle schema can run on PostgreJS's
wire-protocol client instead of `pg`.

**Read `doc/DRIVER-DESIGN.md` before changing `src/`.** It is why the driver is shaped the way it
is - which of drizzle's contract is load-bearing, which of PostgreJS's defaults had to be overridden
and what each override costs - with the measurement behind every claim. Most of what looks arbitrary
in `src/` is answered there.

## Why this exists

Drizzle is the largest ORM on npm (16.2M weekly against Kysely's 12.8M and Prisma's 12.3M, measured
2026-09-20) and, more to the point, the one where the **user picks the driver explicitly**:
`drizzle(client)` names the PostgreSQL client. That makes a PostgreJS driver something people can
actually choose, which is the whole point of doing this.

The trade, stated up front so nobody rediscovers it: Drizzle is pre-1.0 (0.45.x as of this writing)
and its 1.0 line rewrites the driver seam, so this package targets 0.45 and a 1.0 driver will be a
rewrite rather than an adaptation - `doc/DRIVER-DESIGN.md` §10 has the detail.

The fear that there would be no conformance suite turned out to be wrong: drizzle's own
`integration-tests/tests/pg/pg-common.ts` is parameterised by driver, and
`scripts/run-drizzle-suite.sh` runs it here with no skips, against this driver and against
`drizzle-orm/node-postgres` on the same server in the same invocation. That comparison is the
instrument. Do not pin an expected-failure count instead - the suite asserts row order in three
places without an `ORDER BY`, so its score moves with the PostgreSQL version.

## Where things are

- **PostgreJS**: `../postgrejs`. Its own `CLAUDE.md` describes the internals. Peer is
  `>=3.10.1 <4`, which is published and contains everything referred to below.
- **The Kysely dialect**: `../postgrejs-kysely`. Read its `CLAUDE.md` before starting anything here -
  the same ground was covered once already, and its "What PostgreJS gives you" and "Settled decisions"
  sections are the cheapest way to avoid paying for the same discoveries twice. It is a finished
  repo; this one is not, so copy its reasoning, not its layout.

## The package

`src/` is eight files. `prepared-query.ts` and `session.ts` are the seam; the rest exist so that
`drizzle-internals.ts`, `params.ts`, `constants.ts` and `result.ts` each hold one decision that was
expensive to arrive at, in one place, with the reason next to it.

`drizzle-internals.ts` is the one to know about: drizzle ships its `.d.ts` files with
`stripInternal`, so several members a driver must use exist at runtime and are absent from the types
- `mapResultRow`, `tracer`, `queryWithCache`, `joinsNotNullableMap`, `PgPreparedQuery.all`,
`isResponseInArrayMode`, `PgTransaction.getTransactionConfigSQL`, `dialect`, `session`. They are all
restated there, so a drizzle upgrade breaks one import list rather than five call sites.

Tests come in three kinds and the split is the point:

- `test/A-common` - against the fakes in `test/_support/fakes.ts`, no server. What SQL goes out, in
  what order, with which options.
- `test/B-live` - against a real server, as an explicit table of expected values, so a change in
  PostgreJS's decoding names itself rather than showing up as a puzzle.
- `test/C-differential` - the same drizzle calls through this driver and through
  `drizzle-orm/node-postgres`, deep-compared. It is what catches a difference nobody thought to
  assert; `rowCount` on a SELECT and the error-field divergences were both found this way.

`test/A-common/types.compile.ts` is not run - it is compiled, so the shapes the README shows have to
keep type-checking.

## What PostgreJS gives you

Verified against a live server during the Kysely work, on 3.6. They are properties of PostgreJS, not
of Kysely, so they carry over - but re-check each one where Drizzle's expectations differ.

- **`connection.query(sql, options)` returns every row.** Since 3.6 `fetchCount` defaults to 0, the
  protocol's "no limit"; a result the server truncated carries `suspended: true`. Before 3.6 the
  default was 100 and said nothing, which is why older notes talk about a `MAX_FETCH_COUNT`.
- **Rows are arrays by default.** `objectRows: true` (or `rowDecoder: 'object'`) for objects. Drizzle
  wants both, chosen per call: object rows for `db.execute()`, array rows for anything it maps
  itself.
- **Parameters are `$1`-style** via `options.params`, so a compiled Drizzle query needs no rewriting.
  Their **types** are the trap: `Connection._query` derives an OID per parameter with
  `typeMap.determine(value)`, so a plain string arrives declared `varchar` and PostgreSQL stops
  inferring from context - inserting into a `json` column, `coalesce($1, 1)`, `$1 || x` and every
  overloaded function fail. `pg` sends OID 0 (unspecified) and lets the server resolve it.
  `new BindParam(0, value)` asks PostgreJS for the same. This cost the Kysely round more time than
  anything else; assume it recurs.
- **`rowsAffected` is a number** (Kysely wanted bigint), set for INSERT/UPDATE/DELETE and, since 3.6,
  MERGE. `QueryResult` also carries `command`, `fields`, `rowType`, `rows`.
- **`rollbackOnError` defaults to true** - every statement inside a transaction runs under a
  savepoint. PostgreSQL's own semantics are the opposite, so the Kysely dialect passes `false`.
- **`int8` decodes to a number, or a BigInt past 2^53.** `fetchAsString: [DataTypeOIDs.int8]` asks
  the server for text and gives `pg`'s strings instead; since 3.6 that option takes any OID and is a
  wire-format request rather than a re-rendering.
- **Cursors read through a portal**, which lives only as long as the transaction that created it.
  Outside an explicit transaction any other statement on the same connection destroys it;
  `Pool.query()` keeps the connection out of the pool until the cursor closes. Only relevant if
  Drizzle streams.
- **A pooled connection that dies** is reported on `Pool`'s `'destroy'` (second argument) and
  `'error'` as a `ConnectionLostError` - `code` `'08006'`, `processID`, and the socket error as
  `cause`.

## Working conventions

Inherited from `../postgrejs` and `../postgrejs-kysely`; they apply here from the first commit.

- **No fixups here. A gap in PostgreJS is reported, not worked around.** When something this
  adapter needs is missing, wrong or slower in `postgrejs`, do not patch around it in this package:
  no post-decode value rewriting, no shim, no vendored parser, no `pg`-compatibility table, no
  monkey-patching of the client, no "temporary" branch written to suit the behaviour as it is
  today. Stop there and write the finding up as a task file in `../postgrejs/.claude/<short-name>.md`
  - what was asked of the client, what it answered, what it should answer, and the smallest
  reproduction that shows the difference. That repo's own session picks it up and fixes it at the
  source. Otherwise every adapter ends up carrying its own copy of the same correction, and the
  client's behaviour gets defined by whichever adapter last worked around it. A workaround is
  allowed only when the user is asked for one and says yes; it then carries a comment naming the
  task file it waits on, so it can be removed when the fix lands.
- **Do not sign commits or pull requests on the assistant's behalf** - no `Co-Authored-By: Claude`
  trailer, no "Generated with Claude Code" line.
- Run `git status` before staging. Commit only the files the change is about.
- Every change comes with a test.
- **Claims about how another library behaves get checked against that library's own source, not its
  documentation.** Drizzle is pre-1.0 and its docs lag its code.
- Do not publish a performance number that was not measured. Comparing two versions means alternating
  between them inside one run and taking medians - sequential blocks on a loaded machine produce
  differences that are pure ordering artifacts.
- Code style follows `../postgrejs`'s `CLAUDE.md`: member order (properties, constructor, accessors,
  public, protected, private), `protected` over `private`.

## Local setup

PostgreSQL on `127.0.0.1:5432` (`postgres`/`postgres`, database `postgres`), from the docker compose
in the PostgreJS repo.
