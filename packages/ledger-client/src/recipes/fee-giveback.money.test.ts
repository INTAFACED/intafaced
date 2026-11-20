import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { houseFees, treasuryWallet, venueBuilderAccount } from '../accounts.js';
import { movesCustomerBalance } from '../custody-layer.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { IDEMPOTENCY_CONFLICT_CODE } from '../client.js';
import { InsufficientFundsError, InvalidEntryError, LedgerError } from '../types.js';
import { recipes } from './index.js';
import type { OwnFundsPlace } from './own-funds.js';
import { BUILDER_FEE_POT } from './builder-fee.js';
import {
  FEE_GIVEBACK_APPROVERS_CODE,
  FEE_GIVEBACK_EXCEEDED_CODE,
  FeeGiveBackApproversError,
  FeeGiveBackExceededError,
  feeGiveBackKey,
  feeGiveBackOwedAccount,
  type FeeGiveBackOweInput,
} from './fee-giveback.js';

/**
 * A fee a customer paid on a fill, given back from our own funds to their own wallet (launch money model; OWNER 288:
 * "a fee give-back needs two approvers and is at most the fee that customer paid on that fill"). TEST amounts, TEST
 * approvers and TEST ids only.
 */
const VENUE = 'test-venue';
const ACCOUNT = '0xowner';
const USER = '11111111-1111-4111-8111-1111111111e0';
const OTHER = '11111111-1111-4111-8111-1111111111e1';
const BUILDER: OwnFundsPlace = { kind: 'venue-builder-account', venueId: VENUE };
const WALLET: OwnFundsPlace = { kind: 'treasury-wallet', walletId: 'base:ops' };
const CUSTOMER_WALLET = '0x00000000000000000000000000000000000000e0';
const APPROVERS = ['test-op-a', 'test-op-b'] as const;

let ledger: MemoryLedger;
beforeEach(() => {
  ledger = new MemoryLedger();
});
const bal = async (ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await ledger.balance(ref)).amount);
const revenue = () => houseFees(BUILDER_FEE_POT, 'USDC');

/** A builder fee the customer paid on one fill, collected into our builder account at the venue. */
async function feePaid(fillId: string, amount: string, userId = USER) {
  await ledger.post(
    recipes.builderFeeEarn({ venueId: VENUE, venueAccount: ACCOUNT, fillId, assetId: 'USDC', amount: amt(amount), userId }),
  );
  await ledger.post(recipes.builderFeeReceive({ venueId: VENUE, claimId: `c-${fillId}`, assetId: 'USDC', amount: amt(amount) }));
}

const owe = (over: Partial<FeeGiveBackOweInput> = {}) =>
  recipes.feeGiveBackOwe({
    venueId: VENUE,
    venueAccount: ACCOUNT,
    fillId: 'f1',
    userId: USER,
    assetId: 'USDC',
    feePaid: amt('4'),
    amount: amt('4'),
    approvers: APPROVERS,
    ...over,
  });

const pay = (amount: string, chainTx: string, from: OwnFundsPlace = BUILDER, userId = USER) =>
  recipes.feeGiveBackPayOut({ userId, from, toWallet: CUSTOMER_WALLET, chainTx, assetId: 'USDC', amount: amt(amount) });

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a refusal');
}

describe('feeGiveBackOwe: two different approvers', () => {
  it('refuses with one approver, none, or an empty id', () => {
    for (const approvers of [['test-op-a'], [], undefined, ['test-op-a', ''], ['test-op-a', 'test op b'], ['test-op-a', 'b', 'c']]) {
      const e = caught(() => owe({ approvers: approvers as unknown as FeeGiveBackOweInput['approvers'] }));
      expect(e).toBeInstanceOf(FeeGiveBackApproversError);
      expect((e as LedgerError).code).toBe(FEE_GIVEBACK_APPROVERS_CODE);
      expect((e as FeeGiveBackApproversError).why).toBe('missing');
    }
    expect((caught(() => owe({ approvers: ['test-op-a'] as unknown as FeeGiveBackOweInput['approvers'] })) as Error).message).toBe(
      'A fee give-back needs two approvers, each named by their staff id.',
    );
  });

  it('refuses the same approver twice, in any case', () => {
    for (const approvers of [
      ['test-op-a', 'test-op-a'],
      ['test-op-a', 'TEST-OP-A'],
    ] as const) {
      const e = caught(() => owe({ approvers }));
      expect(e).toBeInstanceOf(FeeGiveBackApproversError);
      expect((e as LedgerError).code).toBe('ledger.fee_giveback_approvers');
      expect((e as FeeGiveBackApproversError).why).toBe('same');
      expect((e as Error).message).toBe('A fee give-back needs two different approvers; the same approver cannot approve it twice.');
    }
  });

  it('records both approvers on the entry', () => {
    expect(owe().meta).toMatchObject({ approvedBy: 'test-op-a', secondApprover: 'test-op-b' });
  });
});

describe('feeGiveBackOwe: at most the fee paid on that fill', () => {
  it('refuses one unit above the fee paid, and allows exactly the fee or less', () => {
    const e = caught(() => owe({ amount: amt('4.000001') }));
    expect(e).toBeInstanceOf(FeeGiveBackExceededError);
    expect((e as LedgerError).code).toBe(FEE_GIVEBACK_EXCEEDED_CODE);
    expect((e as LedgerError).code).toBe('ledger.fee_giveback_exceeded');
    expect((e as Error).message).toBe('Giving back 4.000001 is more than the 4 fee the customer paid on that fill.');
    // One base unit above the fee is refused too.
    expect(caught(() => owe({ amount: amt('4') + 1n }))).toBeInstanceOf(FeeGiveBackExceededError);
    expect(owe({ amount: amt('4') }).entries).toHaveLength(2);
    expect(owe({ amount: amt('0.000001') }).entries).toHaveLength(2);
  });

  it('refuses a zero or missing fee paid, and a zero amount', () => {
    expect(caught(() => owe({ feePaid: 0n }))).toBeInstanceOf(InvalidEntryError);
    expect(caught(() => owe({ feePaid: undefined as unknown as bigint }))).toBeInstanceOf(InvalidEntryError);
    expect(caught(() => owe({ amount: 0n }))).toBeInstanceOf(InvalidEntryError);
    expect(caught(() => owe({ amount: -1n }))).toBeInstanceOf(InvalidEntryError);
  });

  it("is keyed on the fill's earn key, so one fill is given back once; a second amount under it is refused", async () => {
    await feePaid('f1', '4');
    expect(owe().idempotencyKey).toBe(`fee-refund:builder-fee:${VENUE}:${ACCOUNT}:f1`);
    expect(owe().idempotencyKey).toBe(feeGiveBackKey(VENUE, ACCOUNT, 'f1'));
    await ledger.post(owe({ amount: amt('1') }));
    await ledger.post(owe({ amount: amt('1') })); // replay: posts once
    expect(await bal(feeGiveBackOwedAccount(USER, 'USDC'))).toBe('1');
    await expect(ledger.post(owe({ amount: amt('3') }))).rejects.toMatchObject({ code: IDEMPOTENCY_CONFLICT_CODE });
    expect(await bal(feeGiveBackOwedAccount(USER, 'USDC'))).toBe('1');
  });

  it('refuses when our builder-fee revenue holds less, and the book is unchanged', async () => {
    await expect(ledger.post(owe())).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(feeGiveBackOwedAccount(USER, 'USDC'))).toBe('0');
    expect(await bal(revenue())).toBe('0');
  });

  it('refuses a bad fill reference or customer id', () => {
    expect(caught(() => owe({ fillId: 'a b' }))).toBeInstanceOf(InvalidEntryError);
    expect(caught(() => owe({ venueId: 'Bad' }))).toBeInstanceOf(InvalidEntryError);
    expect(caught(() => owe({ userId: 'not-a-uuid' }))).toBeInstanceOf(InvalidEntryError);
  });
});

describe('feeGiveBackPayOut: from our own funds to the customer’s own wallet', () => {
  it('refuses above what we owe the customer, and from a place that holds less; the book is unchanged', async () => {
    await feePaid('f1', '4');
    await ledger.post(owe({ amount: amt('3') }));
    await expect(ledger.post(pay('3.000001', '0xover'))).rejects.toBeInstanceOf(InsufficientFundsError);
    await expect(ledger.post(pay('3', '0xempty', WALLET))).rejects.toBeInstanceOf(InsufficientFundsError);
    await expect(ledger.post(pay('1', '0xother', BUILDER, OTHER))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(feeGiveBackOwedAccount(USER, 'USDC'))).toBe('3');
    expect(await bal(venueBuilderAccount(VENUE, 'USDC'))).toBe('-4');
    await ledger.post(pay('3', '0xpaid'));
    expect(await bal(feeGiveBackOwedAccount(USER, 'USDC'))).toBe('0');
    expect(await bal(venueBuilderAccount(VENUE, 'USDC'))).toBe('-1');
    await expect(ledger.post(pay('0.000001', '0xagain'))).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it('one chain transaction pays once', async () => {
    await feePaid('f1', '4');
    await ledger.post(owe({ amount: amt('3') }));
    await ledger.post(pay('1', '0xtx'));
    await ledger.post(pay('1', '0xtx'));
    expect(await bal(feeGiveBackOwedAccount(USER, 'USDC'))).toBe('2');
    await expect(ledger.post(pay('2', '0xtx'))).rejects.toMatchObject({ code: IDEMPOTENCY_CONFLICT_CODE });
  });

  it("refuses a wallet that is not the customer's address, or a bad chain transaction", () => {
    expect(
      caught(() =>
        recipes.feeGiveBackPayOut({ userId: USER, from: BUILDER, toWallet: '0x1', chainTx: '0xa', assetId: 'USDC', amount: 1n }),
      ),
    ).toBeInstanceOf(InvalidEntryError);
    expect(caught(() => pay('1', 'a:b'))).toBeInstanceOf(InvalidEntryError);
  });
});

describe('the invariant: fees paid = revenue kept + still owed back + paid back, own accounts only', () => {
  it('over fills of two customers, give-backs and payments from two places, every unit is accounted for', async () => {
    await feePaid('f1', '4');
    await feePaid('f2', '6', OTHER);
    await feePaid('f3', '2.5');
    await ledger.post(recipes.ownFundsMove({ from: BUILDER, to: WALLET, assetId: 'USDC', amount: amt('5'), reference: '0xsweep' }));
    await ledger.post(owe({ fillId: 'f1', feePaid: amt('4'), amount: amt('4') }));
    await ledger.post(owe({ fillId: 'f2', userId: OTHER, feePaid: amt('6'), amount: amt('1.5'), approvers: ['test-op-c', 'test-op-a'] }));
    await ledger.post(pay('2.5', '0xp1'));
    await ledger.post(pay('1.5', '0xp2', WALLET, OTHER));

    const paid = amt('12.5');
    const kept = (await ledger.balance(revenue())).amount;
    const owedBack =
      (await ledger.balance(feeGiveBackOwedAccount(USER, 'USDC'))).amount +
      (await ledger.balance(feeGiveBackOwedAccount(OTHER, 'USDC'))).amount;
    const ours = -(
      (await ledger.balance(venueBuilderAccount(VENUE, 'USDC'))).amount + (await ledger.balance(treasuryWallet('base:ops', 'USDC'))).amount
    );
    expect(formatAmount(kept)).toBe('7');
    expect(formatAmount(owedBack)).toBe('1.5');
    expect(formatAmount(ours)).toBe('8.5');
    expect(kept + owedBack).toBe(ours);
    expect(paid - (amt('2.5') + amt('1.5'))).toBe(ours);
  });

  it('no leg is a customer balance, and neither recipe is in the custody-layer inventory', () => {
    expect(movesCustomerBalance(owe().entries)).toBe(false);
    expect(movesCustomerBalance(pay('1', '0xa').entries)).toBe(false);
    const inventory = JSON.parse(readFileSync(new URL('../../../../tooling/ci/custody-layer-inventory.json', import.meta.url), 'utf8')) as {
      customerBalanceRecipes: string[];
    };
    expect(inventory.customerBalanceRecipes).not.toContain('feeGiveBackOwe');
    expect(inventory.customerBalanceRecipes).not.toContain('feeGiveBackPayOut');
  });
});
