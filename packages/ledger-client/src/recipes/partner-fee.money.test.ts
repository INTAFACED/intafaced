import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { balanceAllowed, houseFees, partnerFeeReceivable, venueBuilderFeeReceivable } from '../accounts.js';
import { movesCustomerBalance } from '../custody-layer.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { IDEMPOTENCY_CONFLICT_CODE } from '../client.js';
import { InsufficientFundsError, InvalidEntryError, LedgerError } from '../types.js';
import {
  PARTNER_FEE_RATE_UNSET,
  PARTNER_FEE_RATE_UNSET_CODE,
  PartnerFeeRateUnsetError,
  partnerFeeReceivableAccount,
  type PartnerFeeEarnInput,
  type PartnerFeeRate,
  type PartnerFeeSettleInput,
} from './partner-fee.js';
import { recipes } from './index.js';
import { ownFundsPlaceAccount, type OwnFundsPlace } from './own-funds.js';

/**
 * Our fee on a payment a licensed partner processed, earned and settled by the partner into our own funds (launch money
 * model; OWNER 288). TEST partners, TEST amounts and a TEST rate only: the partner is not named and its rate is unset.
 */
const MODULE = 'merchant';
const P = 'test-partner-a';
const Q = 'test-partner-b';
const WALLET: OwnFundsPlace = { kind: 'treasury-wallet', walletId: 'base:ops' };
const RESERVE: OwnFundsPlace = { kind: 'partner-reserve', partnerId: P };
/** TEST rate, never a real value: 1.5% of the payment. */
const TEST_RATE: PartnerFeeRate = { bps: 150 };

let ledger: MemoryLedger;
beforeEach(() => {
  ledger = new MemoryLedger();
});
const bal = async (ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await ledger.balance(ref)).amount);
const owedBy = (partnerId = P) => partnerFeeReceivableAccount(partnerId, 'USDC');
const revenue = () => houseFees(MODULE, 'USDC');
const place = (p: OwnFundsPlace = WALLET) => ownFundsPlaceAccount(p, 'USDC');

const earn = (over: Partial<PartnerFeeEarnInput> = {}) =>
  recipes.partnerFeeEarn({
    partnerId: P,
    module: MODULE,
    paymentId: 'pay-1',
    assetId: 'USDC',
    grossAmount: amt('200'),
    rate: TEST_RATE,
    ...over,
  });

const settle = (amount: string, settlementLineId: string, over: Partial<PartnerFeeSettleInput> = {}) =>
  recipes.partnerFeeSettle({ partnerId: P, module: MODULE, to: WALLET, settlementLineId, assetId: 'USDC', amount: amt(amount), ...over });

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a refusal');
}

describe('partnerFeeEarn: the owner sets the rate', () => {
  it('refuses with ledger.partner_fee_rate_unset while the rate is unset (the state until the owner names the partner)', () => {
    const e = caught(() => earn({ rate: PARTNER_FEE_RATE_UNSET }));
    expect(e).toBeInstanceOf(PartnerFeeRateUnsetError);
    expect((e as LedgerError).code).toBe(PARTNER_FEE_RATE_UNSET_CODE);
    expect((e as LedgerError).code).toBe('ledger.partner_fee_rate_unset');
    expect((e as Error).message).toBe(
      "Our fee on a payment test-partner-a processed cannot be earned while the fee rate is unset. The rate is the owner's " +
        'number; it has no default, so every fee is refused until it is set.',
    );
  });

  it('refuses when the rate is absent', () => {
    expect(caught(() => earn({ rate: {} }))).toBeInstanceOf(PartnerFeeRateUnsetError);
    expect(caught(() => earn({ rate: undefined as unknown as PartnerFeeRate }))).toBeInstanceOf(PartnerFeeRateUnsetError);
  });

  it('a rate of zero posts nothing; a rate outside 0 to 10000 whole basis points is refused', () => {
    expect(caught(() => earn({ rate: { bps: 0 } }))).toBeInstanceOf(InvalidEntryError);
    expect(caught(() => earn({ rate: { bps: -1 } }))).toBeInstanceOf(InvalidEntryError);
    expect(caught(() => earn({ rate: { bps: 10_001 } }))).toBeInstanceOf(InvalidEntryError);
    expect(caught(() => earn({ rate: { bps: 1.5 } }))).toBeInstanceOf(InvalidEntryError);
  });

  it('the fee is the rate on the gross, rounded down, never a caller figure; the gross never enters the book', () => {
    const p = earn();
    expect(p.entries.map((e) => formatAmount(e.amount))).toEqual(['3', '3']);
    expect(caught(() => earn({ grossAmount: 1n, rate: { bps: 1 } }))).toBeInstanceOf(InvalidEntryError); // rounds to nothing
    expect(earn({ grossAmount: amt('0.000000000000000199'), rate: { bps: 100 } }).entries[0]!.amount).toBe(1n);
    expect(caught(() => earn({ grossAmount: 0n }))).toBeInstanceOf(InvalidEntryError);
    expect(p.meta).toMatchObject({ grossAmount: '200', rateBps: 150, paymentId: 'pay-1', partnerId: P });
  });

  it('one payment earns once, keyed by the partner and its payment id', async () => {
    const p = earn();
    expect(p.idempotencyKey).toBe(`partner-fee:earned:${P}:pay-1`);
    await ledger.post(p);
    await ledger.post(p);
    expect(await bal(revenue())).toBe('3');
    expect(await bal(owedBy())).toBe('-3');
    // The same payment for a different amount is refused, never booked twice.
    await expect(ledger.post(earn({ grossAmount: amt('300') }))).rejects.toMatchObject({ code: IDEMPOTENCY_CONFLICT_CODE });
    // The same payment id at another partner is another payment.
    expect(earn({ partnerId: Q }).idempotencyKey).toBe(`partner-fee:earned:${Q}:pay-1`);
  });

  it('refuses ids that would make a key read two ways', () => {
    expect(caught(() => earn({ partnerId: 'a:b' }))).toBeInstanceOf(InvalidEntryError);
    expect(caught(() => earn({ paymentId: 'x:y' }))).toBeInstanceOf(InvalidEntryError);
    expect(caught(() => earn({ module: 'Merchant' }))).toBeInstanceOf(InvalidEntryError);
  });
});

describe('partnerFeeSettle: only what the partner owes, only into our own funds', () => {
  it('refuses a settlement with nothing earned, and the book is unchanged', async () => {
    await expect(ledger.post(settle('1', 'line-1'))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(owedBy())).toBe('0');
    expect(await bal(place())).toBe('0');
  });

  it('refuses one unit above what is owed, and the book is unchanged; allows exactly what is owed', async () => {
    await ledger.post(earn());
    await expect(ledger.post(settle('3.000001', 'line-1'))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(owedBy())).toBe('-3');
    expect(await bal(place())).toBe('0');
    await ledger.post(settle('3', 'line-1'));
    expect(await bal(owedBy())).toBe('0');
    expect(await bal(place())).toBe('-3');
    await expect(ledger.post(settle('0.000001', 'line-2'))).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it('a short settlement leaves the rest owed by that partner (J-ops-console-26)', async () => {
    await ledger.post(earn());
    await ledger.post(settle('2', 'line-1'));
    expect(await bal(owedBy())).toBe('-1');
    expect(await bal(revenue())).toBe('3');
  });

  it("refuses settling one partner's fees out of another partner's debt", async () => {
    await ledger.post(earn());
    await expect(ledger.post(settle('1', 'line-1', { partnerId: Q }))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(owedBy())).toBe('-3');
  });

  it('lands only in our treasury wallet or our reserve at that same partner', async () => {
    await ledger.post(earn());
    expect(caught(() => settle('1', 'l', { to: { kind: 'partner-reserve', partnerId: Q } }))).toBeInstanceOf(InvalidEntryError);
    expect(caught(() => settle('1', 'l', { to: { kind: 'venue-builder-account', venueId: 'v' } }))).toBeInstanceOf(InvalidEntryError);
    expect(caught(() => settle('1', 'l', { to: { kind: 'treasury-wallet', walletId: 'Bad Id' } }))).toBeInstanceOf(InvalidEntryError);
    await ledger.post(settle('1', 'line-r', { to: RESERVE }));
    expect(await bal(place(RESERVE))).toBe('-1');
  });

  it('one settlement line is settled once', async () => {
    await ledger.post(earn());
    const s = settle('1', 'line-1');
    expect(s.idempotencyKey).toBe(`partner-fee:settled:${P}:USDC:line-1`);
    await ledger.post(s);
    await ledger.post(s);
    expect(await bal(owedBy())).toBe('-2');
    await expect(ledger.post(settle('2', 'line-1'))).rejects.toMatchObject({ code: IDEMPOTENCY_CONFLICT_CODE });
    expect(await bal(owedBy())).toBe('-2');
  });
});

describe('the invariant: fees earned = still owed + settled, own accounts only', () => {
  it('over several payments at two partners and partial settlements at two places, revenue equals owed plus arrived', async () => {
    await ledger.post(earn({ paymentId: 'p1', grossAmount: amt('200') })); // 3
    await ledger.post(earn({ paymentId: 'p2', grossAmount: amt('100') })); // 1.5
    await ledger.post(earn({ partnerId: Q, paymentId: 'p1', grossAmount: amt('1000') })); // 15
    await ledger.post(settle('2', 'l1'));
    await ledger.post(settle('1.5', 'l2', { to: RESERVE }));
    await ledger.post(settle('15', 'l1', { partnerId: Q }));

    expect(await bal(revenue())).toBe('19.5');
    expect(await bal(owedBy())).toBe('-1');
    expect(await bal(owedBy(Q))).toBe('0');
    expect(await bal(place())).toBe('-17');
    expect(await bal(place(RESERVE))).toBe('-1.5');
    const owed = -((await ledger.balance(owedBy())).amount + (await ledger.balance(owedBy(Q))).amount);
    const arrived = -((await ledger.balance(place())).amount + (await ledger.balance(place(RESERVE))).amount);
    expect((await ledger.balance(revenue())).amount).toBe(owed + arrived);
  });

  it('no leg is a customer balance, and neither recipe is in the custody-layer inventory', () => {
    expect(movesCustomerBalance(earn().entries)).toBe(false);
    expect(movesCustomerBalance(settle('1', 'l').entries)).toBe(false);
    const inventory = JSON.parse(readFileSync(new URL('../../../../tooling/ci/custody-layer-inventory.json', import.meta.url), 'utf8')) as {
      customerBalanceRecipes: string[];
    };
    expect(inventory.customerBalanceRecipes).not.toContain('partnerFeeEarn');
    expect(inventory.customerBalanceRecipes).not.toContain('partnerFeeSettle');
  });

  it('a partner fee receivable may never go above zero; other treasury boundaries keep their rule', () => {
    expect(balanceAllowed(partnerFeeReceivable(P, 'USDC'), 1n)).toBe(false);
    expect(balanceAllowed(partnerFeeReceivable(P, 'USDC'), 0n)).toBe(true);
    expect(balanceAllowed(partnerFeeReceivable(P, 'USDC'), -1n)).toBe(true);
    expect(balanceAllowed(venueBuilderFeeReceivable('v', 'USDC'), 1n)).toBe(true);
  });
});
