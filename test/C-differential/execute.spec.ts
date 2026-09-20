import { sql } from 'drizzle-orm';
import { integer, pgSchema, serial, text } from 'drizzle-orm/pg-core';
import { expect } from 'expect';
import {
  comparableResult,
  type Differential,
  openDifferential,
} from '../_support/differential.js';

const schema = pgSchema('drizzle_pgjs_diff_exec');
const rows = schema.table('rows', {
  id: serial('id').primaryKey(),
  name: text('name'),
  n: integer('n'),
});

const DDL = [
  `create table drizzle_pgjs_diff_exec.rows (id serial primary key, name text, n integer)`,
];

/**
 * `db.execute()` hands its result straight to the caller, so the object's
 * shape is the contract rather than an implementation detail - `command`,
 * `rowCount` and `rows` are what code ported from
 * `drizzle-orm/node-postgres` reads.
 */
describe('differential: db.execute()', () => {
  let diff: Differential;

  before(async () => {
    diff = await openDifferential('drizzle_pgjs_diff_exec');
    diff.setSchema(DDL);
  });

  after(async () => {
    await diff?.close();
  });

  async function sameResult(fn: (db: any) => Promise<unknown>): Promise<void> {
    const answers = await diff.bothWays(async db =>
      comparableResult(await fn(db)),
    );
    expect(answers.pgjs).toStrictEqual(answers.pg);
  }

  const cases: [string, (db: any) => Promise<unknown>][] = [
    ['select with rows', db => db.execute(sql`select 1 as a, 'x'::text as b`)],
    ['select with no rows', db => db.execute(sql`select 1 as a where false`)],
    [
      'insert without returning',
      async db =>
        db.execute(sql`insert into ${rows} (name) values ('a'),('b')`),
    ],
    [
      'insert with returning',
      async db =>
        db.execute(sql`insert into ${rows} (name) values ('a') returning id`),
    ],
    [
      'update that matched nothing',
      db => db.execute(sql`update ${rows} set n = 1 where false`),
    ],
    [
      'delete that matched nothing',
      db => db.execute(sql`delete from ${rows} where false`),
    ],
    ['create table', db => db.execute(sql`create temp table t_diff (a int)`)],
    ['truncate', db => db.execute(sql`truncate ${rows}`)],
    [
      'a text-shaped value family',
      db =>
        db.execute(
          sql`select 1.5::numeric as n, '2024-03-05'::date as d,
                     '06:07:08'::time as t, '1 day'::interval as i,
                     9007199254740993::int8 as big`,
        ),
    ],
    [
      'an unregistered type',
      async db => {
        await db.execute(
          sql`create type drizzle_pgjs_diff_exec.mood as enum ('sad','happy')`,
        );
        return db.execute(
          sql`select 'happy'::drizzle_pgjs_diff_exec.mood as v,
                     array['happy','sad']::drizzle_pgjs_diff_exec.mood[] as arr`,
        );
      },
    ],
    [
      'more than one statement',
      db =>
        db.execute(
          sql`insert into ${rows} (name) values ('a'); insert into ${rows} (name) values ('b'); select count(*)::int as n from ${rows}`,
        ),
    ],
  ];

  for (const [label, fn] of cases) {
    it(label, async () => {
      await sameResult(fn);
    });
  }

  describe('errors', () => {
    /** The structured fields a caller branches on. */
    const SHARED = [
      'code',
      'severity',
      'detail',
      'hint',
      'schema',
      'table',
      'column',
      'dataType',
      'constraint',
      'internalQuery',
      'internalPosition',
      'where',
    ] as const;

    function shared(error: any): Record<string, unknown> {
      const cause = error?.cause ?? {};
      return Object.fromEntries(SHARED.map(key => [key, cause[key]]));
    }

    it('carries the same structured fields for a broken query', async () => {
      const answers = await diff.bothWays(async db =>
        db
          .execute(sql`select nosuchcolumn from ${rows}`)
          .then(() => undefined)
          .catch((error: any) => ({
            wrapper: error.constructor.name,
            ...shared(error),
          })),
      );
      expect(answers.pgjs).toStrictEqual(answers.pg);
      expect((answers.pg as any).code).toStrictEqual('42703');
    });

    it('carries the same structured fields for a unique violation', async () => {
      const answers = await diff.bothWays(async db => {
        await db.execute(sql`insert into ${rows} (id, name) values (1, 'a')`);
        return db
          .execute(sql`insert into ${rows} (id, name) values (1, 'b')`)
          .then(() => undefined)
          .catch((error: any) => shared(error));
      });
      expect(answers.pgjs).toStrictEqual(answers.pg);
      expect((answers.pg as any).constraint).toStrictEqual('rows_pkey');
    });

    /**
     * Where the two deliberately part company. The error a caller catches
     * is PostgreJS's own `DatabaseError`, not a `pg` lookalike, so these
     * are differences to know about rather than to paper over - and `line`
     * is the one to know about, because it means something else on each
     * side.
     */
    it('differs from pg only in the fields below', async () => {
      const answers = await diff.bothWays(async db =>
        db
          .execute(sql`select nosuchcolumn from ${rows}`)
          .then(() => undefined)
          .catch((error: any) => {
            const cause = error.cause;
            return {
              positionType: typeof cause.position,
              // pg: the PostgreSQL C source line, as a string.
              // PostgreJS: the line of SQL the error points at.
              line: cause.line,
              // PostgreJS reports where in the statement instead.
              lineNr: cause.lineNr,
              colNr: cause.colNr,
              // Server internals, which PostgreJS does not surface.
              file: cause.file,
              routine: cause.routine,
            };
          }),
      );
      const fromPg = answers.pg as any;
      const fromPgjs = answers.pgjs as any;

      // pg passes the wire's strings through; PostgreJS parses them.
      expect(fromPg.positionType).toStrictEqual('string');
      expect(fromPgjs.positionType).toStrictEqual('number');

      // The same field name, two different things. The exact values are
      // the server build's, so only their kind is pinned here.
      expect(fromPg.line).toMatch(/^\d+$/);
      expect(fromPgjs.line).toContain('select nosuchcolumn');

      // pg reports where in PostgreSQL's own source; PostgreJS reports
      // where in the statement, and leaves the server internals out.
      expect(typeof fromPg.file).toStrictEqual('string');
      expect(typeof fromPg.routine).toStrictEqual('string');
      expect(fromPg.lineNr).toBeUndefined();
      expect(fromPg.colNr).toBeUndefined();
      expect(fromPgjs.file).toBeUndefined();
      expect(fromPgjs.routine).toBeUndefined();
      expect(fromPgjs.lineNr).toStrictEqual(1);
      expect(fromPgjs.colNr).toBeGreaterThan(0);
    });
  });
});
