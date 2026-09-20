import type {
  PgDialect,
  PgSession,
  PgTransactionConfig,
  SelectedFieldsOrdered,
} from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm/sql';
import * as drizzleTracing from 'drizzle-orm/tracing';
import * as drizzleUtils from 'drizzle-orm/utils';

/**
 * The parts of drizzle a PostgreSQL driver has to use and drizzle does not
 * declare.
 *
 * Everything a driver needs is exported from a documented subpath - there
 * is no reaching into `drizzle-orm/dist/...` anywhere in this package. But
 * several of those exports are marked `/** @internal *\/` in drizzle's
 * source, and its `.d.ts` files are built with `stripInternal`, so they
 * exist at runtime and are absent from the types. `drizzle-orm/tracing`
 * declares `export {}` while shipping a `tracer`; `mapResultRow` is gone
 * from `drizzle-orm/utils`; `PgPreparedQuery` keeps only `execute` of its
 * four abstract members, and loses `queryWithCache` and
 * `joinsNotNullableMap`; `PgTransaction` loses `getTransactionConfigSQL`,
 * and `dialect` and `session` are internal constructor parameters rather
 * than declared properties.
 *
 * `drizzle-orm/node-postgres` does not hit any of this: it is built inside
 * drizzle's own monorepo, from source, where nothing has been stripped.
 * A driver outside it has to restate the shapes, which is what this file
 * is for - one place to look when a drizzle upgrade breaks the build, and
 * the honest measure of how much of this seam carries no stability
 * promise.
 */

/** `PgPreparedQuery`'s members that `stripInternal` removed. */
export interface PgPreparedQueryInternals {
  /**
   * Set by drizzle on the prepared query for a select with joins; read
   * back when mapping a row, to null out an outer-joined table whose
   * columns all came back null.
   */
  joinsNotNullableMap?: Record<string, boolean>;
  /**
   * Runs the query through drizzle's cache layer. Going through it is not
   * optional even with no cache configured: it is also where a driver
   * error is wrapped into `DrizzleQueryError`, which is the error type a
   * drizzle user catches.
   */
  queryWithCache<T>(
    queryString: string,
    params: unknown[],
    query: () => Promise<T>,
  ): Promise<T>;
}

/** `PgTransaction`'s members that `stripInternal` removed. */
export interface PgTransactionInternals {
  dialect: PgDialect;
  session: PgSession<any, any, any>;
  getTransactionConfigSQL(config: PgTransactionConfig): SQL;
}

type MapResultRow = <TResult>(
  columns: SelectedFieldsOrdered,
  row: unknown[],
  joinsNotNullableMap: Record<string, boolean> | undefined,
) => TResult;

/**
 * Maps one array-mode row onto the shape the query asked for, decoding
 * each value with the column's own `mapFromDriverValue`. Reimplementing it
 * here would mean owning drizzle's join-nullability rules and watching
 * them drift, so it is borrowed instead - and its absence is fatal rather
 * than degradable, hence the throw.
 */
export const mapResultRow: MapResultRow = (() => {
  const fn = (drizzleUtils as Record<string, unknown>)['mapResultRow'];
  if (typeof fn !== 'function')
    throw new Error(
      'drizzle-orm no longer exports mapResultRow from "drizzle-orm/utils". ' +
        'This version of drizzle-postgrejs cannot run against it.',
    );
  return fn as MapResultRow;
})();

interface Tracer {
  startActiveSpan<T>(
    name: string,
    fn: (span?: {
      setAttributes(attributes: Record<string, unknown>): void;
    }) => T,
  ): T;
}

/**
 * Drizzle's OpenTelemetry tracer, which `node-postgres` wraps every query
 * in. Unlike `mapResultRow` this one is only observability, so a drizzle
 * that stops exporting it costs spans rather than correctness - the
 * fallback runs the same callbacks with no span.
 */
export const tracer: Tracer = ((drizzleTracing as Record<string, unknown>)[
  'tracer'
] as Tracer) ?? {
  startActiveSpan: (_name, fn) => fn(),
};
