import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { MemoryEventBus } from '@intafaced/events';
import {
  MemoryLedger,
  formatAmount,
  parseAmount as amt,
  recipes,
  tokenStakeAccount,
  userAvailable,
  type Amount,
  type PostRequest,
} from '@intafaced/ledger-client';
import { DEFAULT_BUYBACK_PARAMS } from './economics/buyback.js';
import { DEFAULT_EMISSION_PARAMS } from './economics/emission.js';
import { TokenService } from './token-service.js';

/**
 * L1283. Unstake must refuse when the stake pot and the table amount disagree.
 *
 * unstakeInner posted recipes.unstake for the table amount and then closed the
 * row. A larger pot left a residual in tokenStakeAccount after close, and the
 * next unstake was token.stake_closed. The pot has to equal the table amount
 * before the row becomes unstaking. A mismatch posts nothing and leaves the
 * row active. No partial unstake and no invented residual sweep.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const STAKE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TABLE = '1000';
const LARGER = '1500';
const SMALLER = '400';

type StakeRow = {
  id: string;
  user_id: string;
  amount: string;
  tier: 'flex';
  started_at: Date;
  unlocks_at: Date | null;
  status: string;
};

function unstakeSql(row: StakeRow): { sql: Sql; statusWrites: string[] } {
  const statusWrites: string[] = [];

  const query = (strings: TemplateStringsArray) => {
    const q = strings.join(' ');
    if (q.includes("SET status = 'unstaking'")) {
      statusWrites.push('unstaking');
      if (row.status === 'active') row.status = 'unstaking';
      return Promise.resolve([]);
    }
    if (q.includes("SET status = 'closed'")) {
      statusWrites.push('closed');
      if (row.status !== 'unstaking') return Promise.resolve([]);
      row.status = 'closed';
      return Promise.resolve([{ ...row }]);
    }
    if (q.includes('FROM token.stakes') && q.includes('FOR UPDATE')) {
      return Promise.resolve([{ ...row }]);
    }
    return Promise.reject(new Error(`unexpected query: ${q}`));
  };

  const fn = (strings: TemplateStringsArray, ..._values: unknown[]) => query(strings);
  const begin = async (_isolation: string, cb: (tx: typeof fn) => Promise<unknown>) => cb(fn);
  return { sql: Object.assign(fn, { begin, json: (v: unknown) => v }) as unknown as Sql, statusWrites };
}

async function fundStake(ledger: MemoryLedger, amount: string): Promise<void> {
  await ledger.post(
    recipes.deposit({
      userId: USER,
      assetId: 'IFC',
      amount: amt(amount),
      rail: 'test',
      railRef: `${STAKE_ID}:deposit:${amount}`,
    }),
  );
  await ledger.post(
    recipes.stake({
      stakeId: STAKE_ID,
      userId: USER,
      assetId: 'IFC',
      amount: amt(amount),
      tier: 'flex',
    }),
  );
}

function watchUnstake(ledger: MemoryLedger): Amount[] {
  const posted: Amount[] = [];
  const real = ledger.post.bind(ledger);
  ledger.post = async (request: PostRequest) => {
    const result = await real(request);
    if (request.reason === 'token.unstake') {
      const leg = request.entries[0];
      if (leg) posted.push(leg.amount);
    }
    return result;
  };
  return posted;
}

async function scene(tableAmount: string, potAmount: string) {
  const ledger = new MemoryLedger();
  await fundStake(ledger, potAmount);
  const posted = watchUnstake(ledger);
  const row: StakeRow = {
    id: STAKE_ID,
    user_id: USER,
    amount: tableAmount,
    tier: 'flex',
    started_at: new Date('2026-01-01T00:00:00.000Z'),
    unlocks_at: null,
    status: 'active',
  };
  const { sql, statusWrites } = unstakeSql(row);
  const token = new TokenService(sql, ledger, new MemoryEventBus('svc-token'), {
    assetId: 'IFC',
    emission: DEFAULT_EMISSION_PARAMS,
    buyback: DEFAULT_BUYBACK_PARAMS,
    loadParamsFromDb: false,
    feeScheduleTtlMs: 0,
  });
  return { token, ledger, row, posted, statusWrites };
}

async function potOf(ledger: MemoryLedger): Promise<string> {
  return formatAmount((await ledger.balance(tokenStakeAccount(USER, 'IFC', STAKE_ID))).amount);
}

async function availableOf(ledger: MemoryLedger): Promise<string> {
  return formatAmount((await ledger.balance(userAvailable(USER, 'IFC'))).amount);
}

describe('unstake gates on tokenStakeAccount', () => {
  it('refuses a pot larger than the table amount, posts nothing, and leaves the row active', async () => {
    const { token, ledger, row, posted, statusWrites } = await scene(TABLE, LARGER);

    await expect(token.unstake(STAKE_ID)).rejects.toMatchObject({ code: 'token.stake_ledger_mismatch' });
    await expect(token.unstake(STAKE_ID)).rejects.toMatchObject({ code: 'token.stake_ledger_mismatch' });

    expect(posted).toEqual([]);
    expect(statusWrites).toEqual([]);
    expect(row.status).toBe('active');
    expect(await potOf(ledger)).toBe(LARGER);
    expect(await availableOf(ledger)).toBe('0');
  });

  it('refuses a pot smaller than the table amount and leaves the row active', async () => {
    const { token, ledger, row, posted, statusWrites } = await scene(TABLE, SMALLER);

    await expect(token.unstake(STAKE_ID)).rejects.toMatchObject({ code: 'token.stake_ledger_mismatch' });

    expect(posted).toEqual([]);
    expect(statusWrites).toEqual([]);
    expect(row.status).toBe('active');
    expect(await potOf(ledger)).toBe(SMALLER);
    expect(await availableOf(ledger)).toBe('0');
  });

  it('unstakes and closes when the pot equals the table amount', async () => {
    const { token, ledger, row, posted, statusWrites } = await scene(TABLE, TABLE);

    const closed = await token.unstake(STAKE_ID);

    expect(closed.status).toBe('closed');
    expect(formatAmount(closed.amount)).toBe(TABLE);
    expect(posted.map((amount) => formatAmount(amount))).toEqual([TABLE]);
    expect(statusWrites).toEqual(['unstaking', 'closed']);
    expect(row.status).toBe('closed');
    expect(await potOf(ledger)).toBe('0');
    expect(await availableOf(ledger)).toBe(TABLE);
  });
});
