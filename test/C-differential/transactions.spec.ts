import { eq, relations, sql } from 'drizzle-orm';
import { integer, pgSchema, serial, text } from 'drizzle-orm/pg-core';
import { expect } from 'expect';
import {
  type Differential,
  openDifferential,
} from '../_support/differential.js';

const schema = pgSchema('drizzle_pgjs_diff_tx');

const authors = schema.table('authors', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
});
const books = schema.table('books', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').notNull(),
  title: text('title').notNull(),
  pages: integer('pages'),
});
const authorsRelations = relations(authors, ({ many }) => ({
  books: many(books),
}));
const booksRelations = relations(books, ({ one }) => ({
  author: one(authors, { fields: [books.authorId], references: [authors.id] }),
}));
const relationalSchema = { authors, books, authorsRelations, booksRelations };

const DDL = [
  `create table drizzle_pgjs_diff_tx.authors (id serial primary key, name text not null)`,
  `create table drizzle_pgjs_diff_tx.books (id serial primary key, author_id integer not null, title text not null, pages integer)`,
];

const SEED = async (db: any) => {
  await db.insert(authors).values([{ name: 'ada' }, { name: 'bob' }]);
  await db.insert(books).values([
    { authorId: 1, title: 'one', pages: 100 },
    { authorId: 1, title: 'two', pages: null },
    { authorId: 2, title: 'three', pages: 300 },
  ]);
};

describe('differential: transactions, joins and relational queries', () => {
  let diff: Differential;

  before(async () => {
    diff = await openDifferential('drizzle_pgjs_diff_tx', relationalSchema);
    diff.setSchema(DDL);
  });

  after(async () => {
    await diff?.close();
  });

  async function same<T>(fn: (db: any) => Promise<T>): Promise<void> {
    const answers = await diff.bothWays(fn);
    expect(answers.pgjs).toStrictEqual(answers.pg);
  }

  describe('transactions', () => {
    it('leaves the same rows behind after a commit', async () => {
      await same(async db => {
        await db.transaction(async (tx: any) => {
          await tx.insert(authors).values({ name: 'ada' });
          await tx.insert(authors).values({ name: 'bob' });
        });
        return db.select().from(authors).orderBy(authors.id);
      });
    });

    it('leaves the same rows behind after a rollback', async () => {
      await same(async db => {
        await db
          .transaction(async (tx: any) => {
            await tx.insert(authors).values({ name: 'ada' });
            throw new Error('boom');
          })
          .catch(() => undefined);
        return db.select().from(authors);
      });
    });

    it('aborts the block the same way after a failed statement', async () => {
      await same(async db => {
        const errors: string[] = [];
        await db
          .transaction(async (tx: any) => {
            await tx.insert(authors).values({ name: 'ada' });
            await tx
              .execute(sql`select 1 / 0`)
              .catch((error: any) => errors.push(error.cause?.code));
            await tx
              .insert(authors)
              .values({ name: 'bob' })
              .catch((error: any) => errors.push(error.cause?.code));
          })
          .catch(() => undefined);
        const rows = await db.select().from(authors);
        return { errors, rows };
      });
    });

    it('keeps the outer work when a savepoint rolls back', async () => {
      await same(async db => {
        await db.transaction(async (tx: any) => {
          await tx.insert(authors).values({ name: 'outer' });
          await tx
            .transaction(async (inner: any) => {
              await inner.insert(authors).values({ name: 'inner' });
              throw new Error('boom');
            })
            .catch(() => undefined);
        });
        return db
          .select({ name: authors.name })
          .from(authors)
          .orderBy(authors.name);
      });
    });

    it('reads its own uncommitted rows the same way', async () => {
      await same(db =>
        db.transaction(async (tx: any) => {
          await tx.insert(authors).values({ name: 'ada' });
          return tx.select({ name: authors.name }).from(authors);
        }),
      );
    });
  });

  describe('joins', () => {
    it('inner join', async () => {
      await same(async db => {
        await SEED(db);
        return db
          .select()
          .from(books)
          .innerJoin(authors, eq(books.authorId, authors.id))
          .orderBy(books.id);
      });
    });

    it('left join with no match, so the whole side is null', async () => {
      await same(async db => {
        await SEED(db);
        return db
          .select()
          .from(authors)
          .leftJoin(books, sql`false`)
          .orderBy(authors.id);
      });
    });

    it('group by with aggregates over a nullable column', async () => {
      await same(async db => {
        await SEED(db);
        return db
          .select({
            name: authors.name,
            titles: sql`count(${books.id})`.mapWith(Number),
            pages: sql`sum(${books.pages})`,
          })
          .from(authors)
          .leftJoin(books, eq(books.authorId, authors.id))
          .groupBy(authors.id, authors.name)
          .orderBy(authors.name);
      });
    });
  });

  describe('relational queries', () => {
    /**
     * These go through `customResultMapper` and array-mode rows, which is
     * the one execute() branch the other differential specs never reach.
     */
    async function sameRelational<T>(
      fn: (db: any) => Promise<T>,
    ): Promise<void> {
      const answers = await diff.bothWays(async db => {
        await SEED(db);
        return fn(db);
      });
      expect(answers.pgjs).toStrictEqual(answers.pg);
    }

    it('findMany with a many relation', async () => {
      await sameRelational(db =>
        db.query.authors.findMany({
          with: { books: true },
          orderBy: (table: any, { asc }: any) => asc(table.id),
        }),
      );
    });

    it('findFirst with a one relation', async () => {
      await sameRelational(db =>
        db.query.books.findFirst({
          with: { author: true },
          orderBy: (table: any, { asc }: any) => asc(table.id),
        }),
      );
    });

    it('a nested column selection with a limit', async () => {
      await sameRelational(db =>
        db.query.authors.findMany({
          columns: { name: true },
          with: {
            books: {
              columns: { title: true },
              limit: 1,
              orderBy: (t: any, { asc }: any) => asc(t.id),
            },
          },
          orderBy: (table: any, { asc }: any) => asc(table.id),
        }),
      );
    });

    it('extras computed in SQL', async () => {
      await sameRelational(db =>
        db.query.authors.findMany({
          extras: { upper: sql`upper(${authors.name})`.as('upper') },
          orderBy: (table: any, { asc }: any) => asc(table.id),
        }),
      );
    });
  });
});
