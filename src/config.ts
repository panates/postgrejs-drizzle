import type { DrizzleConfig } from 'drizzle-orm';
import type { Connection, OID, Pool, PoolConfiguration } from 'postgrejs';

/** A client this driver can run on. */
export type PgjsClient = Pool | Connection;

/**
 * What PostgreJS is given when this package opens the pool itself.
 *
 * `connectionString` is not one of PostgreJS's own options - it takes the
 * string as its first argument instead - but it is `pg`'s spelling and the
 * one drizzle's documentation uses, and PostgreJS ignores an option it does
 * not know, which would quietly connect to localhost:5432/postgres. So it
 * is accepted here and translated.
 */
export interface PgjsConnectionConfig extends PoolConfiguration {
  connectionString?: string;
}

export interface PgjsDriverOptions {
  /**
   * Ask the server for text on any column PostgreJS has no decoder for -
   * an enum, a composite, an extension type - so it arrives as the string
   * `pg` would have given instead of a `Buffer` nothing can read.
   *
   * On by default, because a schema with a single `pgEnum` silently
   * returns `Buffer`s without it, and that is not a thing to make anyone
   * opt into. It is not free: the column types have to be known before the
   * Bind that asks for them, so a statement is prepared on first sight -
   * one extra round trip per distinct statement per connection. Turn it
   * off only if you know every type in your schema has a decoder.
   *
   * @default true
   */
  unknownTypesAsString?: boolean;
  /**
   * Extra OIDs to fetch as text, appended to the list this driver already
   * needs (see `FETCH_AS_STRING`). For a type PostgreJS decodes into a
   * shape your code would rather have as the server's own string.
   */
  fetchAsString?: OID[];
  /**
   * Passed through to PostgreJS. `false` keeps statements out of its
   * per-connection prepared statement cache, which is what PgBouncer in
   * transaction pooling mode needs before 1.21.
   *
   * @default PostgreJS's own setting
   */
  prepare?: boolean;
}

export type PgjsDrizzleConfig<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = DrizzleConfig<TSchema> & PgjsDriverOptions;
