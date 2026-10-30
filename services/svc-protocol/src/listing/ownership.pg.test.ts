import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { assertTestDatabase, createDb, postgresAvailable } from '@intafaced/db';
import { issueChallenge, verifyOwnership, LISTING_NONCE_USED, type OwnershipChain } from './ownership.js';
import { PostgresListingStore } from './ownership.pg.js';

/** `protocol.listing_challenges` and `listing_ownership_proofs` (20261029070000) on a real test database. Deletes only this file's rows. */
const URL = process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migration = join(here, '..', '..', 'drizzle', '20261029070000_protocol_listing_ownership.sql');
const available = URL ? await postgresAvailable(URL) : false;
// The service's own client: drizzle shares it and reads timestamps back as text, which the store must handle.
const db = URL && available ? createDb({ url: URL, schema: 'protocol', max: 4 }, {}) : null;
const sql: Sql | null = db?.sql ?? null;
const CHAIN_ID = 84532;
const TOKEN = '0x00000000000000000000000000000000000ab001' as const;
const OWNER = privateKeyToAccount(`0x${'77'.repeat(32)}`);
const T0 = new Date('2026-10-30T12:00:00.000Z');

const chain: OwnershipChain = {
  chainId: CHAIN_ID,
  owner: async () => ({ owner: OWNER.address, blockNumber: 1234n }),
  hasCode: async () => false,
  isValidSignature: async () => null,
};

if (!sql) {
  describe.skip('listing ownership store (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('listing ownership store (Postgres)', () => {
    const cleanup = async () => {
      await sql!`DELETE FROM protocol.listing_ownership_proofs WHERE token ILIKE ${TOKEN}`;
      await sql!`DELETE FROM protocol.listing_challenges WHERE token ILIKE ${TOKEN}`;
    };
    beforeAll(async () => {
      await assertTestDatabase(sql!, 'svc-protocol ownership.pg.test');
      await sql!`CREATE SCHEMA IF NOT EXISTS protocol`;
      await sql!.unsafe(readFileSync(migration, 'utf8'));
      await cleanup();
    });
    afterAll(async () => {
      await cleanup();
      await db!.close();
    });

    it('stores a proof with the block the owner was read at, and a replayed challenge stores nothing more', async () => {
      const store = new PostgresListingStore(sql!);
      const challenge = await issueChallenge(store, 300, CHAIN_ID, TOKEN, T0, 'ab'.repeat(16));
      const found = await store.findChallenge(challenge.nonce);
      expect(found).toMatchObject({ nonce: challenge.nonce, chainId: CHAIN_ID, message: challenge.message, usedAt: null });
      expect(found!.expiresAt.toISOString()).toBe('2026-10-30T12:05:00.000Z');

      const signature = await OWNER.signMessage({ message: challenge.message });
      const proof = await verifyOwnership(store, chain, { nonce: challenge.nonce, signature }, new Date(T0.getTime() + 1000));
      expect(proof.signer).toBe(OWNER.address);
      const rows =
        await sql!`SELECT signer, block_number::text AS block, signature FROM protocol.listing_ownership_proofs WHERE nonce = ${challenge.nonce}`;
      expect(rows).toEqual([{ signer: OWNER.address, block: '1234', signature }]);
      expect((await store.findChallenge(challenge.nonce))!.usedAt).not.toBeNull();

      await expect(
        verifyOwnership(store, chain, { nonce: challenge.nonce, signature }, new Date(T0.getTime() + 2000)),
      ).rejects.toMatchObject({
        code: LISTING_NONCE_USED,
      });
      expect(await sql!`SELECT count(*)::int AS n FROM protocol.listing_ownership_proofs WHERE token ILIKE ${TOKEN}`).toEqual([{ n: 1 }]);
    });

    it('two verifies racing on one nonce store one proof', async () => {
      const store = new PostgresListingStore(sql!);
      const challenge = await issueChallenge(store, 300, CHAIN_ID, TOKEN, T0, 'cd'.repeat(16));
      const signature = await OWNER.signMessage({ message: challenge.message });
      const at = new Date(T0.getTime() + 1000);
      const results = await Promise.allSettled([
        verifyOwnership(store, chain, { nonce: challenge.nonce, signature }, at),
        verifyOwnership(store, chain, { nonce: challenge.nonce, signature }, at),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code)).toEqual([
        LISTING_NONCE_USED,
      ]);
      expect(await sql!`SELECT count(*)::int AS n FROM protocol.listing_ownership_proofs WHERE nonce = ${challenge.nonce}`).toEqual([
        { n: 1 },
      ]);
    });
  });
}
