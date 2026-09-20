import type { CommandResult, FieldInfo, Row, ScriptResult } from 'postgrejs';

/**
 * What `db.execute()` resolves to.
 *
 * Shaped after `pg`'s `QueryResult`, because that is what a drizzle user
 * reads and what code being ported from `drizzle-orm/node-postgres`
 * expects - drizzle itself reads nothing off this object, so its only job
 * is to look familiar.
 */
export interface PgjsQueryResult<TRow = Row> {
  /**
   * The command tag's first word, as `pg` reports it: `CREATE`, `DROP`,
   * `INSERT`, `SELECT`.
   */
  command?: string;
  /**
   * The server's whole command tag, which `pg` throws away - `CREATE
   * INDEX` rather than `CREATE`, `DROP VIEW` rather than `DROP`. Four
   * kinds of CREATE and four kinds of DROP are one word each in `pg`, so
   * this is the only place the object type survives.
   *
   * Trailing counts are not part of it (`INSERT 0 2` is `INSERT`); they
   * are already on `rowCount`.
   *
   * An addition of this driver. `drizzle-orm/node-postgres` has no such
   * field, so code that reads it does not port back.
   */
  commandTag?: string;
  /**
   * The count from the server's command tag, as `pg` reports it: rows
   * affected for INSERT/UPDATE/DELETE/MERGE, rows returned for SELECT, and
   * `null` for a command that carries no count at all (CREATE, DROP,
   * BEGIN).
   */
  rowCount: number | null;
  rows: TRow[];
  /**
   * PostgreJS's own column descriptions, not `pg`'s - `fieldName` and
   * `dataTypeId` rather than `name` and `dataTypeID`, plus the JS type and
   * whether the column is an array.
   */
  fields: FieldInfo[];
}

/** The first word of a command tag, which is all `pg` keeps. */
function firstWord(tag: string | undefined): string | undefined {
  if (tag === undefined) return undefined;
  const space = tag.indexOf(' ');
  return space === -1 ? tag : tag.slice(0, space);
}

/**
 * PostgreJS leaves `rows` and `rowsAffected` unset where there is nothing
 * to report; `pg` says `[]` and `null` in the same places, and drizzle's
 * own `count()` reads `rows[0]` without checking.
 *
 * `rowsAffected` is deliberately not the whole of `rowCount`. PostgreJS
 * sets it only for INSERT/UPDATE/DELETE/MERGE, on the grounds that what a
 * SELECT reports is rows returned rather than rows affected - which is
 * true, and is also not what `pg` does: `pg` passes the command tag's
 * count through whatever the command was, so `select` three rows gives
 * `rowCount: 3`. Row count and row array agree for a SELECT, so the length
 * stands in for it.
 */
export function toQueryResult<TRow = Row>(
  result: CommandResult,
): PgjsQueryResult<TRow> {
  const rows = (result.rows ?? []) as TRow[];
  return {
    command: firstWord(result.command),
    commandTag: result.command,
    rowCount: result.rowsAffected ?? (result.rows ? rows.length : null),
    rows,
    fields: result.fields ?? [],
  };
}

/**
 * A script's results as `pg` reports a multi-statement query: one entry
 * per statement, in order, as a bare array rather than wrapped.
 */
export function toQueryResults<TRow = Row>(
  script: ScriptResult,
): PgjsQueryResult<TRow>[] {
  return script.results.map(result => toQueryResult<TRow>(result));
}
