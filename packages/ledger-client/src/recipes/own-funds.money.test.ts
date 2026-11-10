import { beforeEach, describe, expect, it } from 'vitest';
import {
  balanceAllowed,
  houseFees,
  isOwnFundsPlace,
  partnerReserve,
  treasuryWallet,
  userAvailable,
  venueBuilderAccount,
  venueBuilderFeeReceivable,
  venueBoundary,
} from '../accounts.js';
import { isCustomerBalanceAccount } from '../custody-layer.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { InsufficientFundsError, InvalidEntryError } from '../types.js';
import { recipes } from './index.js';
import { ownFundsMoveKey, type OwnFundsPlace } from './own-funds.js';

/**
 * Our own funds at outside places (launch money model, rule 5): builder fees collected into our builder account at the
 * venue, swept to our treasury wallet, and a reserve funded at a partner. TEST amounts only.
 */
const VENUE = 'test-venue';
const USER = '11111111-1111-4111-8111-1111111111f0';
const BUILDER: OwnFundsPlace = { kind: 'venue-builder-account', venueId: VENUE };
const WALLET: OwnFundsPlace = { kind: 'treasury-wallet', walletId: 'base:ops' };
const RESERVE: OwnFundsPlace = { kind: 'partner-reserve', partnerId: 'card-partner' };

let ledger: MemoryLedger;
beforeEach(() => {
  ledger = new MemoryLedger();
});
const bal = async (ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await ledger.balance(ref)).amount);
const move = (from: OwnFundsPlace, to: OwnFundsPlace, amount: string, reference: string) =>
  recipes.ownFundsMove({ from, to, assetId: 'USDC', amount: amt(amount), reference });

async function collect(amount: string, claimId: string) {
  await ledger.post(recipes.builderFeeEarn({ venueId: VENUE, fillId: `f-${claimId}`, assetId: 'USDC', amount: amt(amount), userId: USER }));
  await ledger.post(recipes.builderFeeReceive({ venueId: VENUE, claimId, assetId: 'USDC', amount: amt(amount) }));
}

describe('ownFundsMove', () => {
  it('moves our money from the builder account to the treasury wallet, and on to a partner reserve, once per outside record', async () => {
    await collect('10', 'c1');
    const sweep = move(BUILDER, WALLET, '7', '0xsweep1');
    await ledger.post(sweep);
    await ledger.post(sweep);
    await ledger.post(move(WALLET, RESERVE, '3', 'stmt-2026-11-10-001'));
    expect(sweep.idempotencyKey).toBe(ownFundsMoveKey(BUILDER, 'USDC', '0xsweep1'));
    expect(sweep.idempotencyKey).toBe(`own-funds-move:venue-builder-account:${VENUE}:0xsweep1`);
    expect(await bal(venueBuilderAccount(VENUE, 'USDC'))).toBe('-3');
    expect(await bal(treasuryWallet('base:ops', 'USDC'))).toBe('-4');
    expect(await bal(partnerReserve('card-partner', 'USDC'))).toBe('-3');
  });

  it('invariant: what we hold across every place equals what we collected, and revenue does not move', async () => {
    await collect('4', 'c1');
    await collect('6', 'c2');
    await ledger.post(move(BUILDER, WALLET, '9', '0xa'));
    await ledger.post(move(WALLET, RESERVE, '2', 'stmt-1'));
    await ledger.post(move(RESERVE, WALLET, '1', 'stmt-2'));
    const held =
      -(await ledger.balance(venueBuilderAccount(VENUE, 'USDC'))).amount -
      (await ledger.balance(treasuryWallet('base:ops', 'USDC'))).amount -
      (await ledger.balance(partnerReserve('card-partner', 'USDC'))).amount;
    expect(formatAmount(held)).toBe('10');
    expect(await bal(houseFees('builder', 'USDC'))).toBe('10');
    expect(await bal(venueBuilderFeeReceivable(VENUE, 'USDC'))).toBe('0');
  });

  it('refuses to move more than the book shows at the source, and leaves the book as it was', async () => {
    await collect('5', 'c1');
    const before = ledger.journal().length;
    await expect(ledger.post(move(BUILDER, WALLET, '5.000001', '0xover'))).rejects.toThrow(InsufficientFundsError);
    await expect(ledger.post(move(RESERVE, WALLET, '1', 'stmt-empty'))).rejects.toThrow(InsufficientFundsError);
    expect(ledger.journal()).toHaveLength(before);
    expect(await bal(venueBuilderAccount(VENUE, 'USDC'))).toBe('-5');
    expect(await ledger.getTxByKey(ownFundsMoveKey(BUILDER, 'USDC', '0xover'))).toBeNull();
  });

  it('names what the place holds when it refuses', async () => {
    await collect('2', 'c1');
    const err = await ledger.post(move(BUILDER, WALLET, '3', '0xover')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientFundsError);
    expect((err as InsufficientFundsError).availableBalance).toBe('2');
    expect((err as InsufficientFundsError).requested).toBe('3');
  });

  it('refuses a zero amount, the same place twice, a reference with spaces, a padded asset and a bad place id', () => {
    expect(() => move(BUILDER, WALLET, '0', '0xa')).toThrow(InvalidEntryError);
    expect(() => move(WALLET, WALLET, '1', '0xa')).toThrow(InvalidEntryError);
    expect(() => move(BUILDER, WALLET, '1', '0x a')).toThrow(InvalidEntryError);
    expect(() => move(BUILDER, WALLET, '1', '')).toThrow(InvalidEntryError);
    expect(() => recipes.ownFundsMove({ from: BUILDER, to: WALLET, assetId: ' USDC', amount: amt('1'), reference: '0xa' })).toThrow(
      InvalidEntryError,
    );
    expect(() => move({ kind: 'partner-reserve', partnerId: 'Card Partner' }, WALLET, '1', '0xa')).toThrow(InvalidEntryError);
  });

  it('touches only own-funds places: never a customer account, never the custodial venue boundary', () => {
    for (const e of move(BUILDER, RESERVE, '1', '0xa').entries) {
      expect(isOwnFundsPlace(e.account)).toBe(true);
      expect(isCustomerBalanceAccount(e.account)).toBe(false);
    }
    expect(isOwnFundsPlace(venueBoundary(VENUE, 'USDC'))).toBe(false);
    expect(isOwnFundsPlace(venueBuilderFeeReceivable(VENUE, 'USDC'))).toBe(false);
    expect(isOwnFundsPlace(userAvailable(USER, 'USDC'))).toBe(false);
  });
});

describe('balanceAllowed', () => {
  it('keeps every other account as it was: non-treasury never below zero, treasury boundaries free', () => {
    expect(balanceAllowed(userAvailable(USER, 'USDC'), -1n)).toBe(false);
    expect(balanceAllowed(userAvailable(USER, 'USDC'), 0n)).toBe(true);
    expect(balanceAllowed(houseFees('builder', 'USDC'), -1n)).toBe(false);
    expect(balanceAllowed(venueBoundary(VENUE, 'USDC'), -1n)).toBe(true);
    expect(balanceAllowed(venueBoundary(VENUE, 'USDC'), 1n)).toBe(true);
    expect(balanceAllowed(venueBuilderFeeReceivable(VENUE, 'USDC'), 1n)).toBe(true);
  });

  it('lets an own-funds place hold our money (below zero) and never go above zero', () => {
    for (const place of [venueBuilderAccount(VENUE, 'USDC'), partnerReserve('p', 'USDC'), treasuryWallet('w', 'USDC')]) {
      expect(balanceAllowed(place, -1n)).toBe(true);
      expect(balanceAllowed(place, 0n)).toBe(true);
      expect(balanceAllowed(place, 1n)).toBe(false);
    }
  });
});
