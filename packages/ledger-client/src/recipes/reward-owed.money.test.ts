import { beforeEach, describe, expect, it } from 'vitest';
import { houseFees, rewardsEngine, treasuryWallet, venueBuilderAccount } from '../accounts.js';
import { movesCustomerBalance } from '../custody-layer.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { InsufficientFundsError, InvalidEntryError, LedgerError } from '../types.js';
import { recipes } from './index.js';
import type { OwnFundsPlace } from './own-funds.js';
import { BUILDER_FEE_POT } from './builder-fee.js';
import {
  REWARD_CEILING_EXCEEDED_CODE,
  REWARD_CEILING_UNSET,
  REWARD_CEILING_UNSET_CODE,
  RewardCeilingExceededError,
  RewardCeilingUnsetError,
  campaignBudgetAccount,
  rewardOwedAccount,
  type RewardCeiling,
  type RewardOweInput,
} from './reward-owed.js';

/**
 * A reward we owe a customer and its payment to their own wallet (launch money model; OWNER 288). TEST amounts and a TEST
 * ceiling only: the real ceiling is the owner's number and is unset.
 */
const VENUE = 'test-venue';
const USER = '11111111-1111-4111-8111-1111111111f0';
const CAMPAIGN = 'test-cashback';
const WALLET: OwnFundsPlace = { kind: 'treasury-wallet', walletId: 'base:ops' };
const BUILDER: OwnFundsPlace = { kind: 'venue-builder-account', venueId: VENUE };
const CUSTOMER_WALLET = '0x00000000000000000000000000000000000000c1';
/** TEST ceiling, never a real value. */
const TEST_CEILING: RewardCeiling = { perCampaign: amt('50'), total: amt('80') };

let ledger: MemoryLedger;
beforeEach(() => {
  ledger = new MemoryLedger();
});
const bal = async (ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await ledger.balance(ref)).amount);

let seq = 0;
/** Our money comes in: a builder fee earned (revenue), collected into our builder account, and swept to our treasury wallet. */
async function ourMoneyAtTheWallet(amount: string) {
  const n = ++seq;
  await ledger.post(
    recipes.builderFeeEarn({
      venueId: VENUE,
      venueAccount: '0xowner',
      fillId: `f${n}`,
      assetId: 'USDC',
      amount: amt(amount),
      userId: USER,
    }),
  );
  await ledger.post(recipes.builderFeeReceive({ venueId: VENUE, claimId: `c${n}`, assetId: 'USDC', amount: amt(amount) }));
  await ledger.post(recipes.ownFundsMove({ from: BUILDER, to: WALLET, assetId: 'USDC', amount: amt(amount), reference: `0xsweep${n}` }));
}

/** Part of what we earned is swept to the rewards engine, and the campaign's budget is funded from it. */
async function fundBudget(amount: string, campaignId = CAMPAIGN) {
  const n = ++seq;
  await ledger.post(recipes.sweepFeesToRewards({ windowId: `w${n}`, sourceModule: BUILDER_FEE_POT, assetId: 'USDC', amount: amt(amount) }));
  await ledger.post(recipes.campaignBudgetFund({ campaignId, decisionId: `approval-${n}`, assetId: 'USDC', amount: amt(amount) }));
}

const owe = (over: Partial<RewardOweInput> = {}) =>
  recipes.rewardOwe({
    campaignId: CAMPAIGN,
    rewardId: `campaign:${CAMPAIGN}:${USER}:first-trade`,
    userId: USER,
    kind: 'cashback',
    assetId: 'USDC',
    amount: amt('10'),
    ceiling: TEST_CEILING,
    owedSoFar: { campaign: 0n, total: 0n },
    ...over,
  });

const pay = (amount: string, chainTx: string, rewardId = `campaign:${CAMPAIGN}:${USER}:first-trade`, from = WALLET) =>
  recipes.rewardPayOut({ rewardId, from, toWallet: CUSTOMER_WALLET, chainTx, assetId: 'USDC', amount: amt(amount) });

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a refusal');
}

describe('rewardOwe: refused while the ceiling is unset', () => {
  it('refuses with ledger.reward_ceiling_unset while both ceilings are unset (the state until the owner sets them)', () => {
    const e = caught(() => owe({ ceiling: REWARD_CEILING_UNSET }));
    expect(e).toBeInstanceOf(RewardCeilingUnsetError);
    expect((e as LedgerError).code).toBe(REWARD_CEILING_UNSET_CODE);
    expect((e as LedgerError).code).toBe('ledger.reward_ceiling_unset');
    expect((e as RewardCeilingUnsetError).missing).toEqual(['perCampaign', 'total']);
    expect((e as Error).message).toBe(
      "A reward cannot be owed while the reward ceiling is unset (perCampaign, total). The ceiling is the owner's number; " +
        'it has no default, so every reward is refused until it is set.',
    );
  });

  it('refuses while either one is unset, or the ceiling is absent', () => {
    expect((caught(() => owe({ ceiling: { perCampaign: amt('50'), total: null } })) as RewardCeilingUnsetError).missing).toEqual(['total']);
    expect((caught(() => owe({ ceiling: { total: amt('50') } })) as RewardCeilingUnsetError).missing).toEqual(['perCampaign']);
    expect(caught(() => owe({ ceiling: undefined as unknown as RewardCeiling }))).toBeInstanceOf(RewardCeilingUnsetError);
  });

  it('a ceiling of zero is set and admits nothing', () => {
    const e = caught(() => owe({ ceiling: { perCampaign: 0n, total: 0n } }));
    expect(e).toBeInstanceOf(RewardCeilingExceededError);
    expect((e as LedgerError).code).toBe(REWARD_CEILING_EXCEEDED_CODE);
  });

  it('refuses a reward that would take the campaign or the total past the ceiling, and allows one exactly at it', () => {
    expect(
      (caught(() => owe({ owedSoFar: { campaign: amt('40.000001'), total: amt('40.000001') } })) as RewardCeilingExceededError).which,
    ).toBe('perCampaign');
    expect((caught(() => owe({ owedSoFar: { campaign: amt('10'), total: amt('70.000001') } })) as RewardCeilingExceededError).which).toBe(
      'total',
    );
    expect(() => owe({ owedSoFar: { campaign: amt('40'), total: amt('70') } })).not.toThrow();
  });

  it('refuses running totals that cannot be true', () => {
    expect(() => owe({ owedSoFar: { campaign: amt('5'), total: amt('1') } })).toThrow(InvalidEntryError);
    expect(() => owe({ owedSoFar: { campaign: -1n, total: 0n } })).toThrow(InvalidEntryError);
    expect(() => owe({ ceiling: { perCampaign: -1n, total: amt('1') } })).toThrow(InvalidEntryError);
  });
});

describe('rewardOwe and rewardPayOut on the book', () => {
  it('refuses Owe when the campaign budget holds less than the amount, and the book is unchanged', async () => {
    await ourMoneyAtTheWallet('100');
    await fundBudget('9.999999');
    const before = ledger.journal().length;
    await expect(ledger.post(owe())).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(ledger.journal()).toHaveLength(before);
    expect(await bal(campaignBudgetAccount(CAMPAIGN))).toBe('9.999999');
    expect(await bal(rewardOwedAccount(`campaign:${CAMPAIGN}:${USER}:first-trade`))).toBe('0');
  });

  it("refuses Owe out of another campaign's budget: each budget is its own", async () => {
    await ourMoneyAtTheWallet('100');
    await fundBudget('100', 'other-campaign');
    await expect(ledger.post(owe())).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it('refuses Pay when the book shows less than the amount at the paying place, and the book is unchanged', async () => {
    await ourMoneyAtTheWallet('10');
    await fundBudget('10');
    await ledger.post(owe());
    // 0.000001 of it moves on to a partner reserve, so the wallet holds 9.999999.
    await ledger.post(
      recipes.ownFundsMove({
        from: WALLET,
        to: { kind: 'partner-reserve', partnerId: 'p' },
        assetId: 'USDC',
        amount: amt('0.000001'),
        reference: 'stmt-1',
      }),
    );
    const before = ledger.journal().length;
    await expect(ledger.post(pay('10', '0xpay1'))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(ledger.journal()).toHaveLength(before);
    expect(await bal(treasuryWallet('base:ops', 'USDC'))).toBe('-9.999999');
    expect(await bal(rewardOwedAccount(`campaign:${CAMPAIGN}:${USER}:first-trade`))).toBe('10');
    // Out of an empty place too.
    await expect(ledger.post(pay('1', '0xpay2', undefined, BUILDER))).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it('refuses Pay of more than is owed for that reward', async () => {
    await ourMoneyAtTheWallet('100');
    await fundBudget('10');
    await ledger.post(owe());
    await expect(ledger.post(pay('10.000001', '0xpay1'))).rejects.toBeInstanceOf(InsufficientFundsError);
    await ledger.post(pay('10', '0xpay1'));
    await expect(ledger.post(pay('0.000001', '0xpay2'))).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it('the same decision owes once, and the same chain transaction pays once', async () => {
    await ourMoneyAtTheWallet('30');
    await fundBudget('30');
    const o = owe();
    await ledger.post(o);
    await ledger.post(o);
    expect(o.idempotencyKey).toBe(`campaigns:owe:campaign:${CAMPAIGN}:${USER}:first-trade`);
    const p = pay('10', '0xpay1');
    await ledger.post(p);
    await ledger.post(p);
    expect(p.idempotencyKey).toBe(`campaigns:reward-paid:campaign:${CAMPAIGN}:${USER}:first-trade:0xpay1`);
    expect(await bal(campaignBudgetAccount(CAMPAIGN))).toBe('20');
    expect(await bal(treasuryWallet('base:ops', 'USDC'))).toBe('-20');
  });

  it('invariant: budget + owed + paid out equals what was set aside, and what we hold falls by exactly what we paid', async () => {
    await ourMoneyAtTheWallet('40');
    await fundBudget('25');
    const r = (task: string) => `campaign:${CAMPAIGN}:${USER}:${task}`;
    await ledger.post(owe({ rewardId: r('a'), amount: amt('7') }));
    await ledger.post(owe({ rewardId: r('b'), amount: amt('5'), owedSoFar: { campaign: amt('7'), total: amt('7') } }));
    await ledger.post(pay('7', '0xa', r('a')));
    await ledger.post(pay('2', '0xb1', r('b')));
    const budget = (await ledger.balance(campaignBudgetAccount(CAMPAIGN))).amount;
    const owed = (await ledger.balance(rewardOwedAccount(r('a')))).amount + (await ledger.balance(rewardOwedAccount(r('b')))).amount;
    const paid = amt('9');
    expect(budget + owed + paid).toBe(amt('25'));
    expect(formatAmount(owed)).toBe('3');
    expect(await bal(treasuryWallet('base:ops', 'USDC'))).toBe('-31');
    expect(await bal(rewardsEngine('USDC'))).toBe('0');
    // The rewards came out of what was swept from builder-fee revenue: 40 earned, 25 set aside, 15 left.
    expect(await bal(houseFees(BUILDER_FEE_POT, 'USDC'))).toBe('15');
  });

  it('every entry is one of our own accounts; none moves a customer balance', async () => {
    const posts = [
      recipes.campaignBudgetFund({ campaignId: CAMPAIGN, decisionId: 'approval-1', assetId: 'USDC', amount: amt('1') }),
      owe(),
      pay('1', '0xpay1'),
    ];
    for (const p of posts) {
      expect(movesCustomerBalance(p.entries)).toBe(false);
      for (const e of p.entries) expect(['module', 'house', 'treasury']).toContain(e.account.ownerType);
    }
  });
});

describe('bad inputs are refused before anything is built', () => {
  it('Owe', () => {
    expect(() => owe({ assetId: 'USDT' })).toThrow(InvalidEntryError);
    expect(() => owe({ amount: 0n })).toThrow(InvalidEntryError);
    expect(() => owe({ rewardId: `campaign:other:${USER}:x` })).toThrow(/own campaign/);
    expect(() => owe({ rewardId: 'campaign:test-cashback:a.b' })).toThrow(InvalidEntryError);
    expect(() => owe({ campaignId: 'Bad:Id' })).toThrow(InvalidEntryError);
    expect(() => owe({ userId: ` ${USER}` })).toThrow(InvalidEntryError);
    expect(() => owe({ kind: 'gift' as RewardOweInput['kind'] })).toThrow(InvalidEntryError);
  });

  it('Pay', () => {
    expect(() => pay('1', '0x pay')).toThrow(InvalidEntryError);
    expect(() => pay('1', 'a:b')).toThrow(InvalidEntryError);
    expect(() => pay('0', '0xpay')).toThrow(InvalidEntryError);
    expect(() =>
      recipes.rewardPayOut({
        rewardId: `campaign:${CAMPAIGN}:${USER}:x`,
        from: WALLET,
        toWallet: '0x12',
        chainTx: '0xp',
        assetId: 'USDC',
        amount: 1n,
      }),
    ).toThrow(/own wallet/);
    expect(() =>
      recipes.rewardPayOut({
        rewardId: `campaign:${CAMPAIGN}:${USER}:x`,
        from: WALLET,
        toWallet: CUSTOMER_WALLET,
        chainTx: '0xp',
        assetId: 'USDT',
        amount: 1n,
      }),
    ).toThrow(InvalidEntryError);
  });

  it('Fund', () => {
    expect(() => recipes.campaignBudgetFund({ campaignId: CAMPAIGN, decisionId: 'a b', assetId: 'USDC', amount: 1n })).toThrow(
      InvalidEntryError,
    );
    expect(() => recipes.campaignBudgetFund({ campaignId: CAMPAIGN, decisionId: 'a', assetId: 'BTC', amount: 1n })).toThrow(
      InvalidEntryError,
    );
    expect(() => recipes.campaignBudgetFund({ campaignId: CAMPAIGN, decisionId: 'a', assetId: 'USDC', amount: 0n })).toThrow(
      InvalidEntryError,
    );
  });
});
