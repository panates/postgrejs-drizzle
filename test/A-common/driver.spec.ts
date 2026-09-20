import { DefaultLogger } from 'drizzle-orm/logger';
import { expect } from 'expect';
import { Pool } from 'postgrejs';
import { drizzle, PgjsDatabase } from '../../src/index.js';
import { FakeClient } from '../_support/fakes.js';
import { users } from '../_support/schema.js';

describe('drizzle()', () => {
  describe('what it accepts', () => {
    it('takes a client directly', () => {
      const client = new FakeClient();
      const db = drizzle(client as any);
      expect(db).toBeInstanceOf(PgjsDatabase);
      expect(db.$client).toBe(client);
    });

    it('takes a client under `client`', () => {
      const client = new FakeClient();
      expect(drizzle({ client: client as any }).$client).toBe(client);
    });

    it('opens a pool from a connection string', async () => {
      const db = drizzle('postgres://someone:secret@db.example:5439/shop');
      const pool = db.$client as Pool;
      expect(pool).toBeInstanceOf(Pool);
      expect(pool.config.host).toStrictEqual('db.example');
      expect(pool.config.port).toStrictEqual(5439);
      expect(pool.config.database).toStrictEqual('shop');
      await pool.close();
    });

    it('opens a pool from `connection` as a string', async () => {
      const db = drizzle({
        connection: 'postgres://someone:secret@db.example:5439/shop',
      });
      const pool = db.$client as Pool;
      expect(pool.config.port).toStrictEqual(5439);
      await pool.close();
    });

    it('opens a pool from `connection` as PostgreJS options', async () => {
      const db = drizzle({
        connection: { host: 'db.example', port: 5439, database: 'shop' },
      });
      const pool = db.$client as Pool;
      expect(pool.config.host).toStrictEqual('db.example');
      await pool.close();
    });

    /**
     * `connectionString` is not one of PostgreJS's options - it takes the
     * string as its first argument - and PostgreJS ignores an option it
     * does not know, so passing it through would silently open a pool on
     * localhost:5432/postgres. It is `pg`'s spelling and drizzle's
     * documented one, so it is translated here instead.
     */
    it("translates pg's `connectionString` rather than dropping it", async () => {
      const db = drizzle({
        connection: {
          connectionString: 'postgres://someone:secret@db.example:5439/shop',
        },
      });
      const pool = db.$client as Pool;
      expect(pool.config.host).toStrictEqual('db.example');
      expect(pool.config.port).toStrictEqual(5439);
      expect(pool.config.database).toStrictEqual('shop');
      await pool.close();
    });

    it('lets the other pool options stand beside it', async () => {
      const db = drizzle({
        connection: {
          connectionString: 'postgres://someone:secret@db.example:5439/shop',
          max: 7,
        },
      });
      const pool = db.$client as Pool;
      expect(pool.config.host).toStrictEqual('db.example');
      expect(pool.config.max).toStrictEqual(7);
      await pool.close();
    });
  });

  describe('logging', () => {
    it('logs nothing by default', async () => {
      const client = new FakeClient();
      const db = drizzle(client as any);
      await db.select().from(users);
      expect(client.queries).toHaveLength(1);
    });

    it("takes `logger: true` as drizzle's own logger", () => {
      const db = drizzle(new FakeClient() as any, { logger: true });
      expect((db as any).session._logger).toBeInstanceOf(DefaultLogger);
    });

    it('takes a logger of its own', async () => {
      const logged: { query: string; params: unknown[] }[] = [];
      const client = new FakeClient();
      const db = drizzle(client as any, {
        logger: { logQuery: (query, params) => logged.push({ query, params }) },
      });
      await db.select().from(users);
      expect(logged).toHaveLength(1);
      expect(logged[0]!.query).toStrictEqual(
        'select "id", "name", "age" from "users"',
      );
    });

    /**
     * `logger: false` is not a logger, and `??` would keep it - which is
     * how a `false` reaches logQuery() and takes the whole driver down.
     */
    it('takes `logger: false` as off rather than as a logger', async () => {
      const client = new FakeClient();
      const db = drizzle(client as any, { logger: false });
      await expect(db.select().from(users)).resolves.toBeDefined();
    });
  });

  describe('schema', () => {
    it('exposes relational queries when given a schema', () => {
      const db = drizzle(new FakeClient() as any, { schema: { users } });
      expect((db.query as any).users).toBeDefined();
    });
  });
});
