import { beforeEach, describe, expect, it } from 'vitest';
import { houseFees, railBoundary, userAvailable, withdrawalHoldAccount } from '../accounts.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { InvalidEntryError } from '../types.js';
import { recipes, type WithdrawInput } from './index.js';

/**
 * The quoted network fee of a crypto withdrawal (J-wallet-05 #6, issue #6517). A person with 300 USDT sends 25 out on
 * `crypto-native` with a 1.5 fee on top: what leaves the balance is the quote's total debit, 26.5. Amounts are worked
 * examples, not recomputed inside the assertion.
 */

const USER = '44444444-4444-4444-8444-444444444444';
const RAIL = 'crypto-native';

let ledger: MemoryLedger;

beforeEach(async () => {
  ledger = new MemoryLedger();
  await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('300'), rail: RAIL, railRef: 'in-1' }));
});

const bal = async (ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await ledger.balance(ref)).amount);
const withFee = (withdrawalId: string, over: Partial<WithdrawInput> = {}): WithdrawInput => ({
  userId: USER,
  assetId: 'USDT',
  amount: amt('25'),
  fee: amt('1.5'),
  rail: RAIL,
  withdrawalId,
  ...over,
});

describe('a withdrawal with its quoted fee', () => {
  it('holds the amount and the fee, then sends the amount to the rail and the fee to houseFees(pay) in one posting', async () => {
    const w = withFee('w-1:0');
    const hold = await ledger.post(recipes.withdrawHold(w));
    expect(hold.meta).toMatchObject({ fee: '1.5', withdrawalId: 'w-1:0' });
    expect(await bal(userAvailable(USER, 'USDT'))).toBe('273.5');
    expect(await bal(withdrawalHoldAccount(USER, 'USDT', 'w-1:0'))).toBe('26.5');

    const settle = await ledger.post(recipes.withdrawSettle(w));
    expect(settle.entries).toHaveLength(3);
    expect(await bal(withdrawalHoldAccount(USER, 'USDT', 'w-1:0'))).toBe('0');
    expect(await bal(houseFees('pay', 'USDT'))).toBe('1.5');
    // In 300, out 25 to the network: the boundary carries what is still inside.
    expect(await bal(railBoundary(RAIL, 'USDT'))).toBe('-275');
    expect(await bal(userAvailable(USER, 'USDT'))).toBe('273.5');
    expect(ledger.totalsByAsset().USDT).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a refused send gives the fee back with the amount, and charges nothing', async () => {
    const w = withFee('w-2:0');
    await ledger.post(recipes.withdrawHold(w));
    await ledger.post(recipes.withdrawReverse(w));
    expect(await bal(userAvailable(USER, 'USDT'))).toBe('300');
    expect(await bal(withdrawalHoldAccount(USER, 'USDT', 'w-2:0'))).toBe('0');
    expect(await bal(houseFees('pay', 'USDT'))).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a retry of each step posts it once', async () => {
    const w = withFee('w-3:0');
    for (const step of [recipes.withdrawHold, recipes.withdrawSettle]) {
      const first = await ledger.post(step(w));
      expect((await ledger.post(step(w))).id).toBe(first.id);
    }
    expect(await bal(houseFees('pay', 'USDT'))).toBe('1.5');
    expect(await bal(userAvailable(USER, 'USDT'))).toBe('273.5');
  });

  it('without a fee each step is exactly the fee-less recipe it was before', () => {
    const plain = { userId: USER, assetId: 'USDT', amount: amt('25'), rail: RAIL, withdrawalId: 'w-4:0' };
    for (const step of [recipes.withdrawHold, recipes.withdrawSettle, recipes.withdrawReverse]) {
      const post = step(plain);
      expect(post.entries).toHaveLength(2);
      expect(post.meta).toEqual({ rail: RAIL, withdrawalId: 'w-4:0' });
    }
  });

  it('a zero fee is no leg, and a negative fee is refused', () => {
    for (const step of [recipes.withdrawHold, recipes.withdrawSettle, recipes.withdrawReverse]) {
      const post = step(withFee('w-5:0', { fee: amt('0') }));
      expect(post.entries).toHaveLength(2);
      expect(post.meta).not.toHaveProperty('fee');
      expect(() => step(withFee('w-5:0', { fee: -amt('1') }))).toThrow(InvalidEntryError);
    }
  });

  it('a return carries no fee: only what went to the rail comes back', () => {
    expect(() => recipes.withdrawReturned(withFee('w-7:0'))).toThrow(InvalidEntryError);
  });

  it('a fee the balance cannot cover with the amount holds nothing', async () => {
    await expect(ledger.post(recipes.withdrawHold(withFee('w-6:0', { amount: amt('299'), fee: amt('1.5') })))).rejects.toThrow();
    expect(await bal(userAvailable(USER, 'USDT'))).toBe('300');
    expect(await bal(withdrawalHoldAccount(USER, 'USDT', 'w-6:0'))).toBe('0');
  });
});
