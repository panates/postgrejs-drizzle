import type { OID } from 'postgrejs';
import { DataTypeOIDs } from 'postgrejs';

/**
 * The OIDs this driver asks the server to render as text.
 *
 * PostgreJS decodes every one of these perfectly well - the list is not
 * about types it cannot read. It is about shape: drizzle's column mappers
 * are written against what `pg` hands them, and `pg` asks for text and
 * leaves most of these as strings, while PostgreJS decodes them into
 * richer JavaScript values. Left alone, `numeric` arrives as a `number`
 * that has already lost its digits, `timestamp` as a `Date` read in the
 * local zone rather than UTC, `date` in string mode comes out a day early,
 * and `interval` and `time` reach the caller as an `Interval` and a `Date`
 * where drizzle's own columns do nothing to them and a string was meant.
 *
 * Asking the server is what makes this exact rather than approximately
 * right: the string is PostgreSQL's own rendering, so it cannot drift from
 * what `pg` would have received. A decoder written here could not be, for
 * the date and time types at least - their text form is decided by the
 * session's `DateStyle`, `IntervalStyle` and `TimeZone`, which the client
 * does not track.
 *
 * Types PostgreJS has no decoder for at all - enums, composites, extension
 * types - are not here. `unknownTypesAsString` covers those, and covers
 * them without anyone having to list an OID.
 */
export const FETCH_AS_STRING: readonly OID[] = Object.freeze([
  DataTypeOIDs.int8,
  DataTypeOIDs.numeric,
  DataTypeOIDs.date,
  DataTypeOIDs.timestamp,
  DataTypeOIDs.timestamptz,
  DataTypeOIDs.time,
  DataTypeOIDs.interval,
  // PostgreJS decodes point into a Point instance. drizzle's point column
  // in 'xy' mode returns the driver's value unchanged, so the caller would
  // get a class instance where pg gives a plain { x, y } - same fields,
  // different prototype, and JSON.stringify renders it "(24.5,49.6)". The
  // text form parses into exactly the plain object.
  DataTypeOIDs.point,
  // Same reason, one release ahead of it: drizzle's `line` column parses
  // `{a,b,c}` out of a string and nothing else, and PostgreJS is in the
  // middle of giving the geometric family classes of their own. Asking for
  // text costs nothing while `line` still decodes to a string, and keeps
  // the column working on the build where it stops.
  DataTypeOIDs.line,
  DataTypeOIDs._int8,
  DataTypeOIDs._numeric,
  DataTypeOIDs._date,
  DataTypeOIDs._timestamp,
  DataTypeOIDs._timestamptz,
  DataTypeOIDs._time,
  DataTypeOIDs._interval,
  DataTypeOIDs._point,
  DataTypeOIDs._line,
]);

/**
 * `cannot insert multiple commands into a prepared statement` - what the
 * server answers when SQL holding more than one statement is sent over the
 * extended query protocol, which is the only one `query()` speaks.
 *
 * It is raised while parsing, before any of the statements run, so a call
 * that fails this way has had no effect and can be retried through
 * `execute()` without repeating one. See `PgjsPreparedQuery.execute()`.
 */
export const MULTIPLE_COMMANDS_ERROR_CODE = '42601';
