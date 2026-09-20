import { expect } from 'expect';
import { DataTypeOIDs } from 'postgrejs';
import { FETCH_AS_STRING } from '../../src/constants.js';
import { FakeClient } from '../_support/fakes.js';
import { fakeDb, users } from '../_support/schema.js';

/** The options every statement this driver sends is built with. */
describe('query options', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
  });

  async function optionsOfFirstQuery(config = {}) {
    await fakeDb(client, config).select().from(users);
    return client.queries[0]!.options as Record<string, any>;
  }

  it('turns rollbackOnError off, so a failed statement aborts the block', async () => {
    // PostgreJS wraps each statement in a transaction in a savepoint of its
    // own by default, which leaves the transaction usable after an error -
    // neither PostgreSQL's rule nor what a drizzle user expects.
    expect((await optionsOfFirstQuery()).rollbackOnError).toBe(false);
  });

  it('asks for unknown types as text by default', async () => {
    // Without it a schema with a single pgEnum silently returns Buffers.
    expect((await optionsOfFirstQuery()).unknownTypesAsString).toBe(true);
  });

  it('lets that be turned off', async () => {
    expect(
      (await optionsOfFirstQuery({ unknownTypesAsString: false }))
        .unknownTypesAsString,
    ).toBe(false);
  });

  it('carries the OIDs drizzle needs as text', async () => {
    expect((await optionsOfFirstQuery()).fetchAsString).toStrictEqual([
      ...FETCH_AS_STRING,
    ]);
  });

  it("appends a caller's extra OIDs rather than replacing the list", async () => {
    const fetchAsString = (
      await optionsOfFirstQuery({ fetchAsString: [DataTypeOIDs.uuid] })
    ).fetchAsString;
    expect(fetchAsString).toStrictEqual([
      ...FETCH_AS_STRING,
      DataTypeOIDs.uuid,
    ]);
  });

  it('does not let a caller mutate the shared list', async () => {
    const first = (await optionsOfFirstQuery()).fetchAsString;
    first.push(DataTypeOIDs.uuid);
    const second = new FakeClient();
    await fakeDb(second).select().from(users);
    expect(
      (second.queries[0]!.options as Record<string, any>).fetchAsString,
    ).toStrictEqual([...FETCH_AS_STRING]);
  });

  it('says nothing about prepare unless asked, so PostgreJS decides', async () => {
    expect((await optionsOfFirstQuery()).prepare).toBeUndefined();
  });

  it('passes prepare through when set - PgBouncer needs it off', async () => {
    expect((await optionsOfFirstQuery({ prepare: false })).prepare).toBe(false);
  });

  it('sends the same options on every statement, not just the first', async () => {
    const db = fakeDb(client);
    await db.select().from(users);
    await db.select().from(users);
    const [first, second] = client.queries.map(
      call => call.options as Record<string, any>,
    );
    expect(second!.rollbackOnError).toBe(first!.rollbackOnError);
    expect(second!.fetchAsString).toStrictEqual(first!.fetchAsString);
  });
});
