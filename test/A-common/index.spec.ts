import { expect } from 'expect';
import * as api from '../../src/index.js';

/**
 * The export surface is part of the contract - and `FETCH_AS_STRING` in
 * particular, because a caller who needs a type fetched as text has to be
 * able to see what is already on the list before adding to it.
 */
describe('package exports', () => {
  it('exports the driver, its classes and the constants', () => {
    expect(Object.keys(api).sort()).toStrictEqual([
      'FETCH_AS_STRING',
      'MULTIPLE_COMMANDS_ERROR_CODE',
      'PgjsDatabase',
      'PgjsDriver',
      'PgjsPreparedQuery',
      'PgjsSession',
      'PgjsTransaction',
      'bindParam',
      'drizzle',
      'migrate',
      'toQueryResult',
      'toQueryResults',
    ]);
  });

  it('keeps the OID list from being edited in place', () => {
    expect(Object.isFrozen(api.FETCH_AS_STRING)).toBe(true);
  });
});
