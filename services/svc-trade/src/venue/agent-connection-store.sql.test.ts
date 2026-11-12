import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client/money';
import { SqlAgentAccountStore, type AgentAccountRecord } from './agent-account-store.js';
import { SqlAgentConnectionStore } from './agent-connection-store.js';

// trade.user_venue_agent_connections (J-agents-21 #6): one active connection per key, never deleted, its terms fixed.

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. The agent connection store test does not start Docker.');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const USER = '11111111-1111-4111-8111-1111111111f1';
const ACCOUNT_A = '5a5a5a5a-0000-4000-8000-0000000000f1';
const ACCOUNT_B = '5a5a5a5a-0000-4000-8000-0000000000f2';
const KEY = '22222222-2222-4222-8222-2222222222f1';
const account = (accountId: string, agent: string): AgentAccountRecord => ({
  userId: USER,
  accountId,
  venueId: 'test-venue-sim',
  owner: '0x00000000000000000000000000000000000000f1',
  subAccount: null,
  name: `assistant-${accountId.slice(-12)}`,
  asset: 'USDC',
  cap: parseAmount('200'),
  agentAddress: agent,
  fundAmount: parseAmount('150'),
  status: 'opening',
  createdAt: new Date('2026-11-11T12:00:00Z'),
  openedAt: null,
  closedAt: null,
});

describe('SqlAgentConnectionStore on Postgres (trade.user_venue_agent_connections)', () => {
  let db: TestDatabase | undefined;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
    const accounts = new SqlAgentAccountStore(db.sql);
    for (const [id, agent] of [
      [ACCOUNT_A, '0x00000000000000000000000000000000000000a1'],
      [ACCOUNT_B, '0x00000000000000000000000000000000000000a2'],
    ] as const) {
      await accounts.insertOnce(account(id, agent), {
        userId: USER,
        accountId: id,
        moveId: id,
        direction: 'into_sub_account',
        amount: parseAmount('150'),
        state: 'pending',
        createdAt: new Date(),
      });
    }
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('a key has one active connection: a second connect, even to another account, returns the first', async () => {
    const store = new SqlAgentConnectionStore(db!.sql);
    const at = new Date('2026-11-11T12:30:00Z');
    const first = await store.connectOnce({ keyId: KEY, userId: USER, accountId: ACCOUNT_A, createdAt: at, endedAt: null });
    expect(first).toEqual({ keyId: KEY, userId: USER, accountId: ACCOUNT_A, createdAt: at, endedAt: null });
    const again = await store.connectOnce({ keyId: KEY, userId: USER, accountId: ACCOUNT_B, createdAt: new Date(), endedAt: null });
    expect(again.accountId).toBe(ACCOUNT_A);
    expect(await store.active(KEY)).toEqual(first);
    expect((await store.listActive(USER)).map((c) => c.keyId)).toEqual([KEY]);
  });

  it('a connection is never deleted and its account never changes; once ended it stays ended', async () => {
    const sql = db!.sql;
    await expect(sql`DELETE FROM trade.user_venue_agent_connections WHERE key_id = ${KEY}`).rejects.toThrow(/never deleted/);
    await expect(sql`UPDATE trade.user_venue_agent_connections SET account_id = ${ACCOUNT_B} WHERE key_id = ${KEY}`).rejects.toThrow(
      /only an active connection may end/,
    );
    await sql`UPDATE trade.user_venue_agent_connections SET ended_at = now() WHERE key_id = ${KEY} AND ended_at IS NULL`;
    await expect(sql`UPDATE trade.user_venue_agent_connections SET ended_at = NULL WHERE key_id = ${KEY}`).rejects.toThrow(
      /only an active connection may end/,
    );
    const store = new SqlAgentConnectionStore(sql);
    expect(await store.active(KEY)).toBeNull();
    // Ended, the key may be connected again.
    const next = await store.connectOnce({ keyId: KEY, userId: USER, accountId: ACCOUNT_B, createdAt: new Date(), endedAt: null });
    expect(next.accountId).toBe(ACCOUNT_B);
  });

  it("refuses a connection to an account that isn't stored", async () => {
    const store = new SqlAgentConnectionStore(db!.sql);
    await expect(
      store.connectOnce({
        keyId: '22222222-2222-4222-8222-2222222222f9',
        userId: USER,
        accountId: '5a5a5a5a-0000-4000-8000-0000000000ff',
        createdAt: new Date(),
        endedAt: null,
      }),
    ).rejects.toThrow(/foreign key/);
  });
});
