import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { compare, parseAmount } from '@intafaced/ledger-client/money';
import { netFunding, SqlAgentAccountStore, type AgentAccountRecord, type AgentMoveRecord } from './agent-account-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. The agent account store test does not start Docker.');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const USER = '11111111-1111-4111-8111-1111111111d1';
const ACCOUNT = '5a5a5a5a-0000-4000-8000-0000000000d1';
const a = parseAmount;
const account: AgentAccountRecord = {
  userId: USER,
  accountId: ACCOUNT,
  venueId: 'test-venue-sim',
  owner: '0x00000000000000000000000000000000000000d1',
  subAccount: null,
  name: 'assistant-0000000000d1',
  asset: 'USDC',
  cap: a('200'),
  agentAddress: '0x00000000000000000000000000000000000000a1',
  fundAmount: a('150'),
  status: 'opening',
  createdAt: new Date('2026-11-09T12:00:00Z'),
  openedAt: null,
  closedAt: null,
};
const move = (moveId: string, amount: string, direction: AgentMoveRecord['direction'] = 'into_sub_account'): AgentMoveRecord => ({
  userId: USER,
  accountId: ACCOUNT,
  moveId,
  direction,
  amount: a(amount),
  state: 'pending',
  createdAt: new Date(),
});

describe('SqlAgentAccountStore on Postgres (trade.user_venue_agent_accounts, trade.user_venue_agent_moves)', () => {
  let db: TestDatabase | undefined;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('stores one account and its first move per id; a second insert is the first', async () => {
    const store = new SqlAgentAccountStore(db!.sql);
    const first = await store.insertOnce(account, move(ACCOUNT, '150'));
    expect(first).toEqual(account);
    const again = await store.insertOnce({ ...account, cap: a('300') }, move(ACCOUNT, '300'));
    expect(again.cap).toBe(a('200'));
    expect((await store.moves(USER, ACCOUNT)).map((m) => m.amount)).toEqual([a('150')]);
    const opened = await store.update(USER, ACCOUNT, { subAccount: '0xsub', status: 'open', openedAt: new Date() });
    expect((await store.find(USER, ACCOUNT))?.status).toBe(opened.status);
  });

  it('two moves reserved at once are judged one after the other under the row lock: the second sees the first', async () => {
    const store = new SqlAgentAccountStore(db!.sql);
    const room = (moves: readonly AgentMoveRecord[], amount: string) => {
      const { movedIn, movedOut } = netFunding(moves);
      if (compare(movedIn - movedOut + a(amount), a('200')) > 0) throw new Error('past the cap');
    };
    const results = await Promise.allSettled([
      store.reserveMove(move('5a5a5a5a-0000-4000-8000-0000000001d1', '40'), (_acc, moves) => room(moves, '40')),
      store.reserveMove(move('5a5a5a5a-0000-4000-8000-0000000002d1', '40'), (_acc, moves) => room(moves, '40')),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    // The same move id again is the stored move, not a second one.
    const replay = await store.reserveMove(move('5a5a5a5a-0000-4000-8000-0000000001d1', '40'), () => {
      throw new Error('a stored move is never judged again');
    });
    expect(replay.created).toBe(false);
  });

  it('a move settles once; the table refuses a changed move and a delete', async () => {
    const store = new SqlAgentAccountStore(db!.sql);
    await store.settleMove(USER, ACCOUNT, 'done');
    await store.settleMove(USER, ACCOUNT, 'refused');
    expect((await store.moves(USER, ACCOUNT)).find((m) => m.moveId === ACCOUNT)?.state).toBe('done');
    await expect(db!.sql`UPDATE trade.user_venue_agent_moves SET amount = '1' WHERE move_id = ${ACCOUNT}`).rejects.toThrow(
      /only a pending/,
    );
    await expect(db!.sql`UPDATE trade.user_venue_agent_moves SET state = 'pending' WHERE move_id = ${ACCOUNT}`).rejects.toThrow(
      /only a pending/,
    );
    await expect(db!.sql`DELETE FROM trade.user_venue_agent_moves WHERE move_id = ${ACCOUNT}`).rejects.toThrow(/never deleted/);
    await expect(
      db!.sql`INSERT INTO trade.user_venue_agent_moves (user_id, account_id, move_id, direction, amount, state, created_at)
              VALUES (${USER}, ${ACCOUNT}, '5a5a5a5a-0000-4000-8000-0000000003d1', 'into_sub_account', '0', 'pending', now())`,
    ).rejects.toThrow(/amount_ck/);
  });
});
