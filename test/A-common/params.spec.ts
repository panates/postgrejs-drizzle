import { expect } from 'expect';
import { BindParam } from 'postgrejs';
import { bindParam } from '../../src/params.js';

/**
 * The boundary here is not a style choice - it was measured. Wrapping a
 * value in `BindParam(0, ...)` asks the server to infer the type, which is
 * what drizzle's stringified parameters need; doing the same to a value
 * PostgreJS encodes itself breaks it.
 */
describe('bindParam()', () => {
  const wrapped = [
    ['string', 'abc'],
    ['empty string', ''],
    ['number', 42],
    ['zero', 0],
    ['boolean', true],
    ['bigint', 1n],
    ['null', null],
    ['undefined', undefined],
  ] as const;

  for (const [label, value] of wrapped) {
    it(`wraps a ${label}, so the server picks the type`, () => {
      const result = bindParam(value);
      expect(result).toBeInstanceOf(BindParam);
      expect((result as BindParam).oid).toStrictEqual(0);
      expect((result as BindParam).value).toStrictEqual(value);
    });
  }

  const passedThrough = [
    ['Date', new Date('2024-03-05T06:07:08.900Z')],
    ['Buffer', Buffer.from([1, 2])],
    ['array', [1, 2]],
    ['plain object', { a: 1 }],
  ] as const;

  for (const [label, value] of passedThrough) {
    it(`leaves a ${label} to PostgreJS's own encoder`, () => {
      // Wrapping these sends their JS text form, which the server cannot
      // parse: `invalid input syntax for type timestamp: "Tue Mar 05 ..."`,
      // `malformed array literal: "1,2"`, `invalid input syntax for json`.
      expect(bindParam(value)).toBe(value);
    });
  }

  it('leaves a BindParam a caller built itself alone', () => {
    const param = new BindParam(0, 'abc');
    expect(bindParam(param)).toBe(param);
  });
});
