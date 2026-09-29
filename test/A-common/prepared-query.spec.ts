import { sql } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { expect } from 'expect';
import { DatabaseError } from 'postgrejs';
import { MULTIPLE_COMMANDS_ERROR_CODE } from '../../src/constants.js';
import { commandResult, FakeClient } from '../_support/fakes.js';
import { fakeDb, users } from '../_support/schema.js';

/** A `DatabaseError` carrying the SQLSTATE a test is about. */
function databaseError(code: string, message = 'boom'): DatabaseError {
  return new DatabaseError({ severity: 'ERROR', code, message } as any);
}

describe('prepared query', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
  });

  describe('row mode', () => {
    /**
     * Two shapes, chosen by what drizzle passed in. `mapResultRow` indexes
     * a row positionally, so anything it maps has to arrive as an array;
     * `db.execute()` hands its result straight to the caller, so those
     * rows are objects.
     */
    it('asks for array rows when drizzle maps them itself', async () => {
      client.queryResult = commandResult({ rows: [[1, 'ada', 7]] });
      await fakeDb(client).select().from(users);
      expect(
        (client.queries[0]!.options as Record<string, any>).objectRows,
      ).toBe(false);
    });

    it('asks for object rows for db.execute()', async () => {
      await fakeDb(client).execute(sql`select 1`);
      expect(
        (client.queries[0]!.options as Record<string, any>).objectRows,
      ).toBe(true);
    });

    it('maps an array row onto the selected fields', async () => {
      client.queryResult = commandResult({ rows: [[1, 'ada', 7]] });
      const rows = await fakeDb(client).select().from(users);
      expect(rows).toStrictEqual([{ id: 1, name: 'ada', age: 7 }]);
    });

    it('hands db.execute() a pg-shaped result', async () => {
      client.queryResult = commandResult({
        command: 'INSERT',
        rowsAffected: 2,
        rows: [],
      });
      const result = await fakeDb(client).execute(
        sql`insert into t values (1)`,
      );
      expect(result).toStrictEqual({
        command: 'INSERT',
        commandTag: 'INSERT',
        rowCount: 2,
        rows: [],
        fields: [],
      });
    });
  });

  describe('parameters', () => {
    it('wraps them so the server picks the type', async () => {
      await fakeDb(client)
        .select()
        .from(users)
        .where(sql`${users.name} = ${'ada'}`);
      const params = (client.queries[0]!.options as Record<string, any>).params;
      expect(params).toHaveLength(1);
      expect(params[0].oid).toStrictEqual(0);
      expect(params[0].value).toStrictEqual('ada');
    });

    it('fills placeholders before sending', async () => {
      const prepared = fakeDb(client)
        .select()
        .from(users)
        .where(sql`${users.age} = ${sql.placeholder('age')}`)
        .prepare('by_age');
      await prepared.execute({ age: 7 });
      const params = (client.queries[0]!.options as Record<string, any>).params;
      expect(params[0].value).toStrictEqual(7);
    });
  });

  describe('multi-statement db.execute()', () => {
    /**
     * `query()` is the extended protocol, which takes one statement.
     * PostgreJS answers which of the two a string needs, so the choice is
     * made before anything is sent - one round trip rather than a refused
     * one and then a retry.
     */
    it('routes straight to execute(), without asking query() first', async () => {
      client.scriptResult = {
        totalCommands: 2,
        results: [
          commandResult({ command: 'INSERT', rowsAffected: 1 }),
          commandResult({ command: 'SELECT', rows: [{ n: 3 }] }),
        ],
      };
      const result = await fakeDb(client).execute(
        sql`insert into t values (1); select count(*) as n from t`,
      );
      expect(Array.isArray(result)).toBe(true);
      expect((result as unknown as any[]).map(r => r.command)).toStrictEqual([
        'INSERT',
        'SELECT',
      ]);
      expect(client.calls.map(call => call.method)).toStrictEqual(['execute']);
    });

    it('carries the same options into execute()', async () => {
      await fakeDb(client).execute(sql`select 1; select 2`);
      const options = client.calls[0]!.options as Record<string, any>;
      expect(options.rollbackOnError).toBe(false);
      expect(options.unknownTypesAsString).toBe(true);
      expect(options.objectRows).toBe(true);
    });

    /**
     * A `;` inside a literal, an identifier, a dollar-quoted body or a
     * comment is not a second statement, and a query that lost its
     * prepared plan to a scanner that thought otherwise would be a silent
     * cost. Each of these has to stay on `query()`.
     */
    const singles: [string, string][] = [
      ['a string literal', `select 'a; b' as v`],
      ['a quoted identifier', `select 1 as "a; b"`],
      ['a dollar-quoted body', `select $tag$a; b$tag$ as v`],
      ['a line comment', `select 1 -- a; b`],
      ['a block comment', `select 1 /* a; b */`],
      ['a trailing semicolon', `select 1;`],
    ];

    for (const [what, statement] of singles) {
      it(`keeps a single statement with ${what} on query()`, async () => {
        await fakeDb(client).execute(sql.raw(statement));
        expect(client.calls.map(call => call.method)).toStrictEqual(['query']);
      });
    }

    /**
     * The scanner reads `\'` as an escape, which it is not under
     * `standard_conforming_strings = off`, so the server can still answer
     * 42601 where this side saw one statement. It raises that while
     * parsing, before anything has run, so the retry repeats no side
     * effect.
     */
    it('still falls back to execute() when the server answers 42601', async () => {
      client.queryResult = databaseError(MULTIPLE_COMMANDS_ERROR_CODE);
      await fakeDb(client).execute(sql`select 1`);
      expect(client.calls.map(call => call.method)).toStrictEqual([
        'query',
        'execute',
      ]);
    });

    it('does not retry when there are parameters - execute() takes none', async () => {
      client.queryResult = databaseError(MULTIPLE_COMMANDS_ERROR_CODE);
      await expect(fakeDb(client).execute(sql`select ${1}`)).rejects.toThrow(
        DrizzleQueryError,
      );
      expect(client.calls.map(call => call.method)).toStrictEqual(['query']);
    });

    /**
     * Several statements *with* parameters cannot work either way, so the
     * server's own error is the better one to surface.
     */
    it('lets the server answer a multi-statement call that has parameters', async () => {
      client.queryResult = databaseError(MULTIPLE_COMMANDS_ERROR_CODE);
      await expect(
        fakeDb(client).execute(sql`select ${1}; select 2`),
      ).rejects.toThrow(DrizzleQueryError);
      expect(client.calls.map(call => call.method)).toStrictEqual(['query']);
    });

    it('does not retry any other error', async () => {
      client.queryResult = databaseError('42P01', 'relation does not exist');
      await expect(fakeDb(client).execute(sql`select 1`)).rejects.toThrow(
        DrizzleQueryError,
      );
      expect(client.calls.map(call => call.method)).toStrictEqual(['query']);
    });
  });

  /**
   * `all`, `isResponseInArrayMode` and the customResultMapper branch are
   * all reached by drizzle and none of them survives `stripInternal` in
   * its published types - see src/drizzle-internals.ts. Nothing about them
   * is optional, so they are asserted here rather than assumed.
   */
  describe('the members drizzle calls but does not declare', () => {
    it('all() answers object rows, unmapped', async () => {
      client.queryResult = commandResult({ rows: [{ id: 1, name: 'ada' }] });
      const session = (fakeDb(client) as any).session;
      const rows = await session.all(sql`select id, name from users`);
      expect(rows).toStrictEqual([{ id: 1, name: 'ada' }]);
      expect(
        (client.queries[0]!.options as Record<string, any>).objectRows,
      ).toBe(true);
    });

    it('all() answers an empty array when the server sent no rows', async () => {
      client.queryResult = commandResult({ rows: undefined });
      const session = (fakeDb(client) as any).session;
      expect(await session.all(sql`select 1`)).toStrictEqual([]);
    });

    it('isResponseInArrayMode() echoes the flag it was given', () => {
      const session = (fakeDb(client) as any).session;
      const { sql: text, params } = { sql: 'select 1', params: [] };
      expect(
        session
          .prepareQuery({ sql: text, params }, undefined, undefined, true)
          .isResponseInArrayMode(),
      ).toBe(true);
      expect(
        session
          .prepareQuery({ sql: text, params }, undefined, undefined, false)
          .isResponseInArrayMode(),
      ).toBe(false);
    });

    it('hands array rows to a customResultMapper instead of mapping them', async () => {
      client.queryResult = commandResult({ rows: [[1, 'ada']] });
      const session = (fakeDb(client) as any).session;
      const seen: unknown[][] = [];
      const prepared = session.prepareQuery(
        { sql: 'select id, name from users', params: [] },
        undefined,
        undefined,
        false,
        (rows: unknown[][]) => {
          seen.push(...rows);
          return 'mapped';
        },
      );
      expect(await prepared.execute()).toStrictEqual('mapped');
      expect(seen).toStrictEqual([[1, 'ada']]);
      expect(
        (client.queries[0]!.options as Record<string, any>).objectRows,
      ).toBe(false);
    });
  });

  describe('errors', () => {
    it('wraps a driver error in DrizzleQueryError, with the original as cause', async () => {
      // Drizzle produces this in queryWithCache(), which is why every call
      // goes through it even with no cache configured.
      const original = databaseError('42703', 'column does not exist');
      client.queryResult = original;
      await expect(fakeDb(client).select().from(users)).rejects.toThrow(
        DrizzleQueryError,
      );
      await fakeDb(client)
        .select()
        .from(users)
        .catch((error: DrizzleQueryError) => {
          expect(error.cause).toBe(original);
          expect((error.cause as DatabaseError).code).toStrictEqual('42703');
        });
    });
  });
});
