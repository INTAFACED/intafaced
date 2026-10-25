import { beforeEach, describe, expect, it } from 'vitest';
import { railBoundary, userAvailable, withdrawalHoldAccount } from '../accounts.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { IDEMPOTENCY_CONFLICT_CODE } from '../client.js';
import { InvalidEntryError } from '../types.js';
import { recipes, type WithdrawInput } from './index.js';

/**
 * W-withdraw-07 returned withdrawal. A person sends 40 of their 100 USDT out on `crypto-native`; the rail settles it, then
 * hands some or all of it back. Amounts are worked examples, not recomputed inside the assertion.
 */

const USER = '33333333-3333-4333-8333-333333333333';
const RAIL = 'crypto-native';

let ledger: MemoryLedger;

beforeEach(() => {
  ledger = new MemoryLedger();
});

const bal = async (ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await ledger.balance(ref)).amount);

function withdrawal(withdrawalId: string, over: Partial<WithdrawInput> = {}): WithdrawInput {
  return { userId: USER, assetId: 'USDT', amount: amt('40'), rail: RAIL, withdrawalId, ...over };
}

async function settled(w: WithdrawInput) {
  await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('100'), rail: RAIL, railRef: `in-${w.withdrawalId}` }));
  await ledger.post(recipes.withdrawHold(w));
  await ledger.post(recipes.withdrawSettle(w));
}

describe('withdrawReturned', () => {
  it('puts the whole amount back in available once, from the rail boundary it left to, and the books close', async () => {
    const w = withdrawal('w-1:0');
    await settled(w);
    expect(await bal(userAvailable(USER, 'USDT'))).toBe('60');

    const first = await ledger.post(recipes.withdrawReturned(w));
    const again = await ledger.post(recipes.withdrawReturned(w));

    expect(again.id).toBe(first.id);
    expect(first.idempotencyKey).toBe('withdraw.returned:w-1:0');
    expect(first.reason).toBe('withdraw.returned');
    expect(await bal(userAvailable(USER, 'USDT'))).toBe('100');
    expect(await bal(withdrawalHoldAccount(USER, 'USDT', 'w-1:0'))).toBe('0');
    // In 100, out 40, back 40: the boundary nets to what is still with the person.
    expect(await bal(railBoundary(RAIL, 'USDT'))).toBe('-100');
    expect(ledger.totalsByAsset().USDT).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a part of it back is that part, and only one return per attempt', async () => {
    const w = withdrawal('w-2:0');
    await settled(w);

    await ledger.post(recipes.withdrawReturned({ ...w, amount: amt('12.5') }));
    // The same attempt returned again with another amount is the same key with another body: refused, the first stands.
    await expect(ledger.post(recipes.withdrawReturned({ ...w, amount: amt('40') }))).rejects.toMatchObject({
      code: IDEMPOTENCY_CONFLICT_CODE,
    });

    expect(await bal(userAvailable(USER, 'USDT'))).toBe('72.5');
  });

  it('refuses a non-positive amount and a missing or padded withdrawal id, posting nothing', async () => {
    const w = withdrawal('w-3:0');
    await settled(w);
    for (const bad of [
      { ...w, amount: 0n },
      { ...w, amount: -1n },
      { ...w, withdrawalId: '' },
      { ...w, withdrawalId: ' w-3:0' },
    ]) {
      expect(() => recipes.withdrawReturned(bad)).toThrow(InvalidEntryError);
    }
    expect(await bal(userAvailable(USER, 'USDT'))).toBe('60');
  });
});
