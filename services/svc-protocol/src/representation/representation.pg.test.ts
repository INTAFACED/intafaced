import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { assertTestDatabase, createDb, postgresAvailable } from '@intafaced/db';
import { PostgresRepresentationStore } from './representation.pg.js';

/** `protocol.signing_representations` (20261024070458) on a real test database. Deletes only this file's rows. */
const URL = process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migration = join(here, '..', '..', 'drizzle', '20261024070458_protocol_signing_representations.sql');
const available = URL ? await postgresAvailable(URL) : false;
// The service's own client: drizzle shares it and reads timestamps back as text, which the store must handle.
const db = URL && available ? createDb({ url: URL, schema: 'protocol', max: 2 }, {}) : null;
const sql: Sql | null = db?.sql ?? null;
const CHAIN_ID = 84532;
const WALLET = privateKeyToAccount(`0x${'66'.repeat(32)}`);

if (!sql) {
  describe.skip('representation store (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('representation store (Postgres)', () => {
    const cleanup = () => sql!`DELETE FROM protocol.signing_representations WHERE address = ${WALLET.address}`;
    beforeAll(async () => {
      await assertTestDatabase(sql!, 'svc-protocol representation.pg.test');
      await sql!`CREATE SCHEMA IF NOT EXISTS protocol`;
      await sql!.unsafe(readFileSync(migration, 'utf8'));
      await cleanup();
    });
    afterAll(async () => {
      await cleanup();
      await db!.close();
    });

    it('stores one row per version, finds it by any address case and keeps the first time on a repeat', async () => {
      const store = new PostgresRepresentationStore(sql!);
      expect(await store.find(CHAIN_ID, WALLET.address, 'TEST-1')).toBeNull();
      const row = { chainId: CHAIN_ID, address: WALLET.address, version: 'TEST-1', message: 'm1', signature: '0xaa' as const };
      const first = await store.put(row);
      expect(first.acceptedAt).toBeInstanceOf(Date);
      expect(Number.isNaN(first.acceptedAt.getTime())).toBe(false);
      const again = await store.put({ ...row, message: 'changed', signature: '0xbb' });
      expect(again).toEqual(first);
      expect(again.message).toBe('m1');
      expect(await store.find(CHAIN_ID, WALLET.address.toLowerCase() as `0x${string}`, 'TEST-1')).toEqual(first);
      expect(await store.find(CHAIN_ID, WALLET.address, 'TEST-2')).toBeNull();
      await store.put({ ...row, version: 'TEST-2' });
      expect(await sql!`SELECT version FROM protocol.signing_representations WHERE address = ${WALLET.address} ORDER BY version`).toEqual([
        { version: 'TEST-1' },
        { version: 'TEST-2' },
      ]);
    });
  });
}
