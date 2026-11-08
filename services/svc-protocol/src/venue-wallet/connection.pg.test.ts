import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { assertTestDatabase, createDb, postgresAvailable } from '@intafaced/db';
import { PostgresVenueConnectionStore } from './connection.pg.js';
import { venueConnectKey } from './connection.js';

/** `protocol.venue_wallet_connections` and `protocol.venue_wallet_nonces` (20261108194447) on a real test database. Deletes only this file's rows. */
// CI provides the database; this test runs unconditionally and fails where none answers.
const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced:intafaced@127.0.0.1:5432/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const migration = join(here, '..', '..', 'drizzle', '20261108194447_protocol_venue_wallet_connections.sql');
if (!(await postgresAvailable(URL))) throw new Error('postgres unavailable');
const db = createDb({ url: URL, schema: 'protocol', max: 4 }, {});
const sql: Sql = db.sql;
const CHAIN_ID = 84532;
const WALLET = getAddress('0x000000000000000000000000000000000000c0e9');
const PERSON = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const T0 = new Date('2026-11-08T20:00:00.000Z');
const plus = (s: number) => new Date(T0.getTime() + s * 1000);

describe('venue wallet connection store (Postgres)', () => {
  const cleanup = async () => {
    await sql`DELETE FROM protocol.venue_wallet_connections WHERE user_id IN (${PERSON}, ${OTHER})`;
    await sql`DELETE FROM protocol.venue_wallet_nonces WHERE user_id IN (${PERSON}, ${OTHER})`;
  };
  beforeAll(async () => {
    await assertTestDatabase(sql, 'svc-protocol venue connection.pg.test');
    await sql`CREATE SCHEMA IF NOT EXISTS protocol`;
    await sql.unsafe(readFileSync(migration, 'utf8'));
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await db.close();
  });

  it('a nonce opens one connection once, even when two requests race; a reconnect renews the same row', async () => {
    const store = new PostgresVenueConnectionStore(sql);
    const input = { userId: PERSON, chainId: CHAIN_ID, address: WALLET, nonce: 'pgTestNonceA1', connectedAt: T0, expiresAt: plus(60) };
    const results = await Promise.all([store.open(input), store.open(input)]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await store.open(input)).toBeNull();
    const renewed = await store.open({
      ...input,
      address: getAddress(WALLET),
      nonce: 'pgTestNonceB2',
      connectedAt: plus(90),
      expiresAt: plus(150),
    });
    expect(renewed).toMatchObject({ address: WALLET, connectedAt: plus(90), expiresAt: plus(150), revokedAt: null });
    const rows = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM protocol.venue_wallet_connections WHERE user_id = ${PERSON}`;
    expect(rows).toEqual([{ count: 1 }]);
    const spent = await sql<{ idempotency_key: string }[]>`
      SELECT idempotency_key FROM protocol.venue_wallet_nonces WHERE user_id = ${PERSON} ORDER BY idempotency_key`;
    expect(spent.map((r) => r.idempotency_key)).toEqual([
      venueConnectKey(CHAIN_ID, 'pgTestNonceA1'),
      venueConnectKey(CHAIN_ID, 'pgTestNonceB2'),
    ]);
  });

  it('the table holds no key column: an address and its times only', async () => {
    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'protocol' AND table_name = 'venue_wallet_connections' ORDER BY column_name`;
    expect(cols.map((c) => c.column_name)).toEqual([
      'address',
      'chain_id',
      'connected_at',
      'created_at',
      'expires_at',
      'id',
      'nonce',
      'revoked_at',
      'updated_at',
      'user_id',
    ]);
  });

  it('reads and disconnects only the owner’s connection, in any letter case', async () => {
    const store = new PostgresVenueConnectionStore(sql);
    expect(await store.find(OTHER, CHAIN_ID, WALLET)).toBeNull();
    expect(await store.list(OTHER, CHAIN_ID)).toEqual([]);
    expect(await store.revoke(OTHER, CHAIN_ID, WALLET, plus(100))).toBe(false);
    expect((await store.find(PERSON, CHAIN_ID, WALLET.toLowerCase() as `0x${string}`))?.address).toBe(WALLET);
    expect(await store.revoke(PERSON, CHAIN_ID, WALLET, plus(100))).toBe(true);
    expect(await store.revoke(PERSON, CHAIN_ID, WALLET, plus(101))).toBe(false);
    expect(await store.list(PERSON, CHAIN_ID)).toEqual([]);
    expect((await store.find(PERSON, CHAIN_ID, WALLET))?.revokedAt).toEqual(plus(100));
  });

  it('the table refuses an expiry that is not after the connection', async () => {
    await expect(
      sql`INSERT INTO protocol.venue_wallet_connections (user_id, chain_id, address, connected_at, expires_at, nonce)
          VALUES (${OTHER}, ${CHAIN_ID}, ${WALLET}, ${T0.toISOString()}, ${T0.toISOString()}, 'x')`,
    ).rejects.toThrow(/venue_wallet_connections_expiry_ck/);
  });
});
