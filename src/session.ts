import { entityKind } from 'drizzle-orm';
import { type Cache, NoopCache } from 'drizzle-orm/cache/core';
import type { WithCacheConfig } from 'drizzle-orm/cache/core/types';
import { type Logger, NoopLogger } from 'drizzle-orm/logger';
import type {
  PgDialect,
  PgQueryResultHKT,
  PgTransactionConfig,
  PreparedQueryConfig,
  SelectedFieldsOrdered,
} from 'drizzle-orm/pg-core';
import { PgSession, PgTransaction } from 'drizzle-orm/pg-core';
import type {
  RelationalSchemaConfig,
  TablesRelationalConfig,
} from 'drizzle-orm/relations';
import { type Query, type SQL, sql } from 'drizzle-orm/sql';
import type { Assume } from 'drizzle-orm/utils';
import type { Pool, QueryOptions, Row } from 'postgrejs';
import type { PgjsClient } from './config.js';
import type { PgTransactionInternals } from './drizzle-internals.js';
import { PgjsPreparedQuery, type PgjsQueryMetadata } from './prepared-query.js';
import type { PgjsQueryResult } from './result.js';

/**
 * A `Pool`, or nothing if this client is a single `Connection`.
 *
 * Told apart by `acquire`, not by `instanceof`. Two copies of postgrejs in
 * one `node_modules` are two different `Pool` classes, and `instanceof`
 * would then say no to a real pool - which here would not throw but
 * quietly run a transaction's statements through `pool.query()`, scattering
 * them across whichever connections happened to be free. node-postgres hit
 * the same class of problem and loosened its own check for exactly that
 * reason. `Connection` has no `acquire`, so there is nothing for this to
 * confuse it with.
 */
function asPool(client: PgjsClient): Pool | undefined {
  return typeof (client as Pool).acquire === 'function'
    ? (client as Pool)
    : undefined;
}

export interface PgjsSessionOptions {
  logger?: Logger;
  cache?: Cache;
}

export class PgjsSession<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> extends PgSession<PgjsQueryResultHKT, TFullSchema, TSchema> {
  static override readonly [entityKind]: string = 'PgjsSession';

  readonly client: PgjsClient;
  protected readonly _schema: RelationalSchemaConfig<TSchema> | undefined;
  protected readonly _options: PgjsSessionOptions;
  protected readonly _queryOptions: QueryOptions;
  protected readonly _logger: Logger;
  protected readonly _cache: Cache;

  constructor(
    client: PgjsClient,
    dialect: PgDialect,
    queryOptions: QueryOptions,
    schema: RelationalSchemaConfig<TSchema> | undefined,
    options: PgjsSessionOptions = {},
  ) {
    super(dialect);
    this.client = client;
    this._schema = schema;
    this._options = options;
    this._queryOptions = queryOptions;
    this._logger = options.logger ?? new NoopLogger();
    this._cache = options.cache ?? new NoopCache();
  }

  override prepareQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    _name: string | undefined,
    isResponseInArrayMode: boolean,
    customResultMapper?: (rows: unknown[][]) => T['execute'],
    queryMetadata?: PgjsQueryMetadata,
    cacheConfig?: WithCacheConfig,
  ): PgjsPreparedQuery<T> {
    // `_name` is dropped on purpose. It is what node-postgres passes to pg
    // to name a prepared statement; PostgreJS decides for itself which
    // statements earn a name and caches them per connection, so there is
    // nothing to hand the name to.
    return new PgjsPreparedQuery<T>(
      this.client,
      query,
      this._logger,
      this._cache,
      queryMetadata,
      cacheConfig,
      this._queryOptions,
      fields,
      isResponseInArrayMode,
      customResultMapper,
    );
  }

  /**
   * A transaction has to stay on one connection, so on a pool this checks
   * one out and gives it back however the block ends. `pool.query()` is
   * free to pick a different connection per call, which would scatter the
   * statements across several.
   *
   * BEGIN, COMMIT and ROLLBACK go through the session's own query path
   * rather than PostgreJS's `startTransaction()`/`commit()`/`rollback()`,
   * which is how drizzle's logger and any tracing see them at all.
   */
  override async transaction<T>(
    transaction: (tx: PgjsTransaction<TFullSchema, TSchema>) => Promise<T>,
    config?: PgTransactionConfig,
  ): Promise<T> {
    const pool = asPool(this.client);
    // Kept together so the release cannot be reached without the pool that
    // has to do it - and so there is no second condition claiming the two
    // could ever disagree.
    const checkedOut = pool
      ? { pool, connection: await pool.acquire() }
      : undefined;
    const session = checkedOut
      ? new PgjsSession<TFullSchema, TSchema>(
          checkedOut.connection,
          this.dialect,
          this._queryOptions,
          this._schema,
          this._options,
        )
      : this;
    const tx = new PgjsTransaction<TFullSchema, TSchema>(
      this.dialect,
      session,
      this._schema,
    );
    const txInternal = tx as unknown as PgTransactionInternals;
    await tx.execute(
      sql`begin${config ? sql` ${txInternal.getTransactionConfigSQL(config)}` : undefined}`,
    );
    try {
      const result = await transaction(tx);
      await tx.execute(sql`commit`);
      return result;
    } catch (error) {
      await tx.execute(sql`rollback`);
      throw error;
    } finally {
      if (checkedOut) await checkedOut.pool.release(checkedOut.connection);
    }
  }

  /**
   * The inherited one reads `res[0].count`, which is right for a driver
   * whose `execute()` resolves to an array of rows. This one resolves to a
   * result object, as `pg`'s does, so the count is a row inside it -
   * node-postgres overrides this for the same reason.
   */
  override async count(sqlQuery: SQL): Promise<number> {
    const result =
      await this.execute<PgjsQueryResult<{ count: string }>>(sqlQuery);
    return Number(result.rows[0]!.count);
  }
}

export class PgjsTransaction<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> extends PgTransaction<PgjsQueryResultHKT, TFullSchema, TSchema> {
  static override readonly [entityKind]: string = 'PgjsTransaction';

  /**
   * A nested transaction is a savepoint. The names are drizzle's own -
   * `sp1`, `sp2`, by nesting depth - and they go out through `sql.raw`, so
   * they are neither quoted nor anything a caller can influence.
   */
  override async transaction<T>(
    transaction: (tx: PgjsTransaction<TFullSchema, TSchema>) => Promise<T>,
  ): Promise<T> {
    const savepointName = `sp${this.nestedIndex + 1}`;
    const internal = this as unknown as PgTransactionInternals;
    const tx = new PgjsTransaction<TFullSchema, TSchema>(
      internal.dialect,
      internal.session,
      this.schema,
      this.nestedIndex + 1,
    );
    await tx.execute(sql.raw(`savepoint ${savepointName}`));
    try {
      const result = await transaction(tx);
      await tx.execute(sql.raw(`release savepoint ${savepointName}`));
      return result;
    } catch (error) {
      await tx.execute(sql.raw(`rollback to savepoint ${savepointName}`));
      throw error;
    }
  }
}

export interface PgjsQueryResultHKT extends PgQueryResultHKT {
  type: PgjsQueryResult<Assume<this['row'], Row>>;
}
