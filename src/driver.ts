import { entityKind } from 'drizzle-orm';
import { DefaultLogger, type Logger } from 'drizzle-orm/logger';
import { PgDatabase, PgDialect } from 'drizzle-orm/pg-core';
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  type RelationalSchemaConfig,
  type TablesRelationalConfig,
} from 'drizzle-orm/relations';
import { isConfig } from 'drizzle-orm/utils';
import type { QueryOptions } from 'postgrejs';
import { parseConnectionString, Pool } from 'postgrejs';
import type {
  PgjsClient,
  PgjsConnectionConfig,
  PgjsDriverOptions,
  PgjsDrizzleConfig,
} from './config.js';
import { FETCH_AS_STRING } from './constants.js';
import { type PgjsQueryResultHKT, PgjsSession } from './session.js';

export class PgjsDriver {
  static readonly [entityKind]: string = 'PgjsDriver';

  protected readonly _client: PgjsClient;
  protected readonly _dialect: PgDialect;
  protected readonly _queryOptions: QueryOptions;
  protected readonly _logger?: Logger;

  constructor(
    client: PgjsClient,
    dialect: PgDialect,
    queryOptions: QueryOptions,
    logger?: Logger,
  ) {
    this._client = client;
    this._dialect = dialect;
    this._queryOptions = queryOptions;
    this._logger = logger;
  }

  createSession(
    schema: RelationalSchemaConfig<TablesRelationalConfig> | undefined,
  ): PgjsSession<Record<string, unknown>, TablesRelationalConfig> {
    return new PgjsSession(
      this._client,
      this._dialect,
      this._queryOptions,
      schema,
      {
        logger: this._logger,
      },
    );
  }
}

export class PgjsDatabase<
  TSchema extends Record<string, unknown> = Record<string, never>,
> extends PgDatabase<PgjsQueryResultHKT, TSchema> {
  static override readonly [entityKind]: string = 'PgjsDatabase';
}

/**
 * What `drizzle()` hands back, for declaring a variable or a parameter.
 *
 * `$client` is on the value rather than on the class - drizzle's own
 * drivers add it the same way - so `PgjsDatabase<TSchema>` alone does not
 * carry it, and a handle typed that way cannot close its own pool.
 */
export type PgjsDrizzle<
  TSchema extends Record<string, unknown> = Record<string, never>,
  TClient extends PgjsClient = Pool,
> = PgjsDatabase<TSchema> & { $client: TClient };

/**
 * Every query this driver sends carries these.
 *
 * `rollbackOnError: false` is the one that changes behaviour rather than
 * shape. PostgreJS puts a savepoint around each statement in a transaction
 * by default, so a failed statement leaves the transaction usable - which
 * is neither PostgreSQL's own rule nor what a drizzle user expects. With
 * it off, a failed statement aborts the block, exactly as under `pg`.
 */
function buildQueryOptions(options: PgjsDriverOptions): QueryOptions {
  const queryOptions: QueryOptions = {
    rollbackOnError: false,
    unknownTypesAsString: options.unknownTypesAsString ?? true,
    fetchAsString: options.fetchAsString
      ? [...FETCH_AS_STRING, ...options.fetchAsString]
      : [...FETCH_AS_STRING],
  };
  if (options.prepare !== undefined) queryOptions.prepare = options.prepare;
  return queryOptions;
}

function construct<
  TSchema extends Record<string, unknown> = Record<string, never>,
  TClient extends PgjsClient = PgjsClient,
>(
  client: TClient,
  config: PgjsDrizzleConfig<TSchema> = {},
): PgjsDatabase<TSchema> & { $client: TClient } {
  const dialect = new PgDialect({ casing: config.casing });

  let logger: Logger | undefined;
  if (config.logger === true) logger = new DefaultLogger();
  else if (config.logger !== false) logger = config.logger;

  let schema: RelationalSchemaConfig<TablesRelationalConfig> | undefined;
  if (config.schema) {
    const tablesConfig = extractTablesRelationalConfig(
      config.schema,
      createTableRelationsHelpers,
    );
    schema = {
      fullSchema: config.schema,
      schema: tablesConfig.tables,
      tableNamesMap: tablesConfig.tableNamesMap,
    };
  }

  const driver = new PgjsDriver(
    client,
    dialect,
    buildQueryOptions(config),
    logger,
  );
  const session = driver.createSession(schema);
  const db = new PgjsDatabase(
    dialect,
    session,
    schema as any,
  ) as PgjsDatabase<TSchema>;
  (db as any).$client = client;
  return db as PgjsDatabase<TSchema> & { $client: TClient };
}

/**
 * `connectionString` is `pg`'s spelling and drizzle's documented one, but
 * PostgreJS takes the string as its first argument and ignores an option
 * it does not know - which would open a pool on localhost:5432/postgres
 * without saying anything. So it is translated here rather than passed on.
 */
function createPool(connection: string | PgjsConnectionConfig): Pool {
  if (typeof connection === 'string') return new Pool(connection);
  const { connectionString, ...rest } = connection;
  return connectionString
    ? new Pool({ ...parseConnectionString(connectionString), ...rest })
    : new Pool(rest);
}

export function drizzle<
  TSchema extends Record<string, unknown> = Record<string, never>,
  TClient extends PgjsClient = Pool,
>(
  ...params:
    | [TClient | string]
    | [TClient | string, PgjsDrizzleConfig<TSchema>]
    | [
        PgjsDrizzleConfig<TSchema> &
          ({ client: TClient } | { connection: string | PgjsConnectionConfig }),
      ]
): PgjsDatabase<TSchema> & {
  $client: PgjsClient extends TClient ? Pool : TClient;
} {
  if (typeof params[0] === 'string')
    return construct(
      createPool(params[0]),
      params[1] as PgjsDrizzleConfig<TSchema> | undefined,
    ) as any;

  if (isConfig(params[0])) {
    const { connection, client, ...drizzleConfig } = params[0] as {
      connection?: string | PgjsConnectionConfig;
      client?: TClient;
    } & PgjsDrizzleConfig<TSchema>;
    if (client) return construct(client, drizzleConfig) as any;
    return construct(createPool(connection!), drizzleConfig) as any;
  }

  return construct(
    params[0] as TClient,
    params[1] as PgjsDrizzleConfig<TSchema> | undefined,
  ) as any;
}
