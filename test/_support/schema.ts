import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core';
import { drizzle, type PgjsDrizzleConfig } from '../../src/index.js';
import type { FakeClient } from './fakes.js';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  age: integer('age'),
});

/** A database over a fake client, with logging off unless a test asks. */
export function fakeDb(client: FakeClient, config: PgjsDrizzleConfig = {}) {
  return drizzle(client as any, { logger: false, ...config });
}
