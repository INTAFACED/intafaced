import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { assertTestDatabase, createDb, postgresAvailable } from '@intafaced/db';
import { embeddedWalletKey } from '@intafaced/contracts/protocol-embedded-wallet';
import { PostgresEmbeddedWalletStore } from './embedded.pg.js';
import type { EmbeddedWalletRow } from './embedded.js';

/** `protocol.embedded_wallets` (20261109084145) on a real test database. Deletes only this file's rows. */
// CI provides the database; this test runs unconditionally and fails where none answers.
const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced:intafaced@127.0.0.1:5432/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const migration = join(here, '..', '..', 'drizzle', '20261109084145_protocol_embedded_wallets.sql');
if (!(await postgresAvailable(URL))) throw new Error('postgres unavailable');
const db = createDb({ url: URL, schema: 'protocol', max: 4 }, {});
const sql: Sql = db.sql;
const PERSON = '77777777-7777-4777-8777-777777777777';
const OTHER = '88888888-8888-4888-8888-888888888888';
const T0 = new Date('2026-11-09T09:00:00.000Z');
const row = (userId: string, walletId: string, address: string): EmbeddedWalletRow => ({
  userId,
  idempotencyKey: embeddedWalletKey(userId),
  provider: 'test',
  providerWalletId: walletId,
  address: getAddress(address),
  test: true,
  createdAt: T0,
});

describe('embedded wallet store (Postgres)', () => {
  const cleanup = () => sql`DELETE FROM protocol.embedded_wallets WHERE user_id IN (${PERSON}, ${OTHER})`;
  beforeAll(async () => {
    await assertTestDatabase(sql, 'svc-protocol embedded.pg.test');
    await sql`CREATE SCHEMA IF NOT EXISTS protocol`;
    await sql.unsafe(readFileSync(migration, 'utf8'));
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await db.close();
  });

  it('one row per person under wallet:embedded:<personId>: a replay writes nothing and returns the first', async () => {
    const store = new PostgresEmbeddedWalletStore(sql);
    expect(await store.find(PERSON)).toBeNull();
    const first = await store.insert(row(PERSON, 'testw_pg_1', '0x00000000000000000000000000000000000000a1'));
    expect(first).toEqual({ created: true, row: row(PERSON, 'testw_pg_1', '0x00000000000000000000000000000000000000a1') });
    const again = await store.insert(row(PERSON, 'testw_pg_2', '0x00000000000000000000000000000000000000a2'));
    expect(again).toEqual({ created: false, row: first.row });
    const [count] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM protocol.embedded_wallets WHERE user_id = ${PERSON}`;
    expect(count?.n).toBe(1);
  });

  it('the same provider wallet already recorded for someone else is refused by name, never recorded twice', async () => {
    const store = new PostgresEmbeddedWalletStore(sql);
    await expect(store.insert(row(OTHER, 'testw_pg_1', '0x00000000000000000000000000000000000000a1'))).rejects.toMatchObject({
      code: 'wallet.embedded_wallet_mismatch',
    });
    expect(await store.find(OTHER)).toBeNull();
  });

  it('the table refuses a key that is not the person’s and has no column that could hold key material', async () => {
    await expect(
      sql`INSERT INTO protocol.embedded_wallets (idempotency_key, user_id, provider, provider_wallet_id, address, test, created_at)
          VALUES ('wallet:embedded:someone-else', ${OTHER}, 'test', 'testw_pg_3', '0x00000000000000000000000000000000000000a3', true, now())`,
    ).rejects.toThrow(/embedded_wallets_key_ck/);
    const columns = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns WHERE table_schema = 'protocol' AND table_name = 'embedded_wallets' ORDER BY column_name`;
    expect(columns.map((c) => c.column_name)).toEqual([
      'address',
      'created_at',
      'idempotency_key',
      'provider',
      'provider_wallet_id',
      'test',
      'user_id',
    ]);
  });
});
