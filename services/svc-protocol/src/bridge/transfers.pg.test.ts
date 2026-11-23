import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { getAddress } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, createDb, postgresAvailable } from '@intafaced/db';
import { PostgresBridgeTransferStore } from './transfers.pg.js';
import { bridgeIntentId } from './transfers.js';

/** `protocol.bridge_transfers` (20261121120000) on a real test database. Deletes only this file's wallets' rows. */
const URL = process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migration = join(here, '..', '..', 'drizzle', '20261121120000_protocol_bridge_transfers.sql');
const available = URL ? await postgresAvailable(URL) : false;
// The service's own client: drizzle shares it and reads timestamps back as text, which the store must handle.
const db = URL && available ? createDb({ url: URL, schema: 'protocol', max: 4 }, {}) : null;
const sql: Sql | null = db?.sql ?? null;
const A = getAddress('0x00000000000000000000000000000000000b41d1');
const B = getAddress('0x00000000000000000000000000000000000b41d2');
const BURN = `0x${'ab'.repeat(32)}` as const;
const row = (wallet: typeof A, key: string) => ({
  wallet,
  key,
  intentId: bridgeIntentId(wallet, key),
  fromChainId: 84532,
  toChainId: 31337,
  token: 'TUSDC',
  amountUnits: 1_500_000n,
});

if (!sql) {
  describe.skip('bridge transfer store (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('bridge transfer store (Postgres)', () => {
    const cleanup = async () => {
      await sql!`DELETE FROM protocol.bridge_transfers WHERE wallet IN (${A.toLowerCase()}, ${B.toLowerCase()})`;
    };
    beforeAll(async () => {
      await assertTestDatabase(sql!, 'svc-protocol transfers.pg.test');
      await sql!`CREATE SCHEMA IF NOT EXISTS protocol`;
      await sql!.unsafe(readFileSync(migration, 'utf8'));
      await cleanup();
    });
    afterAll(async () => {
      await cleanup();
      await db!.close();
    });

    it('stores one transfer per wallet and key, even when the same start arrives twice at once', async () => {
      const store = new PostgresBridgeTransferStore(sql!);
      const [first, second] = await Promise.all([store.insert(row(A, 'bridge-pg-0001')), store.insert(row(A, 'bridge-pg-0001'))]);
      expect(second.id).toBe(first.id);
      expect(first).toMatchObject({ wallet: A, state: 'awaiting_burn', burnTx: null, amountUnits: 1_500_000n });
      expect(first.createdAt).toBeInstanceOf(Date);
      expect(Number.isNaN(first.createdAt.getTime())).toBe(false);
      expect(await store.list(A)).toHaveLength(1);
      expect(await store.countWaiting(A)).toBe(1);
      // Another wallet's rows are its own.
      expect(await store.get(B, first.id)).toBeNull();
      expect(await store.findByKey(B, 'bridge-pg-0001')).toBeNull();
      expect(await store.get(A, 'not-a-uuid')).toBeNull();
    });

    it('moves a row on only from the state it was read in, and the table refuses a state without its burn or attestation', async () => {
      const store = new PostgresBridgeTransferStore(sql!);
      const t = await store.insert(row(A, 'bridge-pg-0002'));
      const next = { state: 'burn_submitted' as const, burnTx: BURN, attestation: null };
      const raced = await Promise.all([store.advance(t.id, 'awaiting_burn', next), store.advance(t.id, 'awaiting_burn', next)]);
      expect(raced.filter(Boolean)).toHaveLength(1);
      expect(await store.get(A, t.id)).toMatchObject({ state: 'burn_submitted', burnTx: BURN });
      await expect(store.advance(t.id, 'burn_submitted', { state: 'mint_ready', burnTx: BURN, attestation: null })).rejects.toThrow();
      await expect(store.advance(t.id, 'burn_submitted', { state: 'minted', burnTx: null, attestation: null })).rejects.toThrow();
      expect(await store.advance(t.id, 'burn_submitted', { state: 'mint_ready', burnTx: BURN, attestation: `0x${'11'.repeat(65)}` })).toBe(
        true,
      );
      await expect(store.insert({ ...row(B, 'bridge-pg-0003'), amountUnits: 0n })).rejects.toThrow();
    });
  });
}
