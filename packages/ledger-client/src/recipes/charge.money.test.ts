import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { balanceAllowed, chargeReceivable, houseFees, venueBuilderFeeReceivable } from '../accounts.js';
import { movesCustomerBalance } from '../custody-layer.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { IDEMPOTENCY_CONFLICT_CODE } from '../client.js';
import { InsufficientFundsError, InvalidEntryError, LedgerError } from '../types.js';
import {
  CHARGE_PRICE_UNSET,
  CHARGE_PRICE_UNSET_CODE,
  ChargePriceUnsetError,
  chargeReceivableAccount,
  type ChargeCollectInput,
  type ChargeEarnInput,
  type ChargePrice,
} from './charge.js';
import { recipes } from './index.js';
import { ownFundsPlaceAccount, type OwnFundsPlace } from './own-funds.js';

/**
 * A charge a customer owes us, earned and collected into one of our own-funds places (launch money model; OWNER 288). TEST
 * amounts and a TEST price only: the real price is the owner's number and is unset.
 */
const MODULE = 'agents';
const ALICE = '11111111-1111-4111-8111-1111111111c0';
const BOB = '22222222-2222-4222-8222-2222222222c0';
const WALLET: OwnFundsPlace = { kind: 'treasury-wallet', walletId: 'base:ops' };
const PARTNER: OwnFundsPlace = { kind: 'partner-reserve', partnerId: 'test-partner' };
/** TEST price, never a real value: 2.50 per unit. */
const TEST_PRICE: ChargePrice = { perUnit: amt('2.5') };

let ledger: MemoryLedger;
beforeEach(() => {
  ledger = new MemoryLedger();
});
const bal = async (ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await ledger.balance(ref)).amount);
const owedBy = (userId = ALICE) => chargeReceivableAccount(MODULE, userId, 'USDC');
const revenue = () => houseFees(MODULE, 'USDC');
const place = (p: OwnFundsPlace = WALLET) => ownFundsPlaceAccount(p, 'USDC');

const earn = (over: Partial<ChargeEarnInput> = {}) =>
  recipes.chargeEarn({ module: MODULE, saleId: 'sale-1', userId: ALICE, assetId: 'USDC', price: TEST_PRICE, units: 4n, ...over });

const collect = (amount: string, paymentId: string, over: Partial<ChargeCollectInput> = {}) =>
  recipes.chargeCollect({ module: MODULE, userId: ALICE, to: WALLET, paymentId, assetId: 'USDC', amount: amt(amount), ...over });

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a refusal');
}

describe('chargeEarn: the owner prices it', () => {
  it('refuses with ledger.charge_price_unset while the price is unset (the state until the owner sets it)', () => {
    const e = caught(() => earn({ price: CHARGE_PRICE_UNSET }));
    expect(e).toBeInstanceOf(ChargePriceUnsetError);
    expect((e as LedgerError).code).toBe(CHARGE_PRICE_UNSET_CODE);
    expect((e as LedgerError).code).toBe('ledger.charge_price_unset');
    expect((e as Error).message).toBe(
      "A charge for agents cannot be earned while its price is unset. The price is the owner's number; it has no default, so " +
        'every charge is refused until it is set.',
    );
  });

  it('refuses when the price is absent', () => {
    expect(caught(() => earn({ price: {} }))).toBeInstanceOf(ChargePriceUnsetError);
    expect(caught(() => earn({ price: undefined as unknown as ChargePrice }))).toBeInstanceOf(ChargePriceUnsetError);
  });

  it('a price of zero is set and posts nothing; a negative price is refused', () => {
    expect(caught(() => earn({ price: { perUnit: 0n } }))).toBeInstanceOf(InvalidEntryError);
    expect(caught(() => earn({ price: { perUnit: -1n } }))).toBeInstanceOf(InvalidEntryError);
  });

  it('the amount is the price times the units, never a caller figure', () => {
    const p = earn({ units: 3n });
    expect(p.entries.map((e) => formatAmount(e.amount))).toEqual(['7.5', '7.5']);
    expect(caught(() => earn({ units: 0n }))).toBeInstanceOf(InvalidEntryError);
  });

  it('one sale earns once, keyed by the sale id', async () => {
    const p = earn();
    expect(p.idempotencyKey).toBe(`charge:earned:${MODULE}:sale-1`);
    await ledger.post(p);
    await ledger.post(p);
    expect(await bal(revenue())).toBe('10');
    expect(await bal(owedBy())).toBe('-10');
    // The same sale for a different amount is refused, never booked twice.
    await expect(ledger.post(earn({ units: 5n }))).rejects.toMatchObject({ code: IDEMPOTENCY_CONFLICT_CODE });
  });
});

describe('chargeCollect: only what is owed, only to our own place', () => {
  it('refuses a collect with nothing earned, and the book is unchanged', async () => {
    await expect(ledger.post(collect('1', '0xpay1'))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(owedBy())).toBe('0');
    expect(await bal(place())).toBe('0');
  });

  it('refuses one unit above what is owed, and the book is unchanged; allows exactly what is owed', async () => {
    await ledger.post(earn());
    await expect(ledger.post(collect('10.000001', '0xpay1'))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(owedBy())).toBe('-10');
    expect(await bal(place())).toBe('0');
    await ledger.post(collect('10', '0xpay1'));
    expect(await bal(owedBy())).toBe('0');
    expect(await bal(place())).toBe('-10');
    // Nothing more is owed, so a further unit is refused.
    await expect(ledger.post(collect('0.000001', '0xpay2'))).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it("refuses collecting one customer's charge against another's payment", async () => {
    await ledger.post(earn());
    await expect(ledger.post(collect('1', '0xpay1', { userId: BOB }))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(owedBy())).toBe('-10');
  });

  it('refuses a collect into an account that is not one of our own-funds places', () => {
    expect(caught(() => collect('1', '0xpay1', { to: { kind: 'treasury-wallet', walletId: 'Bad Id' } }))).toBeInstanceOf(InvalidEntryError);
  });

  it('one payment at one place is collected once, and a second customer cannot claim it', async () => {
    await ledger.post(earn());
    await ledger.post(earn({ saleId: 'sale-2', userId: BOB }));
    const c = collect('4', '0xpay1');
    expect(c.idempotencyKey).toBe('charge:collected:treasury-wallet:base:ops:USDC:0xpay1');
    await ledger.post(c);
    await ledger.post(c);
    expect(await bal(owedBy())).toBe('-6');
    await expect(ledger.post(collect('4', '0xpay1', { userId: BOB }))).rejects.toMatchObject({ code: IDEMPOTENCY_CONFLICT_CODE });
    expect(await bal(owedBy(BOB))).toBe('-10');
  });
});

describe('the invariant: earned = owed + collected, own accounts only', () => {
  it('over several sales and partial payments at two places, revenue equals what is owed plus what arrived', async () => {
    await ledger.post(earn({ saleId: 's1', units: 4n })); // 10
    await ledger.post(earn({ saleId: 's2', units: 2n })); // 5
    await ledger.post(earn({ saleId: 's3', userId: BOB, units: 1n })); // 2.5
    await ledger.post(collect('6', '0xa'));
    await ledger.post(collect('3', 'stmt-1', { to: PARTNER }));
    await ledger.post(collect('2.5', '0xb', { userId: BOB }));

    expect(await bal(revenue())).toBe('17.5');
    expect(await bal(owedBy())).toBe('-6');
    expect(await bal(owedBy(BOB))).toBe('0');
    expect(await bal(place())).toBe('-8.5');
    expect(await bal(place(PARTNER))).toBe('-3');
    // Revenue = what is still owed + what arrived at our places (both boundaries hold the negative).
    const owed = -((await ledger.balance(owedBy())).amount + (await ledger.balance(owedBy(BOB))).amount);
    const arrived = -((await ledger.balance(place())).amount + (await ledger.balance(place(PARTNER))).amount);
    expect((await ledger.balance(revenue())).amount).toBe(owed + arrived);
  });

  it('no leg is a customer balance, and neither recipe is in the custody-layer inventory', () => {
    expect(movesCustomerBalance(earn().entries)).toBe(false);
    expect(movesCustomerBalance(collect('1', '0xa').entries)).toBe(false);
    const inventory = JSON.parse(readFileSync(new URL('../../../../tooling/ci/custody-layer-inventory.json', import.meta.url), 'utf8')) as {
      customerBalanceRecipes: string[];
    };
    expect(inventory.customerBalanceRecipes).not.toContain('chargeEarn');
    expect(inventory.customerBalanceRecipes).not.toContain('chargeCollect');
  });

  it('a charge receivable may never go above zero; other treasury boundaries keep their rule', () => {
    expect(balanceAllowed(chargeReceivable(MODULE, ALICE, 'USDC'), 1n)).toBe(false);
    expect(balanceAllowed(chargeReceivable(MODULE, ALICE, 'USDC'), 0n)).toBe(true);
    expect(balanceAllowed(chargeReceivable(MODULE, ALICE, 'USDC'), -1n)).toBe(true);
    expect(balanceAllowed(venueBuilderFeeReceivable('v', 'USDC'), 1n)).toBe(true);
  });
});
