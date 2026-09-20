import { sql, TransactionRollbackError } from 'drizzle-orm';
import { integer, pgSchema, serial, text } from 'drizzle-orm/pg-core';
import { expect } from 'expect';
import type { DatabaseError } from 'postgrejs';
import { type LiveDb, openLiveDb } from '../_support/live.js';

const schema = pgSchema('drizzle_pgjs_tx');
const rows = schema.table('rows', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  n: integer('n'),
});

describe('live: transactions', () => {
  let live: LiveDb;

  before(async () => {
    live = await openLiveDb('drizzle_pgjs_tx');
    await live.db.execute(
      sql`create table ${rows} (id serial primary key, name text not null, n integer)`,
    );
  });

  after(async () => {
    await live?.close();
  });

  beforeEach(async () => {
    await live.db.execute(sql`truncate ${rows} restart identity`);
  });

  async function names(): Promise<string[]> {
    const result = await live.db
      .select({ name: rows.name })
      .from(rows)
      .orderBy(rows.name);
    return result.map(row => row.name);
  }

  it('commits what the block did', async () => {
    await live.db.transaction(async tx => {
      await tx.insert(rows).values({ name: 'a' });
      await tx.insert(rows).values({ name: 'b' });
    });
    expect(await names()).toStrictEqual(['a', 'b']);
  });

  it('rolls the whole block back when it throws', async () => {
    await expect(
      live.db.transaction(async tx => {
        await tx.insert(rows).values({ name: 'a' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await names()).toStrictEqual([]);
  });

  it('rolls back on tx.rollback(), which drizzle signals by throwing', async () => {
    await expect(
      live.db.transaction(async tx => {
        await tx.insert(rows).values({ name: 'a' });
        tx.rollback();
      }),
    ).rejects.toThrow(TransactionRollbackError);
    expect(await names()).toStrictEqual([]);
  });

  /**
   * PostgreJS puts a savepoint around every statement inside a transaction
   * by default, so a failed one leaves the block usable - which is neither
   * PostgreSQL's own rule nor what a drizzle user expects. The driver
   * turns that off, so this behaves the way it does under `pg`.
   */
  it('aborts the block after a failed statement, as PostgreSQL does', async () => {
    let second: unknown;
    await live.db
      .transaction(async tx => {
        await tx.insert(rows).values({ name: 'a' });
        await tx.execute(sql`select 1 / 0`).catch(() => undefined);
        second = await tx
          .insert(rows)
          .values({ name: 'b' })
          .catch((error: Error) => error);
      })
      .catch(() => undefined);
    // The message a user reads is on the cause - DrizzleQueryError's own
    // is the SQL it failed on.
    expect(String(((second as Error).cause as Error).message)).toContain(
      'current transaction is aborted',
    );
    expect(await names()).toStrictEqual([]);
  });

  it('sees its own uncommitted rows', async () => {
    await live.db.transaction(async tx => {
      await tx.insert(rows).values({ name: 'a' });
      const inside = await tx.select({ name: rows.name }).from(rows);
      expect(inside).toStrictEqual([{ name: 'a' }]);
    });
  });

  it('takes an isolation level the server accepts', async () => {
    await live.db.transaction(
      async tx => {
        await tx.insert(rows).values({ name: 'a' });
      },
      { isolationLevel: 'serializable', deferrable: false },
    );
    expect(await names()).toStrictEqual(['a']);
  });

  it('refuses to write under a read-only transaction', async () => {
    const error = await live.db
      .transaction(
        async tx => {
          await tx.insert(rows).values({ name: 'a' });
        },
        { accessMode: 'read only' },
      )
      .catch((thrown: Error) => thrown);
    expect((error as Error).constructor.name).toStrictEqual(
      'DrizzleQueryError',
    );
    expect(((error as Error).cause as DatabaseError).code).toStrictEqual(
      '25006',
    );
  });

  describe('savepoints', () => {
    it('keeps the outer work when an inner block fails', async () => {
      await live.db.transaction(async tx => {
        await tx.insert(rows).values({ name: 'outer' });
        await tx
          .transaction(async inner => {
            await inner.insert(rows).values({ name: 'inner' });
            throw new Error('boom');
          })
          .catch(() => undefined);
      });
      expect(await names()).toStrictEqual(['outer']);
    });

    it('commits both when the inner block succeeds', async () => {
      await live.db.transaction(async tx => {
        await tx.insert(rows).values({ name: 'outer' });
        await tx.transaction(async inner => {
          await inner.insert(rows).values({ name: 'inner' });
        });
      });
      expect(await names()).toStrictEqual(['inner', 'outer']);
    });

    it('nests more than one deep', async () => {
      await live.db.transaction(async tx => {
        await tx.insert(rows).values({ name: 'a' });
        await tx.transaction(async second => {
          await second.insert(rows).values({ name: 'b' });
          await second
            .transaction(async third => {
              await third.insert(rows).values({ name: 'c' });
              throw new Error('boom');
            })
            .catch(() => undefined);
        });
      });
      expect(await names()).toStrictEqual(['a', 'b']);
    });
  });

  /**
   * A transaction has to stay on one connection. If it did not, these
   * statements would be spread over the pool and the inserts would not be
   * visible to the select that follows them.
   */
  it('holds one connection for the whole block, and gives it back', async () => {
    const before = live.pool.acquiredConnections;
    await live.db.transaction(async tx => {
      expect(live.pool.acquiredConnections).toBeGreaterThan(before);
      await tx.insert(rows).values({ name: 'a' });
    });
    expect(live.pool.acquiredConnections).toStrictEqual(before);
  });

  it('gives the connection back after a failed block too', async () => {
    const before = live.pool.acquiredConnections;
    await live.db
      .transaction(async () => {
        throw new Error('boom');
      })
      .catch(() => undefined);
    expect(live.pool.acquiredConnections).toStrictEqual(before);
  });
});
