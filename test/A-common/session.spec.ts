import { expect } from 'expect';
import { commandResult, FakeClient, FakePool } from '../_support/fakes.js';
import { fakeDb, users } from '../_support/schema.js';

describe('session', () => {
  describe('transactions', () => {
    let pool: FakePool;

    beforeEach(() => {
      pool = new FakePool();
    });

    /**
     * The statements go through the session's own query path rather than
     * PostgreJS's `startTransaction()`/`commit()`, which is the only way
     * drizzle's logger and any tracing see them at all.
     */
    it('sends begin and commit as SQL', async () => {
      await fakeDb(pool).transaction(async tx => {
        await tx.select().from(users);
      });
      expect(pool.sqls).toStrictEqual([
        'begin',
        'select "id", "name", "age" from "users"',
        'commit',
      ]);
    });

    it('rolls back and rethrows when the block throws', async () => {
      const boom = new Error('boom');
      await expect(
        fakeDb(pool).transaction(async () => {
          throw boom;
        }),
      ).rejects.toBe(boom);
      expect(pool.sqls).toStrictEqual(['begin', 'rollback']);
    });

    it('appends the isolation settings drizzle was given', async () => {
      await fakeDb(pool).transaction(async () => {}, {
        isolationLevel: 'serializable',
        accessMode: 'read only',
        deferrable: true,
      });
      expect(pool.sqls[0]).toStrictEqual(
        'begin isolation level serializable read only deferrable',
      );
    });

    /**
     * A transaction has to stay on one connection. `pool.query()` is free
     * to pick a different one per call, which would scatter the statements
     * across several.
     */
    it('checks one connection out and gives it back', async () => {
      await fakeDb(pool).transaction(async tx => {
        await tx.select().from(users);
      });
      expect(pool.acquired).toHaveLength(1);
      expect(pool.released).toStrictEqual(pool.acquired);
    });

    it('gives the connection back even when the block throws', async () => {
      await fakeDb(pool)
        .transaction(async () => {
          throw new Error('boom');
        })
        .catch(() => undefined);
      expect(pool.released).toStrictEqual(pool.acquired);
    });

    it('runs every statement on the connection, not on the pool', async () => {
      await fakeDb(pool).transaction(async tx => {
        await tx.select().from(users);
      });
      expect(pool.connection.sqls).toStrictEqual(pool.sqls);
    });

    it('acquires nothing when the client is a single connection', async () => {
      const client = new FakeClient();
      await fakeDb(client).transaction(async tx => {
        await tx.select().from(users);
      });
      expect(client.sqls).toStrictEqual([
        'begin',
        'select "id", "name", "age" from "users"',
        'commit',
      ]);
    });

    describe('savepoints', () => {
      it('names them by nesting depth, unquoted', async () => {
        await fakeDb(pool).transaction(async tx => {
          await tx.transaction(async tx2 => {
            await tx2.transaction(async () => {});
          });
        });
        expect(pool.sqls).toStrictEqual([
          'begin',
          'savepoint sp1',
          'savepoint sp2',
          'release savepoint sp2',
          'release savepoint sp1',
          'commit',
        ]);
      });

      it('rolls back to the savepoint, leaving the transaction open', async () => {
        await fakeDb(pool).transaction(async tx => {
          await tx
            .transaction(async () => {
              throw new Error('boom');
            })
            .catch(() => undefined);
          await tx.select().from(users);
        });
        expect(pool.sqls).toStrictEqual([
          'begin',
          'savepoint sp1',
          'rollback to savepoint sp1',
          'select "id", "name", "age" from "users"',
          'commit',
        ]);
      });
    });
  });

  describe('count()', () => {
    /**
     * The inherited one reads `res[0].count`, which is right for a driver
     * whose execute() resolves to an array of rows. This one resolves to a
     * result object, so the count is a row inside it.
     */
    it('reads the count out of the result object', async () => {
      const client = new FakeClient();
      client.queryResult = commandResult({ rows: [{ count: '4' }] });
      expect(await fakeDb(client).$count(users)).toStrictEqual(4);
    });

    it('answers a number even though the server sent a string', async () => {
      const client = new FakeClient();
      client.queryResult = commandResult({ rows: [{ count: '0' }] });
      const count = await fakeDb(client).$count(users);
      expect(typeof count).toStrictEqual('number');
      expect(count).toStrictEqual(0);
    });
  });

  describe('prepared statement names', () => {
    it('ignores the name drizzle passes - PostgreJS caches on its own', async () => {
      const client = new FakeClient();
      await fakeDb(client).select().from(users).prepare('by_name').execute();
      const options = client.queries[0]!.options as Record<string, any>;
      expect(options.name).toBeUndefined();
    });
  });
});
