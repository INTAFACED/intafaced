import { beforeEach, describe, expect, it } from 'vitest';
import {
  houseFees,
  merchantClearing,
  merchantProceeds,
  merchantProceedsPayoutHold,
  railBoundary,
  subAccountAvailable,
  userAvailable,
  withdrawalHoldAccount,
} from '../accounts.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { InsufficientFundsError, InvalidEntryError, isValidOwnerId, LedgerError } from '../types.js';
import { recipes } from './index.js';

/**
 * Settled merchant net lives on proceeds. Personal exits name user or
 * sub-account pots, so an empty userAvailable cannot spend proceeds.
 */

const MERCHANT = '33333333-3333-4333-8333-333333333333';
const OTHER_MERCHANT = '55555555-5555-4555-8555-555555555555';
const OWNER = '44444444-4444-4444-8444-444444444444';
const PAYEE = '66666666-6666-4666-8666-666666666666';
const SUB_A = '77777777-7777-4777-8777-777777777777';
const SUB_B = '88888888-8888-4888-8888-888888888888';
const ASSET = 'USDT';

let ledger: MemoryLedger;

beforeEach(() => {
  ledger = new MemoryLedger();
});

const proceeds = async (merchantId = MERCHANT, assetId = ASSET) =>
  formatAmount((await ledger.balance(merchantProceeds(merchantId, assetId))).amount);
const personal = async (userId = OWNER, assetId = ASSET) => formatAmount((await ledger.balance(userAvailable(userId, assetId))).amount);
const clearing = async (merchantId = MERCHANT, assetId = ASSET) =>
  formatAmount((await ledger.balance(merchantClearing(merchantId, assetId))).amount);
const fees = async (assetId = ASSET) => formatAmount((await ledger.balance(houseFees('pay', assetId))).amount);

async function capture(paymentId: string, amount: string, merchantId = MERCHANT): Promise<void> {
  await ledger.post(
    recipes.paymentCapture({
      paymentId,
      merchantId,
      assetId: ASSET,
      amount: amt(amount),
      rail: 'card-sandbox',
      railRef: `ch_${paymentId}`,
    }),
  );
}

async function settle(window: string, gross: string, fee: string, merchantId = MERCHANT): Promise<void> {
  await ledger.post(
    recipes.merchantSettlement({
      merchantId,
      merchantUserId: OWNER,
      window,
      assetId: ASSET,
      gross: amt(gross),
      fee: amt(fee),
    }),
  );
}

function namesProceeds(request: { entries: ReadonlyArray<{ account: { ownerId: string } }> }): boolean {
  return request.entries.some((entry) => entry.account.ownerId.startsWith('pay:proceeds:'));
}

describe('merchant proceeds account', () => {
  it('accepts pay:proceeds:<uuid> as a module owner and refuses a bare merchant uuid', () => {
    const ref = merchantProceeds(MERCHANT, ASSET);
    expect(ref).toEqual({ ownerType: 'module', ownerId: `pay:proceeds:${MERCHANT}`, assetId: ASSET, kind: 'available' });
    expect(isValidOwnerId('module', ref.ownerId)).toBe(true);
    expect(isValidOwnerId('module', MERCHANT)).toBe(false);
    const hold = merchantProceedsPayoutHold(MERCHANT, ASSET, `${MERCHANT}:0`);
    expect(hold.ownerId).toBe(ref.ownerId);
    expect(hold.kind).toBe('hold');
    expect(hold.purpose).toBe(`payout:${MERCHANT}:0`);
    expect(isValidOwnerId('module', hold.ownerId)).toBe(true);
  });

  it('settlement debits proceeds for net, house fees for the fee, and clearing for gross', async () => {
    await capture('pay-1', '1000');
    await settle('2026-07-27', '1000', '25');

    expect(await proceeds()).toBe('975');
    expect(await fees()).toBe('25');
    expect(await clearing()).toBe('0');
    expect(await personal()).toBe('0');
    expect(ledger.totalsByAsset()[ASSET]).toBe('0');
  });

  it('refuses a zero or negative net, and a second post of the same window returns the first transaction', async () => {
    expect(() =>
      recipes.merchantSettlement({
        merchantId: MERCHANT,
        merchantUserId: OWNER,
        window: 'w',
        assetId: ASSET,
        gross: amt('100'),
        fee: amt('100'),
      }),
    ).toThrow(InvalidEntryError);
    expect(() =>
      recipes.merchantSettlement({
        merchantId: MERCHANT,
        merchantUserId: OWNER,
        window: 'w',
        assetId: ASSET,
        gross: amt('100'),
        fee: amt('101'),
      }),
    ).toThrow(InvalidEntryError);

    await capture('pay-idem', '100');
    const body = {
      merchantId: MERCHANT,
      merchantUserId: OWNER,
      window: 'w-idem',
      assetId: ASSET,
      gross: amt('100'),
      fee: amt('1'),
    };
    const first = await ledger.post(recipes.merchantSettlement(body));
    const second = await ledger.post(recipes.merchantSettlement(body));
    expect(second.id).toBe(first.id);
    expect(await proceeds()).toBe('99');
  });

  it('keeps two merchants of one user on two proceeds balances', async () => {
    await capture('pay-a', '40', MERCHANT);
    await capture('pay-b', '15', OTHER_MERCHANT);
    await settle('w', '40', '0', MERCHANT);
    await settle('w', '15', '0', OTHER_MERCHANT);
    expect(await proceeds(MERCHANT)).toBe('40');
    expect(await proceeds(OTHER_MERCHANT)).toBe('15');
    expect(await personal()).toBe('0');
  });

  it('a settled refund credits proceeds and the reverse returns to that pot; clearing refunds stay on clearing', async () => {
    await capture('pay-c', '100');
    await ledger.post(
      recipes.paymentRefund({
        refundId: 'c1',
        paymentId: 'pay-c',
        merchantId: MERCHANT,
        merchantUserId: OWNER,
        assetId: ASSET,
        amount: amt('10'),
        rail: 'card-sandbox',
        source: 'clearing',
      }),
    );
    expect(await clearing()).toBe('90');
    expect(await proceeds()).toBe('0');

    await settle('w-c', '90', '0');
    const settled = {
      refundId: 'c2',
      paymentId: 'pay-c',
      merchantId: MERCHANT,
      merchantUserId: OWNER,
      assetId: ASSET,
      amount: amt('25'),
      rail: 'card-sandbox',
      source: 'settled' as const,
    };
    await ledger.post(recipes.paymentRefund(settled));
    expect(await proceeds()).toBe('65');
    expect(await personal()).toBe('0');
    await ledger.post(recipes.paymentRefundReverse(settled));
    expect(await proceeds()).toBe('90');
    expect(await personal()).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a settled refund with the pre-cutover pot credits userAvailable and the reverse returns there', async () => {
    await capture('pay-old-refund', '40');
    await ledger.post({
      idempotencyKey: `settlement:${MERCHANT}:w-old-refund:${ASSET}`,
      module: 'pay',
      reason: 'pay.settled',
      meta: { merchantId: MERCHANT, window: 'w-old-refund', assetId: ASSET },
      entries: [
        { account: merchantClearing(MERCHANT, ASSET), direction: 'credit', amount: amt('40') },
        { account: userAvailable(OWNER, ASSET), direction: 'debit', amount: amt('40') },
      ],
    });
    const settled = {
      refundId: 'old-1',
      paymentId: 'pay-old-refund',
      merchantId: MERCHANT,
      merchantUserId: OWNER,
      assetId: ASSET,
      amount: amt('15'),
      rail: 'card-sandbox',
      source: 'settled' as const,
      settledPot: 'user' as const,
    };
    const forward = recipes.paymentRefund(settled);
    expect(forward.entries[0]?.account).toEqual(userAvailable(OWNER, ASSET));
    expect(forward.meta).not.toHaveProperty('settledPot');
    await ledger.post(forward);
    expect(await personal()).toBe('25');
    expect(await proceeds()).toBe('0');
    await ledger.post(recipes.paymentRefundReverse(settled));
    expect(await personal()).toBe('40');
    expect(await proceeds()).toBe('0');

    const opened = recipes.chargebackOpen({
      disputeId: 'dp-old',
      paymentId: 'pay-old-refund',
      merchantId: MERCHANT,
      merchantUserId: OWNER,
      assetId: ASSET,
      rail: 'card-sandbox',
      fromClearing: amt('0'),
      fromMerchantBalance: amt('10'),
      settledPot: 'user',
    });
    expect(opened.entries[0]?.account).toEqual(userAvailable(OWNER, ASSET));
    expect(opened.meta).not.toHaveProperty('settledPot');
    await ledger.post(opened);
    expect(await personal()).toBe('30');
    expect(await proceeds()).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a settled refund larger than proceeds fails and does not debit the personal balance', async () => {
    await capture('pay-short', '100');
    await settle('w-short', '100', '10');
    await ledger.post(recipes.deposit({ userId: OWNER, assetId: ASSET, amount: amt('500'), rail: 'test', railRef: 'personal' }));
    expect(await proceeds()).toBe('90');
    expect(await personal()).toBe('500');

    await expect(
      ledger.post(
        recipes.paymentRefund({
          refundId: 'short',
          paymentId: 'pay-short',
          merchantId: MERCHANT,
          merchantUserId: OWNER,
          assetId: ASSET,
          amount: amt('100'),
          rail: 'card-sandbox',
          source: 'settled',
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientFundsError);

    expect(await proceeds()).toBe('90');
    expect(await personal()).toBe('500');
  });

  it('chargeback open and won move the settled leg on proceeds and leave the personal balance alone', async () => {
    await capture('pay-cb', '80');
    await settle('w-cb', '80', '0');
    await ledger.post(
      recipes.chargebackOpen({
        disputeId: 'dp-1',
        paymentId: 'pay-cb',
        merchantId: MERCHANT,
        merchantUserId: OWNER,
        assetId: ASSET,
        rail: 'card-sandbox',
        fromClearing: amt('0'),
        fromMerchantBalance: amt('30'),
      }),
    );
    expect(await proceeds()).toBe('50');
    expect(await personal()).toBe('0');

    await ledger.post(
      recipes.chargebackWon({
        disputeId: 'dp-1',
        paymentId: 'pay-cb',
        merchantId: MERCHANT,
        merchantUserId: OWNER,
        assetId: ASSET,
        rail: 'card-sandbox',
        fromClearing: amt('0'),
        fromMerchantBalance: amt('30'),
      }),
    );
    expect(await proceeds()).toBe('80');
    expect(await personal()).toBe('0');
  });

  it('shortfall names the insurance fund and does not touch proceeds or a user balance', () => {
    const request = recipes.chargebackShortfall({
      disputeId: 'dp-sf',
      paymentId: 'pay-sf',
      merchantId: MERCHANT,
      assetId: ASSET,
      rail: 'card-sandbox',
      amount: amt('40'),
    });
    expect(request.entries.map((entry) => `${entry.account.ownerType}:${entry.account.ownerId}:${entry.direction}`)).toEqual([
      'house:insurance-fund:credit',
      'treasury:rail:card-sandbox:debit',
    ]);
  });

  it('payout hold, settle, and reverse round-trip proceeds and leave the personal balance', async () => {
    await capture('pay-po', '50');
    await settle('w-po', '50', '0');
    await ledger.post(recipes.deposit({ userId: OWNER, assetId: ASSET, amount: amt('7'), rail: 'test', railRef: 'kept' }));
    const payout = {
      merchantId: MERCHANT,
      assetId: ASSET,
      amount: amt('20'),
      rail: 'crypto-native',
      withdrawalId: 'settlement-1:0',
    };

    await ledger.post(recipes.merchantProceedsPayoutHold(payout));
    expect(await proceeds()).toBe('30');
    expect(formatAmount((await ledger.balance(merchantProceedsPayoutHold(MERCHANT, ASSET, payout.withdrawalId))).amount)).toBe('20');
    expect(await personal()).toBe('7');

    await ledger.post(recipes.merchantProceedsPayoutReverse(payout));
    expect(await proceeds()).toBe('50');
    expect(formatAmount((await ledger.balance(merchantProceedsPayoutHold(MERCHANT, ASSET, payout.withdrawalId))).amount)).toBe('0');
    expect(await personal()).toBe('7');

    const sent = { ...payout, withdrawalId: 'settlement-1:1' };
    await ledger.post(recipes.merchantProceedsPayoutHold(sent));
    await ledger.post(recipes.merchantProceedsPayoutSettle(sent));
    expect(await proceeds()).toBe('30');
    expect(formatAmount((await ledger.balance(merchantProceedsPayoutHold(MERCHANT, ASSET, sent.withdrawalId))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(railBoundary('crypto-native', ASSET))).amount)).toBe('20');
    expect(await personal()).toBe('7');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('refuses a post that credits proceeds and debits a user withdrawal hold', async () => {
    await capture('pay-lock', '10');
    await settle('w-lock', '10', '0');
    await expect(
      ledger.post({
        idempotencyKey: 'unfunded-user-hold',
        module: 'pay',
        reason: 'pay.proceeds.payout.held',
        entries: [
          { account: merchantProceeds(MERCHANT, ASSET), direction: 'credit', amount: amt('10') },
          { account: withdrawalHoldAccount(OWNER, ASSET, 'w'), direction: 'debit', amount: amt('10') },
        ],
      }),
    ).rejects.toThrow(/Unfunded lock/);
    expect(await proceeds()).toBe('10');
    expect(await personal()).toBe('0');
  });

  it('replay of a pre-cutover settlement key does not also credit proceeds', async () => {
    await capture('pay-old', '100');
    const key = `settlement:${MERCHANT}:w-old:${ASSET}`;
    const historical = {
      idempotencyKey: key,
      module: 'pay',
      reason: 'pay.settled',
      meta: { merchantId: MERCHANT, window: 'w-old', assetId: ASSET },
      entries: [
        { account: merchantClearing(MERCHANT, ASSET), direction: 'credit' as const, amount: amt('100') },
        { account: userAvailable(OWNER, ASSET), direction: 'debit' as const, amount: amt('100') },
      ],
    };
    const first = await ledger.post(historical);
    const sameBody = await ledger.post(historical);
    expect(sameBody.id).toBe(first.id);

    await expect(
      ledger.post(
        recipes.merchantSettlement({
          merchantId: MERCHANT,
          merchantUserId: OWNER,
          window: 'w-old',
          assetId: ASSET,
          gross: amt('100'),
          fee: amt('0'),
        }),
      ),
    ).rejects.toBeInstanceOf(LedgerError);

    expect(await personal()).toBe('100');
    expect(await proceeds()).toBe('0');
    expect(await clearing()).toBe('0');
    expect(ledger.journal()).toHaveLength(2);
  });
});

describe('personal exits cannot spend proceeds', () => {
  beforeEach(async () => {
    await capture('pay-exit', '80');
    await settle('w-exit', '80', '0');
    expect(await proceeds()).toBe('80');
    expect(await personal()).toBe('0');
  });

  const unchanged = async () => {
    expect(await proceeds()).toBe('80');
    expect(await personal()).toBe('0');
  };

  it('card and personal withdrawHold fail insufficient funds', async () => {
    const request = recipes.withdrawHold({
      userId: OWNER,
      assetId: ASSET,
      amount: amt('10'),
      rail: 'card-sandbox',
      withdrawalId: 'card-1',
    });
    expect(namesProceeds(request)).toBe(false);
    await expect(ledger.post(request)).rejects.toBeInstanceOf(InsufficientFundsError);
    await unchanged();
  });

  it('bank transfer from the primary space and pay-by-handle fail insufficient funds', async () => {
    const from = userAvailable(OWNER, ASSET);
    const to = userAvailable(PAYEE, ASSET);
    for (const [transferId, kind] of [
      ['bank-1', 'manual'],
      ['sched-1', 'scheduled'],
      ['handle-1', 'manual'],
    ] as const) {
      const request = recipes.bankTransfer({
        transferId,
        occurrence: 0,
        from,
        to,
        amount: amt('10'),
        kind,
        lane: kind === 'scheduled' ? 'sched' : 'p2p',
      });
      expect(namesProceeds(request)).toBe(false);
      expect(request.entries[0]?.account).toEqual(from);
      await expect(ledger.post(request)).rejects.toBeInstanceOf(InsufficientFundsError);
    }
    await unchanged();
  });

  it('spot orderHold and derivatives margin lock fail insufficient funds', async () => {
    const order = recipes.orderHold({ orderId: 'o-1', userId: OWNER, assetId: ASSET, amount: amt('10') });
    const margin = recipes.futuresMarginLock({ positionId: 'pos-1', userId: OWNER, assetId: ASSET, amount: amt('10') });
    expect(namesProceeds(order)).toBe(false);
    expect(namesProceeds(margin)).toBe(false);
    await expect(ledger.post(order)).rejects.toBeInstanceOf(InsufficientFundsError);
    await expect(ledger.post(margin)).rejects.toBeInstanceOf(InsufficientFundsError);
    await unchanged();
  });

  it('P2P escrow, stake, and earn fail insufficient funds', async () => {
    const escrow = recipes.escrowLock({ tradeId: 't-1', sellerId: OWNER, buyerId: PAYEE, assetId: ASSET, amount: amt('10') });
    const staked = recipes.stake({ stakeId: 's-1', userId: OWNER, assetId: ASSET, amount: amt('10'), tier: 'flex' });
    const earn = recipes.earnDeposit({ positionId: 'e-1', poolId: 'pool-1', userId: OWNER, assetId: ASSET, amount: amt('10') });
    expect(namesProceeds(escrow)).toBe(false);
    expect(namesProceeds(staked)).toBe(false);
    expect(namesProceeds(earn)).toBe(false);
    await expect(ledger.post(escrow)).rejects.toBeInstanceOf(InsufficientFundsError);
    await expect(ledger.post(staked)).rejects.toBeInstanceOf(InsufficientFundsError);
    await expect(ledger.post(earn)).rejects.toBeInstanceOf(InsufficientFundsError);
    await unchanged();
  });

  it('a sub-account move is between sub-account pots and cannot name proceeds', async () => {
    const request = recipes.subAccountTransfer({
      transferId: 'sub-1',
      fromSubAccountId: SUB_A,
      toSubAccountId: SUB_B,
      assetId: ASSET,
      amount: amt('10'),
    });
    expect(namesProceeds(request)).toBe(false);
    expect(request.entries.map((entry) => entry.account)).toEqual([subAccountAvailable(SUB_A, ASSET), subAccountAvailable(SUB_B, ASSET)]);
    await expect(ledger.post(request)).rejects.toBeInstanceOf(InsufficientFundsError);
    await unchanged();
  });
});
