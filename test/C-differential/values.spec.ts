import { sql } from 'drizzle-orm';
import { expect } from 'expect';
import {
  type Differential,
  openDifferential,
} from '../_support/differential.js';

/**
 * The table in the README under "What changes when you switch" - every case
 * where a raw `db.execute()` hands back a different value on the two
 * drivers, run through both and compared rather than asserted from memory.
 *
 * The point of pinning it here rather than in `test/B-live` is the other
 * column: what `pg` gives is as much a part of the claim as what PostgreJS
 * gives, and only running `pg` says what that is. `circle` is why - the
 * README said "pg leaves you the text" for the whole geometric family and
 * `pg` in fact decodes that one, which this caught.
 */
describe('differential: the values that differ', () => {
  let diff: Differential;

  before(async () => {
    diff = await openDifferential('drizzle_pgjs_diff_values');
    diff.setSchema([]);
  });

  after(async () => {
    await diff?.close();
  });

  /** How the README describes a value, so the two columns can be compared. */
  const describeValue = (value: unknown): string => {
    if (value === null) return 'null';
    if (typeof value !== 'object')
      return `${typeof value} ${JSON.stringify(value)}`;
    const name = (value as object).constructor?.name ?? 'object';
    return name === 'Object' || name === 'Array'
      ? `plain ${JSON.stringify(value)}`
      : name;
  };

  const cases: [string, string, string, string][] = [
    ['money', `'12.34'::money`, 'string "$12.34"', 'number 12.34'],
    ['int4range', `'[1,5)'::int4range`, 'string "[1,5)"', 'Range'],
    ['path', `'[(0,0),(1,1)]'::path`, 'string "[(0,0),(1,1)]"', 'Path'],
    [
      'polygon',
      `'((0,0),(1,1))'::polygon`,
      'string "((0,0),(1,1))"',
      'Polygon',
    ],
    ['box', `'((0,0),(1,1))'::box`, 'string "(1,1),(0,0)"', 'Box'],
    ['lseg', `'[(0,0),(1,1)]'::lseg`, 'string "[(0,0),(1,1)]"', 'LineSegment'],
    // pg decodes these two as well, so they are not "text against a class"
    [
      'circle',
      `'<(0,0),1>'::circle`,
      'plain {"x":0,"y":0,"radius":1}',
      'Circle',
    ],
    // and this one goes the other way: asked for as text here, decoded there
    ['point', `'(1,2)'::point`, 'plain {"x":1,"y":2}', 'string "(1,2)"'],
    ['line', `'{1,2,3}'::line`, 'string "{1,2,3}"', 'string "{1,2,3}"'],
  ];

  for (const [name, expression, underPg, underThis] of cases) {
    it(`${name}: ${underPg} against ${underThis}`, async () => {
      const answers = await diff.bothWays(async db => {
        const result = await db.execute(
          sql`select ${sql.raw(expression)} as v`,
        );
        return describeValue(result.rows[0]!.v);
      });
      expect(answers.pg).toStrictEqual(underPg);
      expect(answers.pgjs).toStrictEqual(underThis);
    });
  }
});
