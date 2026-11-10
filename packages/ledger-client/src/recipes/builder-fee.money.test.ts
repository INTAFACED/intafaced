import { beforeEach, describe, expect, it } from 'vitest';
import { houseFees, venueBuilderAccount, venueBuilderFeeReceivable } from '../accounts.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { InvalidEntryError } from '../types.js';
import { earnedBuilderFeeKey, recipes } from './index.js';

/**
 * D-venue-07: our builder fee on routed venue fills, earned and paid out. Worked example, not recomputed in the
 * assertions: on TEST venue `test-venue-sim`, fills f1 and f2 of our user carry builder fees of 0.25 and 0.5 USDC
 * (0.75 earned); the venue pays out 0.5 (payout p1), so it still owes 0.25.
 */
const USER = '11111111-1111-4111-8111-111111111111';
const VENUE = 'test-venue-sim';

let ledger: MemoryLedger;
beforeEach(() => {
  ledger = new MemoryLedger();
});
const bal = async (ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await ledger.balance(ref)).amount);
const earn = (fillId: string, amount: string, over: Partial<Parameters<typeof recipes.builderFeeEarn>[0]> = {}) =>
  recipes.builderFeeEarn({ venueId: VENUE, fillId, assetId: 'USDC', amount: amt(amount), userId: USER, ...over });

describe('builderFeeEarn and builderFeeReceive', () => {
  it('posts the fee once per venue fill: revenue up, what the venue owes us down by the same amount', async () => {
    await ledger.post(earn('f1', '0.25'));
    await ledger.post(earn('f2', '0.5'));
    const again = await ledger.post(earn('f1', '0.25'));
    expect(again.idempotencyKey).toBe(earnedBuilderFeeKey(VENUE, 'f1'));
    expect(await bal(houseFees('builder', 'USDC'))).toBe('0.75');
    expect(await bal(venueBuilderFeeReceivable(VENUE, 'USDC'))).toBe('-0.75');
  });

  it('a payout clears the receivable by its amount once, into our builder account at the venue', async () => {
    await ledger.post(earn('f1', '0.25'));
    await ledger.post(earn('f2', '0.5'));
    const pay = recipes.builderFeeReceive({ venueId: VENUE, claimId: 'p1', assetId: 'USDC', amount: amt('0.5') });
    await ledger.post(pay);
    await ledger.post(pay);
    expect(await bal(venueBuilderFeeReceivable(VENUE, 'USDC'))).toBe('-0.25');
    expect(await bal(venueBuilderAccount(VENUE, 'USDC'))).toBe('-0.5');
    // Revenue is what was earned, whatever has been paid out.
    expect(await bal(houseFees('builder', 'USDC'))).toBe('0.75');
  });

  it('invariant: revenue equals the fees earned, and no entry touches a customer account', async () => {
    const fees = ['0.1', '0.2', '0.3', '0.4'];
    for (const [i, f] of fees.entries()) await ledger.post(earn(`f${i}`, f));
    expect(await bal(houseFees('builder', 'USDC'))).toBe('1');
    for (const [i] of fees.entries()) {
      for (const e of earn(`f${i}`, '0.1').entries) expect(['house', 'treasury']).toContain(e.account.ownerType);
    }
    for (const e of recipes.builderFeeReceive({ venueId: VENUE, claimId: 'p', assetId: 'USDC', amount: amt('1') }).entries) {
      expect(e.account.ownerType).toBe('treasury');
    }
  });

  it('a zero fee, a bad venue id or fill id, and a padded asset are refused before anything posts', () => {
    expect(() => earn('f0', '0')).toThrow(InvalidEntryError);
    expect(() => earn('f0', '0.1', { venueId: 'Test Venue' })).toThrow(InvalidEntryError);
    expect(() => earn('f:0', '0.1')).toThrow(InvalidEntryError);
    expect(() => earn('f 0', '0.1')).toThrow(InvalidEntryError);
    expect(() => earn('f0', '0.1', { assetId: ' USDC' })).toThrow(InvalidEntryError);
    expect(() => earn('f0', '0.1', { userId: '' })).toThrow(InvalidEntryError);
    expect(() => recipes.builderFeeReceive({ venueId: VENUE, claimId: 'p1', assetId: 'USDC', amount: amt('0') })).toThrow(
      InvalidEntryError,
    );
  });
});
