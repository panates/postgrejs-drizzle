import net from 'node:net';
import { sql } from 'drizzle-orm';
import { expect } from 'expect';
import {
  type Differential,
  openDifferential,
} from '../_support/differential.js';

/**
 * Which wire format each parameter leaves on, read out of the Bind message
 * itself rather than assumed from the encoder that produced it.
 *
 * This exists because the assumption was wrong in the other direction and
 * cost a round of benchmark reading: PostgreJS decodes results in binary,
 * so "PostgreJS is the binary one" is easy to carry over to parameters,
 * where it does not hold. This driver declares OID 0 for every scalar -
 * `params.ts` says why - and no declared type means no binary encoder to
 * choose, so what goes out is text on both drivers. `doc/DRIVER-DESIGN.md`
 * §4 states that as a claim; this is the claim.
 *
 * Differential rather than live: "we send text" is only interesting beside
 * what `pg` sends, and the two rows that are not text are the two where
 * they agree anyway.
 */
describe('differential: the format parameters go out in', () => {
  let diff: Differential;

  before(async () => {
    diff = await openDifferential('drizzle_pgjs_diff_bind');
    diff.setSchema([]);
  });

  after(async () => {
    await diff?.close();
  });

  /**
   * The format codes of the last Bind message written to any socket while
   * `fn` ran. A Bind carries either no codes (all text), one that applies
   * to every parameter, or one per parameter; these cases send a single
   * parameter, so 'binary' means every code present was 1.
   */
  async function bindFormat(fn: () => Promise<unknown>): Promise<string> {
    let formats: number[] | undefined;
    const write = net.Socket.prototype.write;
    net.Socket.prototype.write = function (this: net.Socket, ...args: any[]) {
      const chunk = args[0];
      if (Buffer.isBuffer(chunk)) {
        let offset = 0;
        while (offset + 5 <= chunk.length) {
          const length = chunk.readInt32BE(offset + 1);
          if (length < 4 || offset + 1 + length > chunk.length) break;
          if (chunk[offset] === 0x42 /* 'B' */) {
            let at = offset + 5;
            while (chunk[at] !== 0) at++; // portal
            at++;
            while (chunk[at] !== 0) at++; // statement
            at++;
            const count = chunk.readInt16BE(at);
            at += 2;
            formats = [];
            for (let i = 0; i < count; i++) {
              formats.push(chunk.readInt16BE(at));
              at += 2;
            }
          }
          offset += 1 + length;
        }
      }
      return (write as any).apply(this, args);
    } as typeof net.Socket.prototype.write;
    try {
      await fn();
    } finally {
      net.Socket.prototype.write = write;
    }
    return formats?.length && formats.every(code => code === 1)
      ? 'binary'
      : 'text';
  }

  /**
   * `sql.param` rather than an interpolation, because drizzle spreads a
   * bare array into one placeholder per element and the array cases are
   * the point.
   */
  const cases: [string, unknown, string, string][] = [
    ['string', 'hello', 'text', 'text'],
    ['number', 42, 'int4', 'text'],
    ['bigint', 10n, 'int8', 'text'],
    ['Date', new Date('2024-03-05T10:00:00Z'), 'timestamptz', 'text'],
    ['int4[]', [1, 2, 3], 'int4[]', 'text'],
    ['text[]', ['a', 'b'], 'text[]', 'text'],
    ['Buffer', Buffer.from('abc'), 'bytea', 'binary'],
  ];

  for (const [label, value, cast, expected] of cases) {
    it(`${label} goes out as ${expected} on both drivers`, async () => {
      const both = await diff.bothWays(db =>
        bindFormat(() =>
          db.execute(sql`select ${sql.param(value)}::${sql.raw(cast)} as v`),
        ),
      );
      expect(both).toEqual({ pg: expected, pgjs: expected });
    });
  }

  /**
   * The one row where they differ, and it buys nothing: `jsonb`'s binary
   * form is the same JSON text behind a one-byte version marker. Through
   * drizzle's own encoders it does not arise at all - they hand the driver
   * a string - so this is the `sql` template case.
   */
  it('a plain object is the one parameter PostgreJS sends as binary', async () => {
    const both = await diff.bothWays(db =>
      bindFormat(() =>
        db.execute(sql`select ${sql.param({ a: 1 })}::jsonb as v`),
      ),
    );
    expect(both).toEqual({ pg: 'text', pgjs: 'binary' });
  });
});
