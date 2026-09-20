import { sql } from 'drizzle-orm';
import { pgSchema } from 'drizzle-orm/pg-core';
import { expect } from 'expect';
import { type LiveDb, openLiveDb } from '../_support/live.js';

const schema = pgSchema('drizzle_pgjs_params');

/**
 * The query shapes that fail when a parameter carries a type.
 *
 * PostgreJS derives an OID from the value it is given, so a plain string
 * is declared `varchar` and PostgreSQL stops inferring from where the
 * parameter lands. Drizzle's encoders stringify nearly everything before
 * the driver sees it, so this is ordinary INSERT rather than an edge:
 * measured on 3.6.1, ten of these twenty-four shapes failed without
 * `BindParam(0, ...)` and all twenty-four pass with it.
 *
 * Each one is a `column "x" is of type T but expression is of type
 * character varying` away from failing, so they are run as themselves
 * rather than through a matrix helper - the SQL is the point.
 */
describe('live: parameter types', () => {
  let live: LiveDb;

  const table = schema.table('params', {});

  before(async () => {
    live = await openLiveDb('drizzle_pgjs_params');
    await live.db.execute(sql`
      create table ${table} (
        id serial primary key, j json, jb jsonb, n numeric, ts timestamp,
        tstz timestamptz, d date, arr int4[], txt text, num int4, b bool,
        big int8, iv interval, tm time, by bytea, pt point)
    `);
  });

  after(async () => {
    await live?.close();
  });

  const inserts: [string, string, unknown][] = [
    ['json, as drizzle stringifies it', 'j', '{"a":1}'],
    ['jsonb, as drizzle stringifies it', 'jb', '{"a":1}'],
    ['numeric, as drizzle stringifies it', 'n', '1234567890123456789.12'],
    ['timestamp, as drizzle renders it', 'ts', '2024-03-05T06:07:08.900Z'],
    ['timestamptz, as drizzle renders it', 'tstz', '2024-03-05T06:07:08.900Z'],
    ['date, as drizzle renders it', 'd', '2024-03-05T00:00:00.000Z'],
    ['int4[], as drizzle renders it', 'arr', '{1,2}'],
    ['interval, as a string', 'iv', '1 day'],
    ['time, as a string', 'tm', '06:07:08'],
    ['int8, as a string', 'big', '9007199254740993'],
    ['point, as drizzle renders it', 'pt', '(1,2)'],
    ['text', 'txt', 'abc'],
    ['int4, as a number', 'num', 7],
    ['bool, as a boolean', 'b', true],
    ['bytea, as a Buffer', 'by', Buffer.from([1, 2])],
    ['null', 'txt', null],
  ];

  for (const [label, column, value] of inserts) {
    it(`inserts ${label}`, async () => {
      const result = await live.db.execute(
        sql`insert into ${table} (${sql.identifier(column)}) values (${value}) returning id`,
      );
      expect(result.rowCount).toStrictEqual(1);
    });
  }

  const expressions: [string, ReturnType<typeof sql>, unknown][] = [
    [
      'coalesce($1, 1) against an integer',
      sql`select coalesce(${5}, 1) as v`,
      5,
    ],
    [
      'coalesce($1, x) against text',
      sql`select coalesce(${'a'}, 'x') as v`,
      'a',
    ],
    ['string concatenation', sql`select ${'a'} || 'x' as v`, 'ax'],
    ['an overloaded function', sql`select greatest(${3}, 2) as v`, 3],
    [
      'jsonb containment',
      sql`select '{"a":1}'::jsonb @> ${'{"a":1}'} as v`,
      true,
    ],
    // The timestamptz comes back as the server's own text, because no
    // drizzle column is involved in a raw execute() to turn it into
    // anything else - which is what node-postgres does with it too.
    [
      'date_trunc with a text unit',
      sql`select date_trunc(${'day'}, date '2024-03-05') as v`,
      '2024-03-05 00:00:00+00',
    ],
  ];

  for (const [label, query, expected] of expressions) {
    it(`resolves ${label} from context`, async () => {
      const result = await live.db.execute<{ v: unknown }>(query);
      expect(result.rows[0]!.v).toStrictEqual(expected);
    });
  }

  it('unnests an array parameter the server had to type itself', async () => {
    const result = await live.db.execute<{ v: number }>(
      sql`select * from unnest(${'{1,2}'}::int4[]) as v`,
    );
    expect(result.rows.map(row => row.v)).toStrictEqual([1, 2]);
  });

  it('takes a limit as a parameter', async () => {
    const result = await live.db.execute<{ v: number }>(
      sql`select 1 as v limit ${1}`,
    );
    expect(result.rows).toHaveLength(1);
  });
});
