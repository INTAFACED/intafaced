/**
 * `@intafaced/db` for the TypeScript database tests run against the Rust door (`vitest.config.mts`): everything as it
 * is, except `createTestDb`, which hands the test a book the Rust binary migrated and serves (`rust-door.ts`). The
 * test's own migrations are not run: the binary's are the ones under test, and a test that wrote through them reads
 * back what the binary would.
 */
import type { TestDb, TestDbOptions } from '../../../../packages/db/dist/index.js';
import { openRustBook, type RustBook } from './rust-door.ts';

export * from '../../../../packages/db/dist/index.js';

let current: RustBook | null = null;

/** The book the running test file opened; `rust-s2s-http.ts` posts to its doors. */
export function currentRustBook(): RustBook {
  if (!current) throw new Error('no Rust book open: the test called handleS2sPost before createTestDb');
  return current;
}

export async function createTestDb(_options: TestDbOptions): Promise<TestDb> {
  const book = await openRustBook();
  current = book;
  return {
    url: book.url,
    schema: 'ledger',
    sql: book.sql,
    async truncateAll() {
      throw new Error('truncateAll is not offered on the Rust book');
    },
    async drop() {
      if (current === book) current = null;
      await book.teardown();
    },
  };
}
