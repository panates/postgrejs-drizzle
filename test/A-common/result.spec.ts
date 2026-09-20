import { expect } from 'expect';
import { toQueryResult, toQueryResults } from '../../src/result.js';
import { commandResult } from '../_support/fakes.js';

describe('result mapping', () => {
  describe('command and commandTag', () => {
    /**
     * `pg` keeps the first word of the server's command tag and throws the
     * rest away, so four kinds of CREATE and four kinds of DROP are one
     * word each. `command` matches it for compatibility; `commandTag` is
     * where the object type survives.
     */
    const tags = [
      ['CREATE TABLE', 'CREATE'],
      ['CREATE INDEX', 'CREATE'],
      ['CREATE VIEW', 'CREATE'],
      ['DROP TABLE', 'DROP'],
      ['DROP INDEX', 'DROP'],
      ['ALTER TABLE', 'ALTER'],
      ['TRUNCATE TABLE', 'TRUNCATE'],
      ['SELECT', 'SELECT'],
      ['INSERT', 'INSERT'],
      ['BEGIN', 'BEGIN'],
    ] as const;

    for (const [tag, firstWord] of tags) {
      it(`${tag} -> command ${firstWord}, commandTag ${tag}`, () => {
        const result = toQueryResult(commandResult({ command: tag }));
        expect(result.command).toStrictEqual(firstWord);
        expect(result.commandTag).toStrictEqual(tag);
      });
    }

    it('leaves both undefined when the server sent no tag', () => {
      const result = toQueryResult(commandResult({ command: undefined }));
      expect(result.command).toBeUndefined();
      expect(result.commandTag).toBeUndefined();
    });
  });

  describe('rowCount', () => {
    /**
     * `pg` passes the command tag's count through whatever the command
     * was. PostgreJS reports `rowsAffected` only for the four that change
     * rows, so a SELECT's count has to come from the rows themselves.
     */
    it('is rowsAffected for INSERT/UPDATE/DELETE/MERGE', () => {
      expect(
        toQueryResult(commandResult({ command: 'INSERT', rowsAffected: 2 }))
          .rowCount,
      ).toStrictEqual(2);
    });

    it('is zero, not null, when a statement changed nothing', () => {
      expect(
        toQueryResult(commandResult({ command: 'UPDATE', rowsAffected: 0 }))
          .rowCount,
      ).toStrictEqual(0);
    });

    it('is the row count for a SELECT, as pg reports it', () => {
      expect(
        toQueryResult(commandResult({ command: 'SELECT', rows: [{}, {}, {}] }))
          .rowCount,
      ).toStrictEqual(3);
    });

    it('is zero for a SELECT that matched nothing', () => {
      expect(
        toQueryResult(commandResult({ command: 'SELECT', rows: [] })).rowCount,
      ).toStrictEqual(0);
    });

    it('is null for a command that carries no count at all', () => {
      expect(
        toQueryResult(
          commandResult({ command: 'CREATE TABLE', rows: undefined }),
        ).rowCount,
      ).toBeNull();
    });

    it('prefers rowsAffected over the rows RETURNING gave back', () => {
      expect(
        toQueryResult(
          commandResult({ command: 'INSERT', rowsAffected: 1, rows: [{}] }),
        ).rowCount,
      ).toStrictEqual(1);
    });
  });

  describe('rows and fields', () => {
    it('answers with arrays where PostgreJS left them unset', () => {
      const result = toQueryResult(
        commandResult({ rows: undefined, fields: undefined }),
      );
      expect(result.rows).toStrictEqual([]);
      expect(result.fields).toStrictEqual([]);
    });

    it('hands the rows through untouched', () => {
      const rows = [{ a: 1 }];
      expect(toQueryResult(commandResult({ rows })).rows).toBe(rows);
    });
  });

  describe('toQueryResults()', () => {
    it('unwraps a script into the bare array pg returns', () => {
      const results = toQueryResults({
        totalCommands: 2,
        results: [
          commandResult({ command: 'INSERT', rowsAffected: 1 }),
          commandResult({ command: 'SELECT', rows: [{ n: 3 }] }),
        ],
      });
      expect(Array.isArray(results)).toBe(true);
      expect(results.map(r => [r.command, r.rowCount])).toStrictEqual([
        ['INSERT', 1],
        ['SELECT', 1],
      ]);
    });

    it('answers with an empty array for an empty script', () => {
      expect(toQueryResults({ totalCommands: 0, results: [] })).toStrictEqual(
        [],
      );
    });
  });
});
