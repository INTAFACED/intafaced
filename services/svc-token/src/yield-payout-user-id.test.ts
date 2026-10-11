import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { STAKE_TIERS } from './economics/staking.js';

/**
 * L1249. `yield_payouts.user_id` must be text, the same type as `stakes.user_id`.
 *
 * A staker id that is not a uuid has to freeze into the payout plan. A
 * uuid-shaped id still has to. `stakes.user_id` and `governance_votes.user_id`
 * stay text. The admin URL is `postgres`, and the migrated database is a
 * per-run name other than `intafaced_test`.
 *
 * The stake ids and the yield figure are existing svc-token fixtures. The
 * non-uuid id is the existing probe. No new identity, yield amount, or rate.
 * The insert copies `stakes.user_id`. It does not open a ledger account.
 */

const ADMIN_URL = 'postgres://127.0.0.1:5432/postgres';
const UUID_STAKER = '11111111-1111-4111-8111-111111111111';
const TEXT_STAKER = 'not-a-uuid';
const UUID_STAKE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEXT_STAKE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STAKE_AMOUNT = '1000';
const YIELD_AMOUNT = '100';
const WINDOW_ID = 'l1249-payout-user-id';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzleDir, file), 'utf8'));

function runDatabaseName(): string {
  const name = `itf_l1249_${process.pid}_${Math.random().toString(36).slice(2, 8)}_test`;
  if (name === 'intafaced_test' || !/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`refusing database name ${name}`);
  }
  return name;
}

describe('L1249 payout user id', () => {
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let database = '';

  beforeAll(async () => {
    database = runDatabaseName();
    admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
    const adminDb = await admin<Array<{ db: string }>>`SELECT current_database() AS db`;
    if (adminDb[0]?.db === 'intafaced_test') throw new Error('refusing to migrate intafaced_test');
    await admin.unsafe(`CREATE DATABASE "${database}"`);

    const url = new URL(ADMIN_URL);
    url.pathname = `/${database}`;
    sql = postgres(url.toString(), { max: 4, onnotice: () => undefined });
    const live = await sql<Array<{ db: string }>>`SELECT current_database() AS db`;
    if (live[0]?.db !== database || live[0]?.db === 'intafaced_test') {
      throw new Error(`refusing to migrate ${live[0]?.db ?? '<unknown>'}`);
    }
    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await sql.unsafe('CREATE SCHEMA IF NOT EXISTS token');
    for (const migration of migrations) {
      await sql.unsafe(migration);
    }
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 0 }).catch(() => undefined);
    if (admin && database && database !== 'intafaced_test') {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
    }
  }, 30_000);

  it('does not cast the payout user id before insert', () => {
    const src = readFileSync(join(here, 'token-service.ts'), 'utf8');
    const insert = src.slice(src.indexOf('INSERT INTO token.yield_payouts'));
    expect(insert.startsWith('INSERT INTO token.yield_payouts')).toBe(true);
    expect(insert).toMatch(/VALUES \(\$\{windowId\}, \$\{row\.userId\}, \$\{formatAmount\(row\.amount\)\}::numeric\)/);
    expect(insert).not.toMatch(/row\.userId\}::uuid/);
    expect(src).not.toMatch(/yield_payouts[\s\S]{0,240}::uuid/);
  });

  it('stores yield_payouts.user_id as text and leaves the other user ids text', async () => {
    const cols = await sql<Array<{ table_name: string; data_type: string }>>`
      SELECT table_name, data_type
        FROM information_schema.columns
       WHERE table_schema = 'token'
         AND column_name = 'user_id'
         AND table_name IN ('yield_payouts', 'stakes', 'governance_votes')
       ORDER BY table_name
    `;
    const typeOf = (table: string) => cols.find((column) => column.table_name === table)?.data_type;
    expect(typeOf('governance_votes')).toBe('text');
    expect(typeOf('stakes')).toBe('text');
    expect(typeOf('yield_payouts')).toBe('text');
    expect(database).not.toBe('intafaced_test');
  });

  it('freezes a non-uuid staker id and a uuid-shaped id into the payout plan', async () => {
    const flexMultiplier = String(STAKE_TIERS.flex.multiplierBps);
    for (const [userId, stakeId] of [
      [UUID_STAKER, UUID_STAKE_ID],
      [TEXT_STAKER, TEXT_STAKE_ID],
    ] as const) {
      await sql`
        INSERT INTO token.stakes (id, user_id, amount, tier, multiplier_bps, status)
        VALUES (
          ${stakeId}, ${userId}, ${STAKE_AMOUNT}::numeric, 'flex', ${flexMultiplier}::numeric, 'active'
        )
      `;
    }

    const stakes = await sql<Array<{ user_id: string }>>`
      SELECT user_id FROM token.stakes WHERE status = 'active' ORDER BY user_id
    `;
    for (const stake of stakes) {
      await sql`
        INSERT INTO token.yield_payouts (window_id, user_id, amount)
        VALUES (${WINDOW_ID}, ${stake.user_id}, ${YIELD_AMOUNT}::numeric)
      `;
    }

    const rows = await sql<Array<{ user_id: string; amount: string }>>`
      SELECT user_id, amount::text AS amount
        FROM token.yield_payouts
       WHERE window_id = ${WINDOW_ID}
       ORDER BY user_id
    `;
    expect(rows.map((row) => row.user_id)).toEqual(stakes.map((stake) => stake.user_id));
    expect(rows.map((row) => row.user_id)).toEqual([UUID_STAKER, TEXT_STAKER].sort());
    for (const row of rows) {
      expect(parseAmount(row.amount) > 0n).toBe(true);
    }
  });
});
