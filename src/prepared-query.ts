import { entityKind } from 'drizzle-orm';
import type { Cache } from 'drizzle-orm/cache/core';
import type { WithCacheConfig } from 'drizzle-orm/cache/core/types';
import type { Logger } from 'drizzle-orm/logger';
import type {
  PreparedQueryConfig,
  SelectedFieldsOrdered,
} from 'drizzle-orm/pg-core';
import { PgPreparedQuery } from 'drizzle-orm/pg-core';
import { fillPlaceholders, type Query } from 'drizzle-orm/sql';
import type { QueryOptions } from 'postgrejs';
import { DatabaseError, isMultiStatement } from 'postgrejs';
import type { PgjsClient } from './config.js';
import { MULTIPLE_COMMANDS_ERROR_CODE } from './constants.js';
import {
  mapResultRow,
  type PgPreparedQueryInternals,
  tracer,
} from './drizzle-internals.js';
import { bindParam } from './params.js';
import { toQueryResult, toQueryResults } from './result.js';

/** What a query's metadata looks like where drizzle hands it over. */
export type PgjsQueryMetadata = {
  type: 'select' | 'update' | 'delete' | 'insert';
  tables: string[];
};

export class PgjsPreparedQuery<
  T extends PreparedQueryConfig,
> extends PgPreparedQuery<T> {
  static override readonly [entityKind]: string = 'PgjsPreparedQuery';

  protected readonly _client: PgjsClient;
  protected readonly _sql: string;
  protected readonly _params: unknown[];
  protected readonly _logger: Logger;
  protected readonly _queryOptions: QueryOptions;
  protected readonly _fields: SelectedFieldsOrdered | undefined;
  protected readonly _isResponseInArrayMode: boolean;
  protected readonly _customResultMapper?: (rows: unknown[][]) => T['execute'];

  constructor(
    client: PgjsClient,
    query: Query,
    logger: Logger,
    cache: Cache | undefined,
    queryMetadata: PgjsQueryMetadata | undefined,
    cacheConfig: WithCacheConfig | undefined,
    queryOptions: QueryOptions,
    fields: SelectedFieldsOrdered | undefined,
    isResponseInArrayMode: boolean,
    customResultMapper?: (rows: unknown[][]) => T['execute'],
  ) {
    super(query, cache, queryMetadata, cacheConfig);
    this._client = client;
    this._sql = query.sql;
    this._params = query.params;
    this._logger = logger;
    this._queryOptions = queryOptions;
    this._fields = fields;
    this._isResponseInArrayMode = isResponseInArrayMode;
    this._customResultMapper = customResultMapper;
  }

  /** See `PgPreparedQueryInternals`. */
  protected get _internal(): PgPreparedQueryInternals {
    return this as unknown as PgPreparedQueryInternals;
  }

  /**
   * Two shapes, and drizzle picks between them by what it passed in.
   *
   * With neither `fields` nor a `customResultMapper` this is `db.execute()`
   * and the driver's own result object is the answer - so the rows are
   * objects and the result is reshaped to look like `pg`'s. Otherwise the
   * rows are drizzle's to map, and `mapResultRow` indexes them
   * positionally, so they have to be arrays.
   */
  override execute(
    placeholderValues: Record<string, unknown> | undefined = {},
  ): Promise<T['execute']> {
    return tracer.startActiveSpan('drizzle.execute', async () => {
      const params = fillPlaceholders(this._params, placeholderValues);
      this._logger.logQuery(this._sql, params);
      const bound = params.map(bindParam);

      if (!this._fields && !this._customResultMapper) {
        return tracer.startActiveSpan('drizzle.driver.execute', span => {
          span?.setAttributes({
            'drizzle.query.text': this._sql,
            'drizzle.query.params': JSON.stringify(params),
          });
          return this._internal.queryWithCache(this._sql, params, () =>
            this._executeRaw(bound),
          );
        });
      }

      const result = await tracer.startActiveSpan(
        'drizzle.driver.execute',
        span => {
          span?.setAttributes({
            'drizzle.query.text': this._sql,
            'drizzle.query.params': JSON.stringify(params),
          });
          return this._internal.queryWithCache(this._sql, params, () =>
            this._client.query(this._sql, {
              ...this._queryOptions,
              params: bound,
              objectRows: false,
            }),
          );
        },
      );

      return tracer.startActiveSpan('drizzle.mapResponse', () => {
        const rows = (result.rows ?? []) as unknown[][];
        return this._customResultMapper
          ? this._customResultMapper(rows)
          : rows.map(row =>
              mapResultRow<T['execute']>(
                this._fields!,
                row,
                this._internal.joinsNotNullableMap,
              ),
            );
      });
    });
  }

  /** @internal - abstract on the base class, but stripped from its types. */
  all(
    placeholderValues: Record<string, unknown> | undefined = {},
  ): Promise<T['all']> {
    return tracer.startActiveSpan('drizzle.execute', () => {
      const params = fillPlaceholders(this._params, placeholderValues);
      this._logger.logQuery(this._sql, params);
      const bound = params.map(bindParam);
      return tracer.startActiveSpan('drizzle.driver.execute', span => {
        span?.setAttributes({
          'drizzle.query.text': this._sql,
          'drizzle.query.params': JSON.stringify(params),
        });
        return this._internal
          .queryWithCache(this._sql, params, () =>
            this._client.query(this._sql, {
              ...this._queryOptions,
              params: bound,
              objectRows: true,
            }),
          )
          .then(result => result.rows ?? []);
      });
    });
  }

  /** @internal - abstract on the base class, but stripped from its types. */
  isResponseInArrayMode(): boolean {
    return this._isResponseInArrayMode;
  }

  /**
   * `db.execute()` is the one place SQL reaches this driver without having
   * been built by a query builder, so it is the one place that can hold
   * more than one statement. `pg` accepts that because a parameterless
   * query goes over the simple protocol; `query()` here is always the
   * extended one, which answers 42601 and runs nothing.
   *
   * `execute()` is PostgreJS's counterpart, and since 3.11.0 the client
   * also answers which of the two a given string needs, so the choice is
   * made before anything is sent rather than after a round trip has come
   * back refused. `isMultiStatement()` is a scanner over the quoting rules
   * a `;` can hide inside - string and dollar-quoted literals, quoted
   * identifiers, both comment forms - not a guess from whether parameters
   * happen to be present, which is what `pg` decides on.
   *
   * Only a parameterless call can take that road: `execute()` sends a
   * simple `Query`, which carries no parameters, so a multi-statement call
   * that has some still goes to `query()` and gets the server's own error
   * rather than a worse one from here.
   *
   * The 42601 fallback stays behind it for the one case the scanner can be
   * wrong in - it reads `\'` as an escape, which under
   * `standard_conforming_strings = off` it is not. Retrying costs nothing
   * and repeats no side effect: the server raises 42601 while parsing,
   * before any statement has run.
   */
  protected async _executeRaw(params: unknown[]): Promise<T['execute']> {
    if (params.length === 0 && isMultiStatement(this._sql))
      return this._executeScript();

    try {
      return toQueryResult(
        await this._client.query(this._sql, {
          ...this._queryOptions,
          params,
          objectRows: true,
        }),
      );
    } catch (error) {
      if (
        params.length > 0 ||
        !(error instanceof DatabaseError) ||
        error.code !== MULTIPLE_COMMANDS_ERROR_CODE
      )
        throw error;
      return this._executeScript();
    }
  }

  /** The simple-protocol road, and one result per statement. */
  protected async _executeScript(): Promise<T['execute']> {
    return toQueryResults(
      await this._client.execute(this._sql, {
        ...this._queryOptions,
        objectRows: true,
      }),
    );
  }
}
