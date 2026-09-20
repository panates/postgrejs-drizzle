import { sql } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { integer, pgSchema, serial, text } from 'drizzle-orm/pg-core';
import { expect } from 'expect';
import type { DatabaseError } from 'postgrejs';
import type { PgjsQueryResult } from '../../src/index.js';
import { type LiveDb, openLiveDb } from '../_support/live.js';

const schema = pgSchema('drizzle_pgjs_execute');
const rows = schema.table('rows', {
  id: serial('id').primaryKey(),
  name: text('name'),
  n: integer('n'),
});

describe('live: db.execute()', () => {
  let live: LiveDb;

  before(async () => {
    live = await openLiveDb('drizzle_pgjs_execute');
  });

  after(async () => {
    await live?.close();
  });

  beforeEach(async () => {
    await live.db.execute(sql`drop table if exists ${rows}`);
    await live.db.execute(
      sql`create table ${rows} (id serial primary key, name text, n integer)`,
    );
  });

  describe('command and commandTag', () => {
    /**
     * `pg` keeps the first word of the tag. Four kinds of CREATE and four
     * kinds of DROP are all `CREATE` and `DROP` there, so `commandTag` is
     * the only place the object type survives.
     */
    const cases: [string, ReturnType<typeof sql>, string, string][] = [
      [
        'create index',
        sql`create index rows_name on ${rows} (name)`,
        'CREATE',
        'CREATE INDEX',
      ],
      [
        'create view',
        sql`create view ${sql.identifier('drizzle_pgjs_execute')}.v as select 1 as a`,
        'CREATE',
        'CREATE VIEW',
      ],
      [
        'alter table',
        sql`alter table ${rows} add column extra int`,
        'ALTER',
        'ALTER TABLE',
      ],
      [
        'insert',
        sql`insert into ${rows} (name) values ('a')`,
        'INSERT',
        'INSERT',
      ],
      [
        'update',
        sql`update ${rows} set name = 'b' where false`,
        'UPDATE',
        'UPDATE',
      ],
      ['delete', sql`delete from ${rows} where false`, 'DELETE', 'DELETE'],
      ['select', sql`select 1 as a`, 'SELECT', 'SELECT'],
      ['truncate', sql`truncate ${rows}`, 'TRUNCATE', 'TRUNCATE TABLE'],
    ];

    for (const [label, query, command, commandTag] of cases) {
      it(`${label} -> ${command} / ${commandTag}`, async () => {
        const result = await live.db.execute(query);
        expect(result.command).toStrictEqual(command);
        expect(result.commandTag).toStrictEqual(commandTag);
      });
    }

    it('drop index -> DROP / DROP INDEX', async () => {
      await live.db.execute(sql`create index rows_n on ${rows} (n)`);
      const result = await live.db.execute(
        sql`drop index ${sql.identifier('drizzle_pgjs_execute')}.rows_n`,
      );
      expect(result.command).toStrictEqual('DROP');
      expect(result.commandTag).toStrictEqual('DROP INDEX');
    });
  });

  describe('rowCount', () => {
    /** `pg` reports the command tag's count whatever the command was. */
    beforeEach(async () => {
      await live.db.execute(
        sql`insert into ${rows} (name) values ('a'),('b'),('c')`,
      );
    });

    it('counts the rows a select returned', async () => {
      const result = await live.db.execute(sql`select * from ${rows}`);
      expect(result.rowCount).toStrictEqual(3);
      expect(result.rows).toHaveLength(3);
    });

    it('is zero for a select that matched nothing', async () => {
      const result = await live.db.execute(
        sql`select * from ${rows} where false`,
      );
      expect(result.rowCount).toStrictEqual(0);
    });

    it('counts the rows an insert wrote', async () => {
      const result = await live.db.execute(
        sql`insert into ${rows} (name) values ('d'),('e')`,
      );
      expect(result.rowCount).toStrictEqual(2);
      expect(result.rows).toStrictEqual([]);
    });

    it('counts what RETURNING gave back, not twice', async () => {
      const result = await live.db.execute(
        sql`insert into ${rows} (name) values ('d') returning id`,
      );
      expect(result.rowCount).toStrictEqual(1);
      expect(result.rows).toHaveLength(1);
    });

    it('is zero for an update that matched nothing', async () => {
      const result = await live.db.execute(
        sql`update ${rows} set n = 1 where false`,
      );
      expect(result.rowCount).toStrictEqual(0);
    });

    it('is null for a command that carries no count', async () => {
      const result = await live.db.execute(sql`create temp table t_rc (a int)`);
      expect(result.rowCount).toBeNull();
    });
  });

  describe('more than one statement', () => {
    /**
     * `pg` takes these because a parameterless query goes over the simple
     * protocol. PostgreJS's `query()` is always the extended one and says
     * 42601, so the driver retries through `execute()` - which is safe
     * because the server raises it while parsing, before anything ran.
     */
    it('answers with one result per statement, as pg does', async () => {
      const result = (await live.db.execute(
        sql`insert into ${rows} (name) values ('a'); insert into ${rows} (name) values ('b'); select count(*)::int as n from ${rows}`,
      )) as unknown as PgjsQueryResult<{ n: number }>[];
      expect(Array.isArray(result)).toBe(true);
      expect(
        result.map(entry => [entry.command, entry.rowCount]),
      ).toStrictEqual([
        ['INSERT', 1],
        ['INSERT', 1],
        ['SELECT', 1],
      ]);
      expect(result[2]!.rows[0]!.n).toStrictEqual(2);
    });

    it('runs DDL and DML together', async () => {
      const result = (await live.db.execute(
        sql`create table ${sql.identifier('drizzle_pgjs_execute')}.multi (a int); insert into ${sql.identifier('drizzle_pgjs_execute')}.multi values (1)`,
      )) as unknown as PgjsQueryResult[];
      expect(result.map(entry => entry.commandTag)).toStrictEqual([
        'CREATE TABLE',
        'INSERT',
      ]);
    });

    it('leaves nothing behind when one of them fails', async () => {
      // The statements share an implicit transaction, so a failure part
      // way through takes the earlier ones with it.
      await expect(
        live.db.execute(
          sql`insert into ${rows} (name) values ('x'); insert into ${rows} (nosuchcolumn) values (1)`,
        ),
      ).rejects.toThrow(DrizzleQueryError);
      const after = await live.db.execute<{ n: number }>(
        sql`select count(*)::int as n from ${rows} where name = 'x'`,
      );
      expect(after.rows[0]!.n).toStrictEqual(0);
    });
  });

  describe('errors', () => {
    it('wraps the driver error and keeps its SQLSTATE on the cause', async () => {
      const error = await live.db
        .execute(sql`select nosuchcolumn from ${rows}`)
        .catch((thrown: DrizzleQueryError) => thrown);
      expect(error).toBeInstanceOf(DrizzleQueryError);
      const cause = (error as DrizzleQueryError).cause as DatabaseError;
      expect(cause.code).toStrictEqual('42703');
      expect(cause.position).toBeGreaterThan(0);
    });

    it('reports a unique violation with the constraint name', async () => {
      await live.db.execute(
        sql`insert into ${rows} (id, name) values (1, 'a')`,
      );
      const error = await live.db
        .execute(sql`insert into ${rows} (id, name) values (1, 'b')`)
        .catch((thrown: DrizzleQueryError) => thrown);
      const cause = (error as DrizzleQueryError).cause as DatabaseError;
      expect(cause.code).toStrictEqual('23505');
      expect(cause.constraint).toStrictEqual('rows_pkey');
    });
  });
});
