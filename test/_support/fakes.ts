import type {
  CommandResult,
  Connection,
  Pool,
  QueryOptions,
  QueryResult,
  ScriptExecuteOptions,
  ScriptResult,
} from 'postgrejs';

/**
 * Stand-ins for PostgreJS's `Connection` and `Pool`, so the driver's own
 * call sequence can be asserted exactly - which SQL it sends, in what
 * order, with which options - without a live server deciding any of it.
 */

export interface RecordedCall {
  method: 'query' | 'execute';
  sql: string;
  options?: QueryOptions | ScriptExecuteOptions;
}

/** What a fake answers with, or throws when it is an `Error`. */
export type FakeAnswer<TResult> =
  TResult | Error | ((sql: string, options?: any) => TResult | Error);

function resolveAnswer<TResult>(
  value: FakeAnswer<TResult>,
  sql: string,
  options: unknown,
): TResult {
  const result =
    typeof value === 'function' ? (value as any)(sql, options) : value;
  if (result instanceof Error) throw result;
  return result;
}

export class FakeClient {
  readonly calls: RecordedCall[];
  queryResult: FakeAnswer<QueryResult> = { command: 'SELECT', rows: [] };
  scriptResult: FakeAnswer<ScriptResult> = { totalCommands: 0, results: [] };
  /**
   * When set, both the call log and the canned answers are read from
   * there instead - so a pool and the connection it hands out record into
   * one sequence and answer alike.
   */
  protected readonly _shared?: FakeClient;

  constructor(shared?: FakeClient) {
    this._shared = shared;
    this.calls = shared ? shared.calls : [];
  }

  /** Just the SQL, in order - what most assertions are about. */
  get sqls(): string[] {
    return this.calls.map(call => call.sql);
  }

  get queries(): RecordedCall[] {
    return this.calls.filter(call => call.method === 'query');
  }

  async query(sql: string, options?: QueryOptions): Promise<QueryResult> {
    this.calls.push({ method: 'query', sql, options });
    const source = this._shared ?? this;
    return resolveAnswer(source.queryResult, sql, options);
  }

  async execute(
    sql: string,
    options?: ScriptExecuteOptions,
  ): Promise<ScriptResult> {
    this.calls.push({ method: 'execute', sql, options });
    const source = this._shared ?? this;
    return resolveAnswer(source.scriptResult, sql, options);
  }

  asConnection(): Connection {
    return this as unknown as Connection;
  }
}

export class FakePool extends FakeClient {
  readonly acquired: FakeClient[] = [];
  readonly released: FakeClient[] = [];
  closed = 0;
  /**
   * What `acquire()` hands out. A separate object, so `release()` can be
   * checked for having been given the right one - and deliberately not a
   * `FakePool`, so the driver's own "is this a pool" test sees a plain
   * connection the way it would in production.
   */
  readonly connection: FakeClient = new FakeClient(this);

  async acquire(): Promise<Connection> {
    this.acquired.push(this.connection);
    return this.connection.asConnection();
  }

  async release(connection: Connection): Promise<void> {
    this.released.push(connection as unknown as FakeClient);
  }

  async close(): Promise<void> {
    this.closed++;
  }

  asPool(): Pool {
    return this as unknown as Pool;
  }
}

/** A `CommandResult` carrying only what a test set. */
export function commandResult(
  overrides: Partial<CommandResult> = {},
): CommandResult {
  return { command: 'SELECT', rows: [], fields: [], ...overrides };
}
