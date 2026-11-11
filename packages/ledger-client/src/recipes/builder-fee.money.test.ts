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
const ACCOUNT = '0x00000000000000000000000000000000000000a1';
const OTHER_ACCOUNT = '0x00000000000000000000000000000000000000a2';

let ledger: MemoryLedger;
beforeEach(() => {
  // A real svc-ledger is always in `refuse` mode (OWNER 288 change 1a): a reused key with another body is refused.
  ledger = new MemoryLedger({ idempotencyConflict: 'refuse' });
});
const bal = async (ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await ledger.balance(ref)).amount);
const earn = (fillId: string, amount: string, over: Partial<Parameters<typeof recipes.builderFeeEarn>[0]> = {}) =>
  recipes.builderFeeEarn({ venueId: VENUE, venueAccount: ACCOUNT, fillId, assetId: 'USDC', amount: amt(amount), userId: USER, ...over });

describe('builderFeeEarn and builderFeeReceive', () => {
  it('posts the fee once per venue fill: revenue up, what the venue owes us down by the same amount', async () => {
    await ledger.post(earn('f1', '0.25'));
    await ledger.post(earn('f2', '0.5'));
    const again = await ledger.post(earn('f1', '0.25'));
    expect(again.idempotencyKey).toBe(earnedBuilderFeeKey(VENUE, ACCOUNT, 'f1'));
    expect(again.idempotencyKey).toBe(`builder-fee:${VENUE}:${ACCOUNT}:f1`);
    expect(await bal(houseFees('builder', 'USDC'))).toBe('0.75');
    expect(await bal(venueBuilderFeeReceivable(VENUE, 'USDC'))).toBe('-0.75');
  });

  it('acceptance 1: the two sides of one trade, two of our accounts under one fill id with different fees, are two entries', async () => {
    await ledger.post(earn('t7', '0.25'));
    await ledger.post(earn('t7', '0.4', { venueAccount: OTHER_ACCOUNT }));
    expect(await bal(houseFees('builder', 'USDC'))).toBe('0.65');
    expect(await bal(venueBuilderFeeReceivable(VENUE, 'USDC'))).toBe('-0.65');
  });

  it('acceptance 2: the same with equal fees is still two entries, never one', async () => {
    const a = await ledger.post(earn('t8', '0.25'));
    const b = await ledger.post(earn('t8', '0.25', { venueAccount: OTHER_ACCOUNT }));
    expect(a.id).not.toBe(b.id);
    expect(await bal(houseFees('builder', 'USDC'))).toBe('0.5');
  });

  it('acceptance 5: the same fill delivered three times is one entry', async () => {
    for (let i = 0; i < 3; i += 1) await ledger.post(earn('t9', '0.25'));
    expect(await bal(houseFees('builder', 'USDC'))).toBe('0.25');
  });

  it('a fill whose key exists with another amount is refused (ledger.idempotency_conflict), never booked twice', async () => {
    await ledger.post(earn('t6', '0.25'));
    await expect(ledger.post(earn('t6', '0.3'))).rejects.toMatchObject({ code: 'ledger.idempotency_conflict' });
    expect(await bal(houseFees('builder', 'USDC'))).toBe('0.25');
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
    expect(() => earn('f0', '0.1', { venueAccount: '' })).toThrow(InvalidEntryError);
    expect(() => earn('f0', '0.1', { venueAccount: 'a:b' })).toThrow(InvalidEntryError);
    expect(() => recipes.builderFeeReceive({ venueId: VENUE, claimId: 'p1', assetId: 'USDC', amount: amt('0') })).toThrow(
      InvalidEntryError,
    );
  });
});
