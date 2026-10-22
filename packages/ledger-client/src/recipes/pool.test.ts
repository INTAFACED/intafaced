import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { poolAvailable, poolRedeemPayable, poolTradingAccount, userAvailable } from '../accounts.js';
import type { AccountRef } from '../types.js';
import { InvalidEntryError } from '../types.js';
import { recipes } from './index.js';
import { RECIPE_MATRIX } from './live-path-inventory.js';

/** LG-pool-recipes-01 acceptance: pool money moves only between the investor, the pool and its trading account. */
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MASTER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const POOL = 'pool-1';
const A = 'USDT';

let ledger: MemoryLedger;
beforeEach(() => {
  ledger = new MemoryLedger();
});

async function seed(account: AccountRef, amount: string): Promise<void> {
  await ledger.post({
    idempotencyKey: `seed:${crypto.randomUUID()}`,
    module: 'test',
    reason: 'test.seed',
    entries: [
      { account: { ownerType: 'treasury', ownerId: 'external', assetId: A, kind: 'available' }, direction: 'credit', amount: amt(amount) },
      { account, direction: 'debit', amount: amt(amount) },
    ],
  });
}
const bal = async (a: AccountRef) => formatAmount((await ledger.balance(a)).amount);

describe('pool recipes', () => {
  it('poolSubscribe balances: user -amount, pool +amount; replay posts nothing', async () => {
    await seed(userAvailable(USER, A), '100');
    const post = recipes.poolSubscribe({ poolId: POOL, userId: USER, assetId: A, amount: amt('40'), subscriptionId: 's1' });
    expect(post.idempotencyKey).toBe('pool.sub:pool-1:s1');
    await ledger.post(post);
    await ledger.post(post);
    expect(await bal(userAvailable(USER, A))).toBe('60');
    expect(await bal(poolAvailable(POOL, A))).toBe('40');
  });

  it('poolRedeem req then pay; replay of either leg posts nothing', async () => {
    await seed(poolAvailable(POOL, A), '50');
    const base = { poolId: POOL, userId: USER, assetId: A, amount: amt('30'), redemptionId: 'r1' };
    const req = recipes.poolRedeem({ ...base, leg: 'request' });
    const pay = recipes.poolRedeem({ ...base, leg: 'pay' });
    expect(req.idempotencyKey).toBe('pool.red:pool-1:r1:req');
    expect(pay.idempotencyKey).toBe('pool.red:pool-1:r1:pay');
    await ledger.post(req);
    await ledger.post(req);
    expect(await bal(poolAvailable(POOL, A))).toBe('20');
    expect(await bal(poolRedeemPayable(POOL, A, 'r1'))).toBe('30');
    await ledger.post(pay);
    await ledger.post(pay);
    expect(await bal(poolRedeemPayable(POOL, A, 'r1'))).toBe('0');
    expect(await bal(userAvailable(USER, A))).toBe('30');
  });

  it('poolRedeem pay cannot draw on another redemption or exceed its own request', async () => {
    await seed(poolAvailable(POOL, A), '50');
    await ledger.post(
      recipes.poolRedeem({ poolId: POOL, userId: USER, assetId: A, amount: amt('30'), redemptionId: 'r1', leg: 'request' }),
    );
    await expect(
      ledger.post(recipes.poolRedeem({ poolId: POOL, userId: USER, assetId: A, amount: amt('10'), redemptionId: 'r2', leg: 'pay' })),
    ).rejects.toThrow();
    await expect(
      ledger.post(recipes.poolRedeem({ poolId: POOL, userId: USER, assetId: A, amount: amt('31'), redemptionId: 'r1', leg: 'pay' })),
    ).rejects.toThrow();
    expect(await bal(poolRedeemPayable(POOL, A, 'r1'))).toBe('30');
    expect(await bal(userAvailable(USER, A))).toBe('0');
  });

  it('poolProfit gain/loss moves only pool and its trading account; no fee/revenue leg', async () => {
    await seed(poolTradingAccount(POOL, A), '15');
    const gain = recipes.poolProfit({ poolId: POOL, assetId: A, amount: amt('15'), direction: 'gain', periodId: 'q1' });
    const loss = recipes.poolProfit({ poolId: POOL, assetId: A, amount: amt('5'), direction: 'loss', periodId: 'q2' });
    expect(gain.idempotencyKey).toBe('pool.pnl:pool-1:q1:USDT');
    for (const p of [gain, loss]) {
      const owners = p.entries.map((e) => `${e.account.ownerType}:${e.account.ownerId}`).sort();
      expect(owners).toEqual(['module:trade:pool-trading:pool-1', 'module:trade:pool:pool-1']);
    }
    await ledger.post(gain);
    await ledger.post(gain);
    expect(await bal(poolAvailable(POOL, A))).toBe('15');
    expect(await bal(poolTradingAccount(POOL, A))).toBe('0');
    await ledger.post(loss);
    expect(await bal(poolAvailable(POOL, A))).toBe('10');
    expect(await bal(poolTradingAccount(POOL, A))).toBe('5');
  });

  it('poolProfit gain the trading account does not hold is refused, not minted', async () => {
    await expect(
      ledger.post(recipes.poolProfit({ poolId: POOL, assetId: A, amount: amt('1'), direction: 'gain', periodId: 'q1' })),
    ).rejects.toThrow();
    expect(await bal(poolAvailable(POOL, A))).toBe('0');
  });

  it('poolRaise master -> pool; key pool.raise:<poolId>:<raiseId>', async () => {
    await seed(userAvailable(MASTER, A), '25');
    const post = recipes.poolRaise({ poolId: POOL, masterUserId: MASTER, assetId: A, amount: amt('25'), raiseId: 'z1' });
    expect(post.idempotencyKey).toBe('pool.raise:pool-1:z1');
    await ledger.post(post);
    expect(await bal(userAvailable(MASTER, A))).toBe('0');
    expect(await bal(poolAvailable(POOL, A))).toBe('25');
  });

  it('non-positive amount -> InvalidEntryError', () => {
    for (const amount of [amt('0'), -1n]) {
      expect(() => recipes.poolSubscribe({ poolId: POOL, userId: USER, assetId: A, amount, subscriptionId: 's' })).toThrow(
        InvalidEntryError,
      );
      expect(() => recipes.poolRedeem({ poolId: POOL, userId: USER, assetId: A, amount, redemptionId: 'r', leg: 'request' })).toThrow(
        InvalidEntryError,
      );
      expect(() => recipes.poolProfit({ poolId: POOL, assetId: A, amount, direction: 'gain', periodId: 'q' })).toThrow(InvalidEntryError);
      expect(() => recipes.poolRaise({ poolId: POOL, masterUserId: MASTER, assetId: A, amount, raiseId: 'z' })).toThrow(InvalidEntryError);
    }
  });

  it('refuses ids that could forge another key or account, and unknown legs or directions', () => {
    expect(() => recipes.poolSubscribe({ poolId: 'a:b', userId: USER, assetId: A, amount: amt('1'), subscriptionId: 's' })).toThrow(
      InvalidEntryError,
    );
    expect(() => recipes.poolSubscribe({ poolId: POOL, userId: USER, assetId: A, amount: amt('1'), subscriptionId: 's:x' })).toThrow(
      InvalidEntryError,
    );
    expect(() => recipes.poolSubscribe({ poolId: '', userId: USER, assetId: A, amount: amt('1'), subscriptionId: 's' })).toThrow(
      InvalidEntryError,
    );
    expect(() =>
      recipes.poolRedeem({ poolId: POOL, userId: USER, assetId: A, amount: amt('1'), redemptionId: 'r', leg: 'both' as never }),
    ).toThrow(InvalidEntryError);
    expect(() => recipes.poolProfit({ poolId: POOL, assetId: A, amount: amt('1'), direction: 'fee' as never, periodId: 'q' })).toThrow(
      InvalidEntryError,
    );
    expect(() => poolAvailable('a:b', A)).toThrow();
  });

  it('registry: every pool recipe in recipes and RECIPE_MATRIX (as a §13 socket, no caller yet)', async () => {
    const { readFileSync } = await import('node:fs');
    const md = readFileSync(new URL('../../RECIPES.md', import.meta.url), 'utf8');
    for (const name of ['poolSubscribe', 'poolRedeem', 'poolProfit', 'poolRaise'] as const) {
      expect(typeof recipes[name]).toBe('function');
      expect(RECIPE_MATRIX[name].kind).toBe('socket');
      expect(md).toMatch(new RegExp(`^\\| \`${name}\`\\s*\\| \`trade\``, 'm'));
    }
  });
});
