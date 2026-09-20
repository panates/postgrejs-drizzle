import { eq, inArray, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  integer,
  interval,
  json,
  jsonb,
  numeric,
  pgSchema,
  point,
  real,
  serial,
  text,
  time,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { expect } from 'expect';
import {
  type Differential,
  openDifferential,
} from '../_support/differential.js';

const schema = pgSchema('drizzle_pgjs_diff');

const rows = schema.table('rows', {
  id: serial('id').primaryKey(),
  name: text('name'),
  vc: varchar('vc', { length: 20 }),
  n4: integer('n4'),
  bigNumber: bigint('big_number', { mode: 'number' }),
  bigBig: bigint('big_big', { mode: 'bigint' }),
  num: numeric('num', { precision: 30, scale: 4 }),
  r: real('r'),
  d8: doublePrecision('d8'),
  flag: boolean('flag'),
  ts: timestamp('ts'),
  tsString: timestamp('ts_string', { mode: 'string' }),
  tstz: timestamp('tstz', { withTimezone: true }),
  dt: date('dt'),
  dtString: date('dt_string', { mode: 'string' }),
  tm: time('tm'),
  iv: interval('iv'),
  j: json('j'),
  jb: jsonb('jb'),
  u: uuid('u'),
  pt: point('pt', { mode: 'xy' }),
  ints: integer('ints').array(),
  texts: text('texts').array(),
  nums: numeric('nums').array(),
});

const DDL = [
  `create table drizzle_pgjs_diff.rows (
     id serial primary key, name text, vc varchar(20), n4 integer,
     big_number bigint, big_big bigint, num numeric(30,4), r real,
     d8 double precision, flag boolean, ts timestamp, ts_string timestamp,
     tstz timestamptz, dt date, dt_string date, tm time, iv interval,
     j json, jb jsonb, u uuid, pt point, ints integer[], texts text[],
     nums numeric[])`,
];

const ROW = {
  name: 'ada',
  vc: 'v',
  n4: 7,
  bigNumber: 42,
  bigBig: 9007199254740993n,
  num: '1234567890123456789.1234',
  r: 1.5,
  d8: 2.5,
  flag: true,
  ts: new Date('2024-03-05T06:07:08.900Z'),
  tsString: '2024-03-05 06:07:08.9',
  tstz: new Date('2024-03-05T06:07:08.900Z'),
  dt: new Date('2024-03-05T00:00:00.000Z'),
  dtString: '2024-03-05',
  tm: '06:07:08.9',
  iv: '1 day 02:03:04',
  j: { a: 1, b: [1, 2] },
  jb: { a: 1, b: [1, 2] },
  u: '11111111-2222-3333-4444-555555555555',
  pt: { x: 24.5, y: 49.6 },
  ints: [1, 2, 3],
  texts: ['', 'b', 'c'],
  nums: ['1.5000', '2.5000'],
};

describe('differential: queries', () => {
  let diff: Differential;

  before(async () => {
    diff = await openDifferential('drizzle_pgjs_diff');
    diff.setSchema(DDL);
  });

  after(async () => {
    await diff?.close();
  });

  /** Runs `fn` through both drivers and asserts they answered alike. */
  async function same<T>(fn: (db: any) => Promise<T>): Promise<void> {
    const answers = await diff.bothWays(fn);
    expect(answers.pgjs).toStrictEqual(answers.pg);
  }

  it('insert ... returning', async () => {
    await same(db => db.insert(rows).values(ROW).returning());
  });

  it('select every column of every type', async () => {
    await same(async db => {
      await db.insert(rows).values(ROW);
      return db.select().from(rows);
    });
  });

  it('select a subset', async () => {
    await same(async db => {
      await db.insert(rows).values(ROW);
      return db.select({ id: rows.id, num: rows.num, ts: rows.ts }).from(rows);
    });
  });

  it('select nothing at all', async () => {
    await same(db => db.select().from(rows).where(eq(rows.id, 99)));
  });

  it('update ... returning', async () => {
    await same(async db => {
      await db.insert(rows).values(ROW);
      return db
        .update(rows)
        .set({ name: 'bob', num: '0.0001' })
        .where(eq(rows.n4, 7))
        .returning({ id: rows.id, name: rows.name, num: rows.num });
    });
  });

  it('delete ... returning', async () => {
    await same(async db => {
      await db.insert(rows).values(ROW);
      return db
        .delete(rows)
        .where(eq(rows.name, 'ada'))
        .returning({ id: rows.id });
    });
  });

  it('null in every nullable column', async () => {
    await same(async db => {
      await db.insert(rows).values({ name: null });
      return db.select().from(rows);
    });
  });

  it('order, limit and offset', async () => {
    await same(async db => {
      await db.insert(rows).values([{ n4: 3 }, { n4: 1 }, { n4: 2 }]);
      return db
        .select({ n4: rows.n4 })
        .from(rows)
        .orderBy(rows.n4)
        .limit(2)
        .offset(1);
    });
  });

  it('where ... in (...)', async () => {
    await same(async db => {
      await db.insert(rows).values([{ n4: 1 }, { n4: 2 }, { n4: 3 }]);
      return db
        .select({ n4: rows.n4 })
        .from(rows)
        .where(inArray(rows.n4, [1, 3]))
        .orderBy(rows.n4);
    });
  });

  it('aggregates', async () => {
    await same(async db => {
      await db.insert(rows).values([
        { n4: 1, num: '1.5' },
        { n4: 2, num: '2.5' },
      ]);
      return db
        .select({
          count: sql`count(*)`.mapWith(Number),
          total: sql`sum(${rows.n4})`,
          numTotal: sql`sum(${rows.num})`,
          avg: sql`avg(${rows.n4})`,
        })
        .from(rows);
    });
  });

  it('$count', async () => {
    await same(async db => {
      await db.insert(rows).values([{ n4: 1 }, { n4: 2 }]);
      return db.$count(rows);
    });
  });

  it('a parameter inside a sql template', async () => {
    await same(async db => {
      await db.insert(rows).values(ROW);
      return db
        .select({ v: sql`coalesce(${rows.name}, ${'fallback'})` })
        .from(rows);
    });
  });

  it('a prepared statement with a placeholder', async () => {
    await same(async db => {
      await db.insert(rows).values([{ n4: 1 }, { n4: 2 }]);
      const prepared = db
        .select({ n4: rows.n4 })
        .from(rows)
        .where(eq(rows.n4, sql.placeholder('n4')))
        .prepare('by_n4');
      return prepared.execute({ n4: 2 });
    });
  });
});
