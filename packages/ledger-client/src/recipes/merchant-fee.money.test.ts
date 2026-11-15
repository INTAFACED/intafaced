import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { balanceAllowed, chargeReceivable, houseFees } from '../accounts.js';
import { movesCustomerBalance } from '../custody-layer.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { IDEMPOTENCY_CONFLICT_CODE } from '../client.js';
import { InsufficientFundsError, InvalidEntryError, LedgerError } from '../types.js';
import {
  MERCHANT_FEE_UNSET_CODE,
  MerchantFeeUnsetError,
  merchantFeeOf,
  merchantFeeReceivableAccount,
  type MerchantFeeEarnInput,
  type MerchantFeeRate,
} from './merchant-fee.js';
import { recipes } from './index.js';
import type { OwnFundsPlace } from './own-funds.js';

/**
 * Our fee on a payment a business received straight into its own wallet (launch money model, OWNER 226; J-merchant-04's
 * Money line). TEST businesses, TEST amounts and a TEST fee only.
 */
const MODULE = 'pay';
const M = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const N = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WALLET: OwnFundsPlace = { kind: 'treasury-wallet', walletId: 'base:ops' };
/** TEST fee, never a real value: 2.5% of the payment. */
const TEST_FEE: MerchantFeeRate = { bps: 250 };

let ledger: MemoryLedger;
beforeEach(() => {
  ledger = new MemoryLedger();
});
const bal = async (ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await ledger.balance(ref)).amount);
const owedBy = (merchantId = M) => merchantFeeReceivableAccount(MODULE, merchantId, 'USDC');
const revenue = () => houseFees(MODULE, 'USDC');

const earn = (over: Partial<MerchantFeeEarnInput> = {}) =>
  recipes.merchantFeeEarn({
    module: MODULE,
    merchantId: M,
    paymentId: 'pay-1',
    assetId: 'USDC',
    grossAmount: amt('25'),
    rate: TEST_FEE,
    ...over,
  });

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a refusal');
}

describe('merchantFeeEarn: a blank fee refuses with a typed error', () => {
  it('refuses with ledger.merchant_fee_unset while the fee is blank, and when it is absent', () => {
    const e = caught(() => earn({ rate: { bps: null } }));
    expect(e).toBeInstanceOf(MerchantFeeUnsetError);
    expect((e as LedgerError).code).toBe(MERCHANT_FEE_UNSET_CODE);
    expect((e as LedgerError).code).toBe('ledger.merchant_fee_unset');
    expect(caught(() => earn({ rate: {} }))).toBeInstanceOf(MerchantFeeUnsetError);
    // A caller handing over untyped data with no rate at all (a JSON body's null).
    expect(caught(() => earn({ rate: JSON.parse('null') }))).toBeInstanceOf(MerchantFeeUnsetError);
    expect(caught(() => merchantFeeOf(M, amt('25'), { bps: null }))).toBeInstanceOf(MerchantFeeUnsetError);
  });

  it('a fee of zero posts nothing; a fee outside 0 to 10000 whole basis points is refused', () => {
    expect(caught(() => earn({ rate: { bps: 0 } }))).toBeInstanceOf(InvalidEntryError);
    expect(caught(() => earn({ rate: { bps: -1 } }))).toBeInstanceOf(InvalidEntryError);
    expect(caught(() => earn({ rate: { bps: 10_001 } }))).toBeInstanceOf(InvalidEntryError);
    expect(caught(() => earn({ rate: { bps: 2.5 } }))).toBeInstanceOf(InvalidEntryError);
  });
});

describe('merchantFeeEarn: only our fee enters the book, once under the payment', () => {
  it('the fee is the rate on the gross, rounded down, never a caller figure; the gross never enters the book', () => {
    const p = earn();
    expect(p.entries.map((e) => formatAmount(e.amount))).toEqual(['0.625', '0.625']);
    expect(p.entries.map((e) => e.account)).toEqual([revenue(), chargeReceivable(MODULE, M, 'USDC')]);
    expect(caught(() => earn({ grossAmount: 1n, rate: { bps: 1 } }))).toBeInstanceOf(InvalidEntryError); // rounds to nothing
    expect(caught(() => earn({ grossAmount: 0n }))).toBeInstanceOf(InvalidEntryError);
    expect(p.meta).toMatchObject({ grossAmount: '25', rateBps: 250, paymentId: 'pay-1', merchantId: M });
    expect(p.reason).toBe('merchant_fee.earned');
  });

  it('one payment earns once, keyed by the module and the payment id', async () => {
    const p = earn();
    expect(p.idempotencyKey).toBe('merchant-fee:earned:pay:pay-1');
    await ledger.post(p);
    await ledger.post(p);
    expect(await bal(revenue())).toBe('0.625');
    expect(await bal(owedBy())).toBe('-0.625');
    // The same payment for a different amount is refused, never booked twice.
    await expect(ledger.post(earn({ grossAmount: amt('30') }))).rejects.toMatchObject({ code: IDEMPOTENCY_CONFLICT_CODE });
    expect(await bal(revenue())).toBe('0.625');
  });

  it('refuses ids that would make a key or an account read two ways', () => {
    expect(caught(() => earn({ paymentId: 'x:y' }))).toBeInstanceOf(InvalidEntryError);
    expect(caught(() => earn({ paymentId: 'x y' }))).toBeInstanceOf(InvalidEntryError);
    expect(caught(() => earn({ module: 'Pay' }))).toBeInstanceOf(InvalidEntryError);
    expect(caught(() => earn({ merchantId: 'not-a-uuid' }))).toBeInstanceOf(InvalidEntryError);
    expect(caught(() => earn({ assetId: ' USDC' }))).toBeInstanceOf(InvalidEntryError);
  });
});

describe('the invariant: fees earned = still owed + collected, own accounts only', () => {
  it('over payments of two businesses and a partial collection, revenue equals owed plus arrived', async () => {
    await ledger.post(earn({ paymentId: 'p1', grossAmount: amt('100') })); // 2.5
    await ledger.post(earn({ paymentId: 'p2', grossAmount: amt('25') })); // 0.625
    await ledger.post(earn({ merchantId: N, paymentId: 'p3', grossAmount: amt('40') })); // 1
    // The business pays part of what it owes into our own wallet: the existing Collect, keyed by that payment's record.
    await ledger.post(
      recipes.chargeCollect({ module: MODULE, userId: M, to: WALLET, paymentId: '0xfee1', assetId: 'USDC', amount: amt('2') }),
    );
    // Collecting more than a business owes is refused: the excess would be its money in our book.
    await expect(
      ledger.post(
        recipes.chargeCollect({ module: MODULE, userId: N, to: WALLET, paymentId: '0xfee2', assetId: 'USDC', amount: amt('1.000001') }),
      ),
    ).rejects.toBeInstanceOf(InsufficientFundsError);

    expect(await bal(revenue())).toBe('4.125');
    expect(await bal(owedBy())).toBe('-1.125');
    expect(await bal(owedBy(N))).toBe('-1');
    const owed = -((await ledger.balance(owedBy())).amount + (await ledger.balance(owedBy(N))).amount);
    const arrived = -(
      await ledger.balance({
        ...recipes.chargeCollect({ module: MODULE, userId: M, to: WALLET, paymentId: '0x', assetId: 'USDC', amount: 1n }).entries[1]!
          .account,
      })
    ).amount;
    expect((await ledger.balance(revenue())).amount).toBe(owed + arrived);
  });

  it('no leg is a customer balance, and the recipe is not in the custody-layer inventory', () => {
    expect(movesCustomerBalance(earn().entries)).toBe(false);
    const inventory = JSON.parse(readFileSync(new URL('../../../../tooling/ci/custody-layer-inventory.json', import.meta.url), 'utf8')) as {
      customerBalanceRecipes: string[];
    };
    expect(inventory.customerBalanceRecipes).not.toContain('merchantFeeEarn');
  });

  it("a business's fee receivable may never go above zero", () => {
    expect(balanceAllowed(owedBy(), 1n)).toBe(false);
    expect(balanceAllowed(owedBy(), -1n)).toBe(true);
  });
});
