import { BindParam } from 'postgrejs';

/**
 * Hands a parameter to PostgreJS the way `pg` hands it to the server.
 *
 * `Connection._query` derives an OID for every parameter from the value it
 * was given, so a plain string is declared `varchar` and PostgreSQL stops
 * inferring the type from where the parameter lands. That is fatal here
 * rather than inconvenient: drizzle's column encoders stringify nearly
 * everything before the driver ever sees it - `json` and `jsonb` through
 * `JSON.stringify`, arrays through `makePgArray`, `numeric` and `bigint`
 * through `String`, `timestamp` and `date` through `toISOString` - so an
 * ordinary INSERT arrives as a varchar and is rejected with
 * `column "x" is of type json but expression is of type character varying`.
 * Ten of twenty-four measured query shapes failed this way; all ten pass
 * wrapped, and none of the other fourteen regressed.
 *
 * `new BindParam(0, value)` asks for OID 0, "unspecified", which is what
 * `pg` sends and what lets the server resolve the type from context.
 *
 * Only for values whose text form the server can parse out of context.
 * A `Date`, a `Buffer`, a JS array or a plain object keeps PostgreJS's own
 * typed binary encoder - wrapping those breaks them, verified:
 * `invalid input syntax for type timestamp: "Tue Mar 05 2024 ..."`,
 * `malformed array literal: "1,2"`, `invalid input syntax for type json`.
 */
export function bindParam(value: unknown): unknown {
  if (value === null || value === undefined) return new BindParam(0, value);
  const type = typeof value;
  return type === 'string' ||
    type === 'number' ||
    type === 'boolean' ||
    type === 'bigint'
    ? new BindParam(0, value)
    : value;
}
