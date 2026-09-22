import { sql } from 'drizzle-orm';
import { expect } from 'expect';
import { Connection } from 'postgrejs';
import { drizzle } from '../../src/index.js';

/**
 * PostgreJS prepares a statement on first sight and keeps it in a
 * per-connection cache, so the SQL drizzle writes is parsed once and
 * executed by name after that - without the caller naming anything. The
 * README says so; this is what it says it against.
 *
 * A `Connection` rather than a `Pool`, because the cache belongs to the
 * connection and a pool would answer from whichever one it handed out.
 */
describe('live: prepared statements', () => {
  let connection: Connection;

  const count = async (): Promise<number> => {
    const result = await connection.query(
      `select count(*)::int as n from pg_prepared_statements`,
      { objectRows: true },
    );
    return (result.rows as { n: number }[])[0]!.n;
  };

  beforeEach(async () => {
    connection = new Connection();
    await connection.connect();
  });

  afterEach(async () => {
    await connection?.close();
  });

  it('prepares the statement once and reuses it', async () => {
    const db = drizzle(connection, { logger: false });
    for (let i = 0; i < 3; i++)
      await db.execute(sql`select ${i}::int as v, 'x' as t`);
    expect(await count()).toStrictEqual(1);
  });

  it('keeps them out of the cache when asked', async () => {
    const db = drizzle(connection, { logger: false, prepare: false });
    for (let i = 0; i < 3; i++)
      await db.execute(sql`select ${i}::int as v, 'x' as t`);
    expect(await count()).toStrictEqual(0);
  });
});
