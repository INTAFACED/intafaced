import { beforeEach, describe, expect, it } from 'vitest';
import { houseFees, treasuryWallet, venueBuilderAccount } from '../accounts.js';
import { movesCustomerBalance } from '../custody-layer.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { InsufficientFundsError, InvalidEntryError, LedgerError } from '../types.js';
import { BUILDER_FEE_POT } from './builder-fee.js';
import {
  FEE_SHARE_EXCEEDED_CODE,
  FEE_SHARE_OVER_CLAIM_CODE,
  FEE_SHARE_RATE_UNSET,
  FEE_SHARE_RATE_UNSET_CODE,
  FeeShareExceededError,
  FeeShareOverClaimError,
  FeeShareRateUnsetError,
  feeShareBudgetAccount,
  feeShareOwedAccount,
  type FeeShareBudgetFundInput,
  type FeeShareOweInput,
  type FeeShareRate,
  type FeeShareRecipient,
} from './fee-share-owed.js';
import { recipes } from './index.js';
import type { OwnFundsPlace } from './own-funds.js';

/**
 * A fee share we owe a lead trader or affiliate and its payment to their own wallet (launch money model; OWNER 288). TEST
 * amounts and a TEST rate only: the real rate is the owner's number and is unset.
 */
const VENUE = 'test-venue';
const TRADER = '11111111-1111-4111-8111-1111111111f0';
const LEAD: FeeShareRecipient = { kind: 'lead-trader', userId: '22222222-2222-4222-8222-2222222222f0' };
const AFFILIATE: FeeShareRecipient = { kind: 'affiliate', userId: '33333333-3333-4333-8333-3333333333f0' };
const WALLET: OwnFundsPlace = { kind: 'treasury-wallet', walletId: 'base:ops' };
const BUILDER: OwnFundsPlace = { kind: 'venue-builder-account', venueId: VENUE };
const THEIR_WALLET = '0x00000000000000000000000000000000000000c1';
/** TEST rate, never a real value: 50% of the fill's fee. */
const TEST_RATE: FeeShareRate = { bps: 5_000 };

let ledger: MemoryLedger;
beforeEach(() => {
  ledger = new MemoryLedger();
});
const bal = async (ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await ledger.balance(ref)).amount);
const budget = () => feeShareBudgetAccount(VENUE, 'USDC');
const owedTo = (r: FeeShareRecipient) => feeShareOwedAccount(r, 'USDC');

let seq = 0;
const earn = (amount: string, fillId = `f${++seq}`, venueId = VENUE) =>
  ledger.post(recipes.builderFeeEarn({ venueId, venueAccount: '0xowner', fillId, assetId: 'USDC', amount: amt(amount), userId: TRADER }));

/** A fee earned and collected into our builder account. Returns the venue's claim id. */
async function earnedAndCollected(amount: string, venueId = VENUE): Promise<string> {
  await earn(amount, undefined, venueId);
  const claimId = `c${++seq}`;
  await ledger.post(recipes.builderFeeReceive({ venueId, claimId, assetId: 'USDC', amount: amt(amount) }));
  return claimId;
}

const fund = (claimId: string, amount: string, claimAmount = amount, over: Partial<FeeShareBudgetFundInput> = {}) =>
  recipes.feeShareBudgetFund({ venueId: VENUE, claimId, assetId: 'USDC', claimAmount: amt(claimAmount), amount: amt(amount), ...over });

const owe = (over: Partial<FeeShareOweInput> = {}) =>
  recipes.feeShareOwe({
    venueId: VENUE,
    venueAccount: '0xowner',
    fillId: 'fill-1',
    recipient: LEAD,
    assetId: 'USDC',
    feeEarned: amt('20'),
    rate: TEST_RATE,
    amount: amt('10'),
    sharedSoFarOnFill: 0n,
    ...over,
  });

const pay = (amount: string, chainTx: string, recipient: FeeShareRecipient = LEAD, from: OwnFundsPlace = BUILDER) =>
  recipes.feeSharePayOut({ recipient, from, toWallet: THEIR_WALLET, chainTx, assetId: 'USDC', amount: amt(amount) });

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a refusal');
}

describe('feeShareOwe: the rate and the fill bound it', () => {
  it('refuses with ledger.fee_share_rate_unset while the rate is unset (the state until the owner sets it)', () => {
    const e = caught(() => owe({ rate: FEE_SHARE_RATE_UNSET }));
    expect(e).toBeInstanceOf(FeeShareRateUnsetError);
    expect((e as LedgerError).code).toBe(FEE_SHARE_RATE_UNSET_CODE);
    expect((e as LedgerError).code).toBe('ledger.fee_share_rate_unset');
    expect((e as Error).message).toBe(
      "A fee share cannot be owed while its rate is unset. The rate is the owner's number; it has no default, so every fee " +
        'share is refused until it is set.',
    );
  });

  it('refuses when the rate is absent', () => {
    expect(caught(() => owe({ rate: {} }))).toBeInstanceOf(FeeShareRateUnsetError);
    expect(caught(() => owe({ rate: undefined as unknown as FeeShareRate }))).toBeInstanceOf(FeeShareRateUnsetError);
  });

  it('a rate of zero is set and admits nothing', () => {
    const e = caught(() => owe({ rate: { bps: 0 } }));
    expect(e).toBeInstanceOf(FeeShareExceededError);
    expect((e as LedgerError).code).toBe(FEE_SHARE_EXCEEDED_CODE);
  });

  it('refuses one unit above the rate on the fill, allows exactly at it, and allows less (a cap or decay)', () => {
    const e = caught(() => owe({ amount: amt('10.000001') }));
    expect(e).toBeInstanceOf(FeeShareExceededError);
    expect((e as FeeShareExceededError).which).toBe('rate');
    expect(() => owe({ amount: amt('10') })).not.toThrow();
    expect(() => owe({ amount: amt('3') })).not.toThrow();
  });

  it('refuses shares on one fill that would pass its fee, and allows exactly the fee', () => {
    const e = caught(() => owe({ recipient: AFFILIATE, sharedSoFarOnFill: amt('10.000001') }));
    expect(e).toBeInstanceOf(FeeShareExceededError);
    expect((e as FeeShareExceededError).which).toBe('fee');
    expect(() => owe({ recipient: AFFILIATE, sharedSoFarOnFill: amt('10') })).not.toThrow();
  });
});

describe('feeShareBudgetFund: only money a claim collected', () => {
  it('refuses one unit above the claim it names, and allows exactly the claim or part of it', () => {
    const e = caught(() => fund('c1', '10.000001', '10'));
    expect(e).toBeInstanceOf(FeeShareOverClaimError);
    expect((e as LedgerError).code).toBe(FEE_SHARE_OVER_CLAIM_CODE);
    expect(() => fund('c1', '10', '10')).not.toThrow();
    expect(() => fund('c1', '4', '10')).not.toThrow();
  });

  it('one claim funds once, and the key names the claim', async () => {
    const claim = await earnedAndCollected('20');
    const f = fund(claim, '8', '20');
    await ledger.post(f);
    await ledger.post(f);
    expect(f.idempotencyKey).toBe(`fee-share:budget-fund:${VENUE}:${claim}`);
    expect(await bal(budget())).toBe('8');
    expect(await bal(houseFees(BUILDER_FEE_POT, 'USDC'))).toBe('12');
  });

  it('refuses when builder-fee revenue holds less, and the book is unchanged', async () => {
    const claim = await earnedAndCollected('5');
    const before = ledger.journal().length;
    await expect(ledger.post(fund(claim, '5.000001', '9'))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(ledger.journal()).toHaveLength(before);
    expect(await bal(budget())).toBe('0');
  });
});

describe('feeShareOwe and feeSharePayOut on the book', () => {
  it('refuses Owe on a fee earned and not collected: revenue alone is no budget', async () => {
    await earn('100');
    const before = ledger.journal().length;
    await expect(ledger.post(owe())).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(ledger.journal()).toHaveLength(before);
    expect(await bal(houseFees(BUILDER_FEE_POT, 'USDC'))).toBe('100');
    expect(await bal(owedTo(LEAD))).toBe('0');
  });

  it('refuses Owe when the budget holds less than the amount, and the book is unchanged', async () => {
    const claim = await earnedAndCollected('20');
    await ledger.post(fund(claim, '9.999999', '20'));
    const before = ledger.journal().length;
    await expect(ledger.post(owe())).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(ledger.journal()).toHaveLength(before);
    expect(await bal(budget())).toBe('9.999999');
    expect(await bal(owedTo(LEAD))).toBe('0');
  });

  it("refuses Owe out of another venue's budget: each budget is its own", async () => {
    const claim = await earnedAndCollected('20', 'other-venue');
    await ledger.post(fund(claim, '20', '20', { venueId: 'other-venue' }));
    await expect(ledger.post(owe())).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it('refuses Pay when the book shows less than the amount at the paying place, and the book is unchanged', async () => {
    const claim = await earnedAndCollected('20');
    await ledger.post(fund(claim, '10', '20'));
    await ledger.post(owe());
    // All but 9.999999 moves on to our treasury wallet, so the builder account shows one unit too little.
    await ledger.post(recipes.ownFundsMove({ from: BUILDER, to: WALLET, assetId: 'USDC', amount: amt('10.000001'), reference: '0xsweep' }));
    const before = ledger.journal().length;
    await expect(ledger.post(pay('10', '0xpay1'))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(ledger.journal()).toHaveLength(before);
    expect(await bal(venueBuilderAccount(VENUE, 'USDC'))).toBe('-9.999999');
    expect(await bal(owedTo(LEAD))).toBe('10');
    // Out of an empty place too.
    await expect(ledger.post(pay('1', '0xpay2', LEAD, { kind: 'treasury-wallet', walletId: 'empty' }))).rejects.toBeInstanceOf(
      InsufficientFundsError,
    );
  });

  it('refuses Pay of more than we owe that recipient, and of what we owe someone else', async () => {
    const claim = await earnedAndCollected('100');
    await ledger.post(fund(claim, '10', '100'));
    await ledger.post(owe());
    await expect(ledger.post(pay('10.000001', '0xpay1'))).rejects.toBeInstanceOf(InsufficientFundsError);
    await expect(ledger.post(pay('1', '0xpay2', AFFILIATE))).rejects.toBeInstanceOf(InsufficientFundsError);
    await ledger.post(pay('10', '0xpay3'));
    await expect(ledger.post(pay('0.000001', '0xpay4'))).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it('the same fill owes one recipient once, and the same chain transaction pays once', async () => {
    const claim = await earnedAndCollected('40');
    await ledger.post(fund(claim, '30', '40'));
    const o = owe();
    await ledger.post(o);
    await ledger.post(o);
    expect(o.idempotencyKey).toBe(`fee-share:builder-fee:${VENUE}:0xowner:fill-1:lead-trader:${LEAD.userId}`);
    const p = pay('10', '0xpay1');
    await ledger.post(p);
    await ledger.post(p);
    expect(p.idempotencyKey).toBe(`fee-share:paid:lead-trader:${LEAD.userId}:USDC:0xpay1`);
    expect(await bal(budget())).toBe('20');
    expect(await bal(venueBuilderAccount(VENUE, 'USDC'))).toBe('-30');
  });

  it('one person is owed on the same fill as lead trader and as affiliate, under two keys and two pots', async () => {
    const claim = await earnedAndCollected('20');
    await ledger.post(fund(claim, '20', '20'));
    const asAffiliate: FeeShareRecipient = { kind: 'affiliate', userId: LEAD.userId };
    await ledger.post(owe());
    await ledger.post(owe({ recipient: asAffiliate, sharedSoFarOnFill: amt('10') }));
    expect(await bal(owedTo(LEAD))).toBe('10');
    expect(await bal(owedTo(asAffiliate))).toBe('10');
  });

  it('invariant: budget + owed + paid out equals what was set aside; revenue falls by what was set aside; the place by what was paid', async () => {
    const claim = await earnedAndCollected('40');
    await ledger.post(fund(claim, '25', '40'));
    await ledger.post(owe({ fillId: 'a', amount: amt('7') }));
    await ledger.post(owe({ fillId: 'b', recipient: AFFILIATE, amount: amt('5') }));
    await ledger.post(pay('7', '0xa'));
    await ledger.post(pay('2', '0xb1', AFFILIATE));
    const inBudget = (await ledger.balance(budget())).amount;
    const owed = (await ledger.balance(owedTo(LEAD))).amount + (await ledger.balance(owedTo(AFFILIATE))).amount;
    const paid = amt('9');
    expect(inBudget + owed + paid).toBe(amt('25'));
    expect(formatAmount(owed)).toBe('3');
    expect(await bal(houseFees(BUILDER_FEE_POT, 'USDC'))).toBe('15');
    expect(await bal(venueBuilderAccount(VENUE, 'USDC'))).toBe('-31');
    expect(await bal(treasuryWallet('base:ops', 'USDC'))).toBe('0');
  });

  it('every entry is one of our own accounts; none moves a customer balance', () => {
    for (const p of [fund('c1', '1'), owe(), pay('1', '0xpay1')]) {
      expect(movesCustomerBalance(p.entries)).toBe(false);
      for (const e of p.entries) expect(['module', 'house', 'treasury']).toContain(e.account.ownerType);
    }
  });
});

describe('bad inputs are refused before anything is built', () => {
  it('Fund', () => {
    expect(() => fund('a b', '1')).toThrow(InvalidEntryError);
    expect(() => fund('a:b', '1')).toThrow(InvalidEntryError);
    expect(() => fund('c1', '0')).toThrow(InvalidEntryError);
    expect(() => fund('c1', '1', '0')).toThrow(InvalidEntryError);
    expect(() => fund('c1', '1', '1', { venueId: 'Bad:Id' })).toThrow(InvalidEntryError);
    expect(() => fund('c1', '1', '1', { assetId: ' USDC' })).toThrow(InvalidEntryError);
  });

  it('Owe', () => {
    expect(() => owe({ amount: 0n })).toThrow(InvalidEntryError);
    expect(() => owe({ feeEarned: 0n })).toThrow(InvalidEntryError);
    expect(() => owe({ fillId: 'a b' })).toThrow(InvalidEntryError);
    expect(() => owe({ venueAccount: 'a:b' })).toThrow(InvalidEntryError);
    expect(() => owe({ rate: { bps: 10_001 } })).toThrow(InvalidEntryError);
    expect(() => owe({ rate: { bps: 1.5 } })).toThrow(InvalidEntryError);
    expect(() => owe({ sharedSoFarOnFill: -1n })).toThrow(InvalidEntryError);
    expect(() => owe({ recipient: { kind: 'friend' as FeeShareRecipient['kind'], userId: LEAD.userId } })).toThrow(InvalidEntryError);
    expect(() => owe({ recipient: { kind: 'affiliate', userId: ` ${LEAD.userId}` } })).toThrow(InvalidEntryError);
    expect(() => owe({ fillId: 'x'.repeat(200) })).toThrow(/longer than/);
  });

  it('Pay', () => {
    expect(() => pay('1', '0x pay')).toThrow(InvalidEntryError);
    expect(() => pay('1', 'a:b')).toThrow(InvalidEntryError);
    expect(() => pay('0', '0xpay')).toThrow(InvalidEntryError);
    expect(() =>
      recipes.feeSharePayOut({ recipient: LEAD, from: WALLET, toWallet: '0x12', chainTx: '0xp', assetId: 'USDC', amount: 1n }),
    ).toThrow(/own wallet/);
    expect(() =>
      recipes.feeSharePayOut({
        recipient: LEAD,
        from: { kind: 'treasury-wallet', walletId: 'Bad Id' },
        toWallet: THEIR_WALLET,
        chainTx: '0xp',
        assetId: 'USDC',
        amount: 1n,
      }),
    ).toThrow(InvalidEntryError);
  });
});
