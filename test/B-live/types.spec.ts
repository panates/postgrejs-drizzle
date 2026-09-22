import { sql } from 'drizzle-orm';
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
import { type LiveDb, openLiveDb } from '../_support/live.js';

const schema = pgSchema('drizzle_pgjs_types');

/**
 * The value shapes this driver exists to get right.
 *
 * Every expectation here is what `drizzle-orm/node-postgres` produces for
 * the same column and the same stored value, measured against a live
 * server. They are spelled out rather than compared against `pg` at run
 * time so that a change in PostgreJS's decoding names itself: the failing
 * assertion says which type moved and what it moved to.
 */
describe('live: value shapes', () => {
  let live: LiveDb;

  before(async () => {
    live = await openLiveDb('drizzle_pgjs_types');
  });

  after(async () => {
    await live?.close();
  });

  describe('types PostgreJS decodes into a shape drizzle does not expect', () => {
    const table = schema.table('scalars', {
      id: serial('id').primaryKey(),
      num: numeric('num', { precision: 40, scale: 6 }),
      bigNumber: bigint('big_number', { mode: 'number' }),
      bigBig: bigint('big_big', { mode: 'bigint' }),
      ts: timestamp('ts'),
      tsString: timestamp('ts_string', { mode: 'string' }),
      tstz: timestamp('tstz', { withTimezone: true }),
      dt: date('dt'),
      dtString: date('dt_string', { mode: 'string' }),
      tm: time('tm'),
      iv: interval('iv'),
      pt: point('pt', { mode: 'xy' }),
      ptTuple: point('pt_tuple', { mode: 'tuple' }),
    });

    before(async () => {
      await live.db.execute(sql`
        create table ${table} (
          id serial primary key, num numeric(40,6), big_number bigint,
          big_big bigint, ts timestamp, ts_string timestamp,
          tstz timestamptz, dt date, dt_string date, tm time,
          iv interval, pt point, pt_tuple point)
      `);
    });

    it('keeps every digit of a numeric a double could not hold', async () => {
      const value = '1234567890123456789012345678.123456';
      await live.db.insert(table).values({ id: 1, num: value });
      const [row] = await live.db
        .select({ num: table.num })
        .from(table)
        .where(sql`${table.id} = 1`);
      expect(row!.num).toStrictEqual(value);
    });

    it('reads a timestamp as the wall time the server holds, in UTC', async () => {
      // PostgreJS decodes the binary form into a Date read in the local
      // zone, which is a different instant for the same stored value.
      const ts = new Date('2024-03-05T06:07:08.900Z');
      await live.db
        .insert(table)
        .values({ id: 2, ts, tsString: '2024-03-05 06:07:08.9' });
      const [row] = await live.db
        .select({ ts: table.ts, tsString: table.tsString })
        .from(table)
        .where(sql`${table.id} = 2`);
      expect(row!.ts).toStrictEqual(ts);
      expect(row!.tsString).toStrictEqual('2024-03-05 06:07:08.9');
    });

    it('round-trips a timestamptz to the same instant', async () => {
      const tstz = new Date('2024-03-05T06:07:08.900Z');
      await live.db.insert(table).values({ id: 3, tstz });
      const [row] = await live.db
        .select({ tstz: table.tstz })
        .from(table)
        .where(sql`${table.id} = 3`);
      expect(row!.tstz).toStrictEqual(tstz);
    });

    it('does not shift a date a day in string mode', async () => {
      // The Date PostgreJS builds is local midnight; drizzle renders a
      // date string from its UTC parts, which moves it west of Greenwich.
      await live.db.insert(table).values({ id: 4, dtString: '2024-03-05' });
      const [row] = await live.db
        .select({ dtString: table.dtString })
        .from(table)
        .where(sql`${table.id} = 4`);
      expect(row!.dtString).toStrictEqual('2024-03-05');
    });

    it('answers a time and an interval as strings, which is all drizzle types them as', async () => {
      await live.db
        .insert(table)
        .values({ id: 5, tm: '06:07:08.9', iv: '1 day 02:03:04' });
      const [row] = await live.db
        .select({ tm: table.tm, iv: table.iv })
        .from(table)
        .where(sql`${table.id} = 5`);
      expect(row!.tm).toStrictEqual('06:07:08.9');
      expect(row!.iv).toStrictEqual('1 day 02:03:04');
    });

    /**
     * drizzle's `line` column parses `{a,b,c}` out of a string and copes
     * with nothing else, and PostgreJS is in the middle of giving the
     * geometric family classes of their own - so this is asked for as text
     * before it has to be.
     */
    it('answers a line as the string drizzle parses it from', async () => {
      await live.db.execute(sql`alter table ${table} add column ln line`);
      await live.db.execute(
        sql`insert into ${table} (id, ln) values (20, '{1,2,3}')`,
      );
      const result = await live.db.execute<{ ln: string }>(
        sql`select ln from ${table} where id = 20`,
      );
      expect(result.rows[0]!.ln).toStrictEqual('{1,2,3}');
    });

    it('answers a point as a plain object, not a Point instance', async () => {
      await live.db
        .insert(table)
        .values({ id: 6, pt: { x: 24.5, y: 49.6 }, ptTuple: [1.5, 2.5] });
      const [row] = await live.db
        .select({ pt: table.pt, ptTuple: table.ptTuple })
        .from(table)
        .where(sql`${table.id} = 6`);
      expect(row!.pt).toStrictEqual({ x: 24.5, y: 49.6 });
      expect(Object.getPrototypeOf(row!.pt)).toBe(Object.prototype);
      expect(row!.ptTuple).toStrictEqual([1.5, 2.5]);
    });

    it('answers a bigint in whichever mode the column asked for', async () => {
      await live.db.insert(table).values({
        id: 7,
        bigNumber: 42,
        bigBig: 9007199254740993n,
      });
      const [row] = await live.db
        .select({ bigNumber: table.bigNumber, bigBig: table.bigBig })
        .from(table)
        .where(sql`${table.id} = 7`);
      expect(row!.bigNumber).toStrictEqual(42);
      expect(row!.bigBig).toStrictEqual(9007199254740993n);
    });
  });

  describe('types PostgreJS decodes the way drizzle expects', () => {
    const table = schema.table('plain', {
      id: serial('id').primaryKey(),
      txt: text('txt'),
      vc: varchar('vc', { length: 20 }),
      n4: integer('n4'),
      r: real('r'),
      d8: doublePrecision('d8'),
      flag: boolean('flag'),
      u: uuid('u'),
      j: json('j'),
      jb: jsonb('jb'),
    });

    before(async () => {
      await live.db.execute(sql`
        create table ${table} (
          id serial primary key, txt text, vc varchar(20), n4 integer,
          r real, d8 double precision, flag boolean, u uuid, j json, jb jsonb)
      `);
    });

    it('round-trips them unchanged', async () => {
      const values = {
        id: 1,
        txt: 'ada',
        vc: 'v',
        n4: 7,
        r: 1.5,
        d8: 2.5,
        flag: true,
        u: '11111111-2222-3333-4444-555555555555',
        j: { a: 1, b: [1, 2] },
        jb: { a: 1, b: [1, 2] },
      };
      await live.db.insert(table).values(values);
      const [row] = await live.db.select().from(table);
      expect(row).toStrictEqual(values);
    });
  });

  describe('arrays', () => {
    const table = schema.table('arrays', {
      id: serial('id').primaryKey(),
      ints: integer('ints').array(),
      texts: text('texts').array(),
      nums: numeric('nums').array(),
      stamps: timestamp('stamps', { mode: 'string' }).array(),
      times: time('times').array(),
      intervals: interval('intervals').array(),
    });

    before(async () => {
      await live.db.execute(sql`
        create table ${table} (
          id serial primary key, ints integer[], texts text[], nums numeric[],
          stamps timestamp[], times time[], intervals interval[])
      `);
    });

    it('round-trips element shapes, empty strings included', async () => {
      const values = {
        id: 1,
        ints: [1, 2, 3],
        // An empty element used to vanish from a text-decoded array, taking
        // every later index with it.
        texts: ['', 'b', 'c'],
        nums: ['1.50', '2.50'],
        stamps: ['2024-03-05 06:07:08'],
        times: ['06:07:08'],
        intervals: ['1 day'],
      };
      await live.db.insert(table).values(values);
      const [row] = await live.db.select().from(table);
      expect(row).toStrictEqual(values);
    });

    it('keeps an empty array empty', async () => {
      await live.db.insert(table).values({ id: 2, texts: [] });
      const [row] = await live.db
        .select({ texts: table.texts })
        .from(table)
        .where(sql`${table.id} = 2`);
      expect(row!.texts).toStrictEqual([]);
    });
  });

  describe('types PostgreJS has no decoder for', () => {
    /**
     * Nothing about these is registered anywhere - they arrive as the
     * string the server prints because `unknownTypesAsString` asks for
     * exactly the columns this client could not have decoded.
     */
    before(async () => {
      await live.db.execute(
        sql`create type ${sql.identifier('drizzle_pgjs_types')}.mood as enum ('sad','ok','happy')`,
      );
    });

    it('answers a user-defined enum as its label', async () => {
      const result = await live.db.execute<{ v: string }>(
        sql`select 'happy'::drizzle_pgjs_types.mood as v`,
      );
      expect(result.rows[0]!.v).toStrictEqual('happy');
    });

    it('answers an enum array as the literal, as pg does', async () => {
      const result = await live.db.execute<{ v: string }>(
        sql`select array['happy','sad']::drizzle_pgjs_types.mood[] as v`,
      );
      expect(result.rows[0]!.v).toStrictEqual('{happy,sad}');
    });

    /**
     * Where this driver deliberately does not follow `pg`. PostgreJS
     * decodes these; `pg` hands back the text. Drizzle has no column for
     * any of them, so nothing it owns is misread either way - they reach
     * a caller only through a raw `db.execute()`, and there the decoded
     * value is the more useful one. Asserted so that the choice stays a
     * decision rather than becoming an oversight: `point` and `line`, the
     * two of this family drizzle *does* have columns for, are asked for
     * as text and are covered above.
     */
    const decoded: [string, string, string][] = [
      ['int4range', `int4range(1, 5)`, '[1,5)'],
      ['path', `'((1,2),(3,4))'::path`, '((1,2),(3,4))'],
      ['polygon', `'((1,2),(3,4),(5,6))'::polygon`, '((1,2),(3,4),(5,6))'],
      ['circle', `'<(1,2),3>'::circle`, '<(1,2),3>'],
      ['lseg', `'[(1,2),(3,4)]'::lseg`, '[(1,2),(3,4)]'],
    ];

    for (const [label, expr, printed] of decoded) {
      it(`answers a ${label} as PostgreJS decodes it, not as pg prints it`, async () => {
        const result = await live.db.execute<{ v: unknown }>(
          sql`select ${sql.raw(expr)} as v`,
        );
        const value = result.rows[0]!.v;
        expect(typeof value).toStrictEqual('object');
        expect(String(value)).toStrictEqual(printed);
      });
    }

    /**
     * `money` is the one worth naming on its own: `pg` gives `"$12.34"`
     * and PostgreJS a number, so the currency rendering is gone rather
     * than merely reshaped. Still no drizzle column, so still only a raw
     * execute() - but a caller who wants the exact decimal has PostgreJS's
     * `decimalAsString`, and one who wants pg's string has `fetchAsString`.
     */
    it('answers money as a number, where pg prints it with its currency', async () => {
      const result = await live.db.execute<{ v: unknown }>(
        sql`select '12.34'::money as v`,
      );
      expect(result.rows[0]!.v).toStrictEqual(12.34);
    });

    it('turns it off when asked, leaving the bytes undecoded', async () => {
      const other = await openLiveDb('drizzle_pgjs_types_raw', {
        unknownTypesAsString: false,
      });
      try {
        await other.db.execute(
          sql`create type ${sql.identifier('drizzle_pgjs_types_raw')}.mood as enum ('sad','happy')`,
        );
        const result = await other.db.execute<{ v: unknown }>(
          sql`select 'happy'::drizzle_pgjs_types_raw.mood as v`,
        );
        expect(Buffer.isBuffer(result.rows[0]!.v)).toBe(true);
      } finally {
        await other.close();
      }
    });
  });
});
