/**
 * S2S `/trpc/post` recipe allowlist.
 *
 * Callers still send a PostRequest (ledger-client types have no recipe field).
 * This gate refuses assembled entries whose (module, reason, legs) are not a
 * registry recipe — so a module cannot open a second book on the HTTP door.
 */
import {
  LedgerError,
  marketMaker,
  parseAmount,
  railBoundary,
  recipes,
  rewardsEngine,
  subAccountAvailable,
  userAvailable,
  type PostRequest,
  type RecipeName,
} from '@intafaced/ledger-client';

export const RECIPE_REQUIRED_CODE = 'ledger.recipe_required';

type WireEntry = {
  account: { ownerType: string; kind: string; ownerId?: string; purpose?: string };
  direction: string;
};

type WirePost = {
  module: string;
  reason: string;
  entries: readonly WireEntry[];
};

type RepeatRule = {
  /** Legs that stay fixed while a tail grows (payroll recipients, earn payouts). */
  prefix: readonly string[];
  tokens: ReadonlySet<string>;
  minTail: number;
};

type CatalogRow = {
  name: RecipeName;
  minLegs: number;
  signatures: ReadonlySet<string>;
  repeats: readonly RepeatRule[];
};

const U = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const U2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const U3 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const S1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const S2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const S3 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const AMT = parseAmount('10');
const QUOTE = parseAmount('100');
const CAMPAIGN_REWARD_KEY = `task:${S1}:${U}:once`;

const VARIABLE_REASON_RECIPES: ReadonlySet<RecipeName> = new Set(['feeCharge', 'rewardPay']);

function purposeHead(purpose: string | undefined): string {
  if (!purpose) return '';
  return purpose.split(':')[0] ?? '';
}

/**
 * Platform helpers store the role in ownerId (`purpose` is empty).
 * House, module, treasury, and any other non-caller owner keep that id, so
 * `fees:trade` and `insurance-fund` cannot share a leg. Two segments stay
 * whole (`bank:loan-reserve`, `fees:bank`). A third segment is an instance id
 * (`pay:clearing:<merchant>`, `bank:earn:<pool>`) and stays out.
 * Treasury seams are the ownerId head (`mint`, `rail:<rail>`, `bridge:<chain>`).
 * User and subaccount ids stay out so a real recipe accepts the caller.
 */
function accountRole(account: WireEntry['account']): string {
  if (account.ownerType === 'user' || account.ownerType === 'subaccount') return '';
  const ownerId = account.ownerId ?? '';
  const parts = ownerId.split(':');
  if (ownerId.length === 0 || parts.some((part) => part.length === 0)) return ownerId;
  if (account.ownerType === 'treasury') {
    if (parts.length === 1) return ownerId;
    return `${parts[0]}:*`;
  }
  if (parts.length <= 2) return ownerId;
  return `${parts.slice(0, -1).join(':')}:*`;
}

function legSignature(entry: WireEntry): string {
  return `${entry.account.ownerType}|${entry.account.kind}|${entry.direction}|${purposeHead(entry.account.purpose)}|${accountRole(entry.account)}`;
}

function recipeError(module: string, reason: string): LedgerError {
  return new LedgerError(
    `POST /trpc/post only accepts ledger-client recipes; '${module}/${reason}' is not a known recipe`,
    RECIPE_REQUIRED_CODE,
  );
}

function isHouseFees(account: WireEntry['account']): boolean {
  return account.ownerType === 'house' && account.kind === 'available' && (account.ownerId ?? '').startsWith('fees:');
}

function isRewardsEngine(account: WireEntry['account']): boolean {
  return account.ownerType === 'house' && account.kind === 'available' && account.ownerId === 'rewards-engine';
}

/** feeCharge: user available credit → house fees debit. Module and reason are caller-chosen. */
function matchesFeeCharge(input: WirePost): boolean {
  if (input.entries.length !== 2) return false;
  const [a, b] = input.entries;
  return (
    a !== undefined &&
    b !== undefined &&
    a.direction === 'credit' &&
    a.account.ownerType === 'user' &&
    a.account.kind === 'available' &&
    b.direction === 'debit' &&
    isHouseFees(b.account)
  );
}

/**
 * token.fee.swept: any module fee pot credit → rewards engine debit.
 * The source module is caller-chosen, so it is not one catalog signature.
 */
function matchesFeeSweep(input: WirePost): boolean {
  if (input.module !== 'token' || input.reason !== 'token.fee.swept' || input.entries.length !== 2) return false;
  const [a, b] = input.entries;
  return (
    a !== undefined &&
    b !== undefined &&
    a.direction === 'credit' &&
    isHouseFees(a.account) &&
    b.direction === 'debit' &&
    isRewardsEngine(b.account)
  );
}

/** rewardPay: rewards engine credit → user available debit. Module is always token; reason is caller-chosen. */
function matchesRewardPay(input: WirePost): boolean {
  if (input.module !== 'token' || input.entries.length !== 2) return false;
  const [a, b] = input.entries;
  return (
    a !== undefined &&
    b !== undefined &&
    a.direction === 'credit' &&
    isRewardsEngine(a.account) &&
    b.direction === 'debit' &&
    b.account.ownerType === 'user' &&
    b.account.kind === 'available'
  );
}

function samplePosts(): Array<{ name: RecipeName; post: PostRequest }> {
  const hold = { orderId: 'o1', userId: U, assetId: 'USDT', amount: AMT };
  const mmHold = { orderId: 'o1', assetId: 'USDT', amount: AMT };
  const fill = {
    fillId: 'f1',
    makerId: U2,
    takerId: U,
    makerOrderId: 'mo',
    takerOrderId: 'to',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    qty: AMT,
    quoteAmount: QUOTE,
    takerSide: 'buy' as const,
  };
  const withdraw = { userId: U, assetId: 'USDT', amount: AMT, rail: 'crypto-native', withdrawalId: 'w1' };
  const escrow = { tradeId: 't1', sellerId: U, buyerId: U2, assetId: 'USDT', amount: AMT };
  const capture = {
    paymentId: 'p1',
    merchantId: 'm1',
    assetId: 'USDT',
    amount: AMT,
    rail: 'card-sandbox',
    railRef: 'r1',
  };
  const refund = {
    refundId: 'rf1',
    paymentId: 'p1',
    merchantId: 'm1',
    merchantUserId: U,
    assetId: 'USDT',
    amount: AMT,
    rail: 'card-sandbox',
    source: 'clearing' as const,
  };
  const chargeback = {
    disputeId: 'd1',
    paymentId: 'p1',
    merchantId: 'm1',
    merchantUserId: U,
    assetId: 'USDT',
    rail: 'card-sandbox',
    fromClearing: AMT,
    fromMerchantBalance: 0n,
  };
  const shortfall = {
    disputeId: 'd1',
    paymentId: 'p1',
    merchantId: 'm1',
    assetId: 'USDT',
    rail: 'card-sandbox',
    amount: AMT,
  };
  const stakeIn = { stakeId: 's1', userId: U, assetId: 'IFC', amount: AMT, tier: 'flex' as const };
  const earn = { positionId: 'ep1', poolId: 'pool1', userId: U, assetId: 'USDT', amount: AMT };
  const loanCol = { loanId: 'ln1', userId: U, collateralAssetId: 'BTC', amount: AMT, sequence: 0 };
  const fromAvail = userAvailable(U, 'USDT');
  const toAvail = userAvailable(U2, 'USDT');

  return [
    { name: 'deposit', post: recipes.deposit({ userId: U, assetId: 'USDT', amount: AMT, rail: 'crypto-native', railRef: 'tx1' }) },
    {
      name: 'depositReverse',
      post: recipes.depositReverse({
        userId: U,
        assetId: 'USDT',
        amount: AMT,
        rail: 'crypto-native',
        railRef: 'tx1',
        depositId: 'dep1',
      }),
    },
    { name: 'marketMakerSeedFund', post: recipes.marketMakerSeedFund({ assetId: 'USDT', amount: AMT, seedId: 'seed1' }) },
    { name: 'withdrawHold', post: recipes.withdrawHold(withdraw) },
    { name: 'withdrawSettle', post: recipes.withdrawSettle(withdraw) },
    // With the quoted network fee (J-wallet-05 #6): the hold also pays houseFees(pay) in the same posting.
    { name: 'withdrawSettle', post: recipes.withdrawSettle({ ...withdraw, fee: AMT }) },
    { name: 'withdrawReverse', post: recipes.withdrawReverse(withdraw) },
    { name: 'withdrawReturned', post: recipes.withdrawReturned(withdraw) },
    { name: 'tradeFill', post: recipes.tradeFill({ ...fill, makerFeeBps: 0, takerFeeBps: 0 }) },
    { name: 'tradeFill', post: recipes.tradeFill({ ...fill, makerFeeBps: 10, takerFeeBps: 10 }) },
    { name: 'orderHold', post: recipes.orderHold(hold) },
    { name: 'orderHoldRelease', post: recipes.orderHoldRelease(hold) },
    { name: 'orderHoldAmend', post: recipes.orderHoldAmend({ ...hold, sequence: 1 }) },
    { name: 'marketMakerOrderHold', post: recipes.marketMakerOrderHold(mmHold) },
    { name: 'marketMakerOrderHoldRelease', post: recipes.marketMakerOrderHoldRelease(mmHold) },
    { name: 'marketMakerMakerFill', post: recipes.marketMakerMakerFill({ ...fill, makerFeeBps: 0, takerFeeBps: 0 }) },
    { name: 'futuresMarginLock', post: recipes.futuresMarginLock({ positionId: 'pos1', userId: U, assetId: 'USDT', amount: AMT }) },
    {
      name: 'futuresMarginAdd',
      post: recipes.futuresMarginAdd({ positionId: 'pos1', userId: U, assetId: 'USDT', amount: AMT, sequence: 1 }),
    },
    { name: 'futuresMarginRelease', post: recipes.futuresMarginRelease({ positionId: 'pos1', userId: U, assetId: 'USDT', amount: AMT }) },
    // A reducing futures fill pays its trading fee from the position pot in the release posting, or from what the
    // pot holds when the loss took the rest of the margin (amount zero).
    {
      name: 'futuresMarginRelease',
      post: recipes.futuresMarginRelease({ positionId: 'pos1', userId: U, assetId: 'USDT', amount: AMT, fee: AMT }),
    },
    {
      name: 'futuresMarginRelease',
      post: recipes.futuresMarginRelease({ positionId: 'pos1', userId: U, assetId: 'USDT', amount: 0n, fee: AMT }),
    },
    {
      name: 'futuresOrderMarginHold',
      post: recipes.futuresOrderMarginHold({ orderId: 'o1', userId: U, assetId: 'USDT', amount: AMT }),
    },
    {
      name: 'futuresOrderMarginRelease',
      post: recipes.futuresOrderMarginRelease({ orderId: 'o1', userId: U, assetId: 'USDT', amount: AMT }),
    },
    {
      name: 'futuresOrderMarginApply',
      post: recipes.futuresOrderMarginApply({
        orderId: 'o1',
        userId: U,
        assetId: 'USDT',
        positionId: 'pos1',
        fillId: 'm1:1:pos1',
        amount: AMT,
      }),
    },
    {
      name: 'futuresOrderMarginApply',
      post: recipes.futuresOrderMarginApply({
        orderId: 'o1',
        userId: U,
        assetId: 'USDT',
        positionId: 'pos1',
        fillId: 'm1:1:pos1',
        amount: AMT,
        releaseAmount: AMT,
      }),
    },
    // An opening futures fill pays its trading fee from the order hold in the fill posting.
    {
      name: 'futuresOrderMarginApply',
      post: recipes.futuresOrderMarginApply({
        orderId: 'o1',
        userId: U,
        assetId: 'USDT',
        positionId: 'pos1',
        fillId: 'm1:1:pos1',
        amount: AMT,
        fee: AMT,
      }),
    },
    {
      name: 'futuresOrderMarginApply',
      post: recipes.futuresOrderMarginApply({
        orderId: 'o1',
        userId: U,
        assetId: 'USDT',
        positionId: 'pos1',
        fillId: 'm1:1:pos1',
        amount: AMT,
        releaseAmount: AMT,
        fee: AMT,
      }),
    },
    {
      name: 'futuresRealizeLoss',
      post: recipes.futuresRealizeLoss({
        positionId: 'pos1',
        userId: U,
        assetId: 'USDT',
        fromMargin: AMT,
        fromInsurance: 0n,
        lossId: 'l1',
      }),
    },
    {
      name: 'futuresRealizeLoss',
      post: recipes.futuresRealizeLoss({
        positionId: 'pos1',
        userId: U,
        assetId: 'USDT',
        fromMargin: 0n,
        fromInsurance: AMT,
        lossId: 'l2',
      }),
    },
    {
      name: 'futuresRealizeProfit',
      post: recipes.futuresRealizeProfit({ positionId: 'pos1', userId: U, assetId: 'USDT', amount: AMT, profitId: 'pr1' }),
    },
    {
      name: 'futuresFundingPay',
      post: recipes.futuresFundingPay({
        fundingId: 'fund1',
        payerUserId: U,
        payerPositionId: 'p1',
        payeeUserId: U2,
        payeePositionId: 'p2',
        assetId: 'USDT',
        amount: AMT,
      }),
    },
    { name: 'futuresInsuranceTopup', post: recipes.futuresInsuranceTopup({ topupId: 'tu1', assetId: 'USDT', amount: AMT }) },
    { name: 'escrowLock', post: recipes.escrowLock(escrow) },
    { name: 'escrowRelease', post: recipes.escrowRelease({ ...escrow, feeBps: 0 }) },
    { name: 'escrowRelease', post: recipes.escrowRelease({ ...escrow, feeBps: 50 }) },
    { name: 'escrowRefund', post: recipes.escrowRefund(escrow) },
    { name: 'paymentCapture', post: recipes.paymentCapture(capture) },
    {
      name: 'merchantSettlement',
      post: recipes.merchantSettlement({
        merchantId: 'm1',
        merchantUserId: U,
        window: '2026-07-27',
        assetId: 'USDT',
        gross: QUOTE,
        fee: 0n,
      }),
    },
    {
      name: 'merchantSettlement',
      post: recipes.merchantSettlement({
        merchantId: 'm1',
        merchantUserId: U,
        window: '2026-07-27',
        assetId: 'USDT',
        gross: QUOTE,
        fee: AMT,
      }),
    },
    { name: 'paymentRefund', post: recipes.paymentRefund(refund) },
    { name: 'paymentRefund', post: recipes.paymentRefund({ ...refund, source: 'settled' }) },
    { name: 'paymentRefund', post: recipes.paymentRefund({ ...refund, source: 'settled', settledPot: 'user' }) },
    { name: 'paymentRefundReverse', post: recipes.paymentRefundReverse(refund) },
    { name: 'paymentRefundReverse', post: recipes.paymentRefundReverse({ ...refund, source: 'settled' }) },
    { name: 'paymentRefundReverse', post: recipes.paymentRefundReverse({ ...refund, source: 'settled', settledPot: 'user' }) },
    {
      name: 'merchantProceedsPayoutHold',
      post: recipes.merchantProceedsPayoutHold({
        merchantId: 'm1',
        assetId: 'USDT',
        amount: AMT,
        rail: 'crypto-native',
        withdrawalId: 'w1',
      }),
    },
    {
      name: 'merchantProceedsPayoutSettle',
      post: recipes.merchantProceedsPayoutSettle({
        merchantId: 'm1',
        assetId: 'USDT',
        amount: AMT,
        rail: 'crypto-native',
        withdrawalId: 'w1',
      }),
    },
    {
      name: 'merchantProceedsPayoutReverse',
      post: recipes.merchantProceedsPayoutReverse({
        merchantId: 'm1',
        assetId: 'USDT',
        amount: AMT,
        rail: 'crypto-native',
        withdrawalId: 'w1',
      }),
    },
    {
      name: 'fxConversion',
      post: recipes.fxConversion({
        conversionId: 'cv1',
        merchantId: 'm1',
        merchantUserId: U,
        venueId: 'binance-spot',
        fromAsset: 'USD',
        toAsset: 'USDT',
        fromAmount: AMT,
        toAmount: AMT,
        feeAmount: AMT,
        spreadAmount: AMT,
      }),
    },
    {
      name: 'fxConversion',
      post: recipes.fxConversion({
        conversionId: 'cv1f',
        merchantId: 'm1',
        merchantUserId: U,
        venueId: 'binance-spot',
        fromAsset: 'USD',
        toAsset: 'USDT',
        fromAmount: AMT,
        toAmount: AMT,
        feeAmount: AMT,
        spreadAmount: 0n,
      }),
    },
    {
      name: 'fxConversion',
      post: recipes.fxConversion({
        conversionId: 'cv1s',
        merchantId: 'm1',
        merchantUserId: U,
        venueId: 'binance-spot',
        fromAsset: 'USD',
        toAsset: 'USDT',
        fromAmount: AMT,
        toAmount: AMT,
        feeAmount: 0n,
        spreadAmount: AMT,
      }),
    },
    {
      name: 'fxConversion',
      post: recipes.fxConversion({
        conversionId: 'cv1z',
        merchantId: 'm1',
        merchantUserId: U,
        venueId: 'binance-spot',
        fromAsset: 'USD',
        toAsset: 'USDT',
        fromAmount: AMT,
        toAmount: AMT,
        feeAmount: 0n,
        spreadAmount: 0n,
      }),
    },
    {
      name: 'fxConversionReverse',
      post: recipes.fxConversionReverse({
        conversionId: 'cv1',
        merchantId: 'm1',
        merchantUserId: U,
        venueId: 'binance-spot',
        fromAsset: 'USD',
        toAsset: 'USDT',
        fromAmount: AMT,
        toAmount: AMT,
        feeAmount: AMT,
        spreadAmount: AMT,
      }),
    },
    {
      name: 'fxConversionReverse',
      post: recipes.fxConversionReverse({
        conversionId: 'cv1f',
        merchantId: 'm1',
        merchantUserId: U,
        venueId: 'binance-spot',
        fromAsset: 'USD',
        toAsset: 'USDT',
        fromAmount: AMT,
        toAmount: AMT,
        feeAmount: AMT,
        spreadAmount: 0n,
      }),
    },
    {
      name: 'fxConversionReverse',
      post: recipes.fxConversionReverse({
        conversionId: 'cv1s',
        merchantId: 'm1',
        merchantUserId: U,
        venueId: 'binance-spot',
        fromAsset: 'USD',
        toAsset: 'USDT',
        fromAmount: AMT,
        toAmount: AMT,
        feeAmount: 0n,
        spreadAmount: AMT,
      }),
    },
    {
      name: 'fxConversionReverse',
      post: recipes.fxConversionReverse({
        conversionId: 'cv1z',
        merchantId: 'm1',
        merchantUserId: U,
        venueId: 'binance-spot',
        fromAsset: 'USD',
        toAsset: 'USDT',
        fromAmount: AMT,
        toAmount: AMT,
        feeAmount: 0n,
        spreadAmount: 0n,
      }),
    },
    {
      name: 'fxConversionHold',
      post: recipes.fxConversionHold({ conversionId: 'cv-hold', merchantId: 'm1', fromAsset: 'USD', amount: AMT }),
    },
    {
      name: 'fxConversionRelease',
      post: recipes.fxConversionRelease({ conversionId: 'cv-hold', merchantId: 'm1', fromAsset: 'USD', amount: AMT }),
    },
    {
      name: 'fxConversionRelease',
      post: recipes.fxConversionRelease({ conversionId: 'cv-rem', merchantId: 'm1', fromAsset: 'USD', amount: AMT, sequence: 1 }),
    },
    {
      name: 'fxConversionLateFill',
      post: recipes.fxConversionLateFill({
        auditId: 'audit-m',
        conversionId: 'cv-late',
        merchantId: 'm1',
        merchantUserId: U,
        venueId: 'binance-spot',
        fromAsset: 'USD',
        toAsset: 'USDT',
        fromAmount: AMT,
        toAmount: AMT,
        feeAmount: AMT,
        spreadAmount: AMT,
        funding: 'merchant',
      }),
    },
    {
      name: 'fxConversionLateFill',
      post: recipes.fxConversionLateFill({
        auditId: 'audit-mf',
        conversionId: 'cv-late-f',
        merchantId: 'm1',
        merchantUserId: U,
        venueId: 'binance-spot',
        fromAsset: 'USD',
        toAsset: 'USDT',
        fromAmount: AMT,
        toAmount: AMT,
        feeAmount: AMT,
        spreadAmount: 0n,
        funding: 'merchant',
      }),
    },
    {
      name: 'fxConversionLateFill',
      post: recipes.fxConversionLateFill({
        auditId: 'audit-ms',
        conversionId: 'cv-late-s',
        merchantId: 'm1',
        merchantUserId: U,
        venueId: 'binance-spot',
        fromAsset: 'USD',
        toAsset: 'USDT',
        fromAmount: AMT,
        toAmount: AMT,
        feeAmount: 0n,
        spreadAmount: AMT,
        funding: 'merchant',
      }),
    },
    {
      name: 'fxConversionLateFill',
      post: recipes.fxConversionLateFill({
        auditId: 'audit-mz',
        conversionId: 'cv-late-z',
        merchantId: 'm1',
        merchantUserId: U,
        venueId: 'binance-spot',
        fromAsset: 'USD',
        toAsset: 'USDT',
        fromAmount: AMT,
        toAmount: AMT,
        feeAmount: 0n,
        spreadAmount: 0n,
        funding: 'merchant',
      }),
    },
    // Inventory funding is four legs: fx-inventory USD, both venue boundaries,
    // fx-inventory USDT for the gross. Fee and spread change the gross, not the
    // accounts. A merchant credit or a fee leg under late_shortfall is not sampled.
    {
      name: 'fxConversionLateFill',
      post: recipes.fxConversionLateFill({
        auditId: 'audit-i',
        conversionId: 'cv-late-i',
        merchantId: 'm1',
        merchantUserId: U,
        venueId: 'binance-spot',
        fromAsset: 'USD',
        toAsset: 'USDT',
        fromAmount: AMT,
        toAmount: AMT,
        feeAmount: AMT,
        spreadAmount: AMT,
        funding: 'inventory',
      }),
    },
    {
      name: 'fxConversionLateFill',
      post: recipes.fxConversionLateFill({
        auditId: 'audit-if',
        conversionId: 'cv-late-if',
        merchantId: 'm1',
        merchantUserId: U,
        venueId: 'binance-spot',
        fromAsset: 'USD',
        toAsset: 'USDT',
        fromAmount: AMT,
        toAmount: AMT,
        feeAmount: AMT,
        spreadAmount: 0n,
        funding: 'inventory',
      }),
    },
    {
      name: 'fxConversionLateFill',
      post: recipes.fxConversionLateFill({
        auditId: 'audit-is',
        conversionId: 'cv-late-is',
        merchantId: 'm1',
        merchantUserId: U,
        venueId: 'binance-spot',
        fromAsset: 'USD',
        toAsset: 'USDT',
        fromAmount: AMT,
        toAmount: AMT,
        feeAmount: 0n,
        spreadAmount: AMT,
        funding: 'inventory',
      }),
    },
    {
      name: 'fxConversionLateFill',
      post: recipes.fxConversionLateFill({
        auditId: 'audit-iz',
        conversionId: 'cv-late-iz',
        merchantId: 'm1',
        merchantUserId: U,
        venueId: 'binance-spot',
        fromAsset: 'USD',
        toAsset: 'USDT',
        fromAmount: AMT,
        toAmount: AMT,
        feeAmount: 0n,
        spreadAmount: 0n,
        funding: 'inventory',
      }),
    },
    { name: 'chargebackOpen', post: recipes.chargebackOpen(chargeback) },
    {
      name: 'chargebackOpen',
      post: recipes.chargebackOpen({ ...chargeback, fromClearing: 0n, fromMerchantBalance: AMT, settledPot: 'user' }),
    },
    { name: 'chargebackOpen', post: recipes.chargebackOpen({ ...chargeback, fromClearing: 0n, fromMerchantBalance: AMT }) },
    { name: 'chargebackShortfall', post: recipes.chargebackShortfall(shortfall) },
    { name: 'chargebackWon', post: recipes.chargebackWon(chargeback) },
    { name: 'chargebackShortfallRecovered', post: recipes.chargebackShortfallRecovered(shortfall) },
    { name: 'stake', post: recipes.stake(stakeIn) },
    { name: 'unstake', post: recipes.unstake(stakeIn) },
    {
      name: 'mintEmission',
      post: recipes.mintEmission({ epoch: 1, assetId: 'IFC', amount: AMT, destination: userAvailable(U, 'IFC') }),
    },
    { name: 'burn', post: recipes.burn({ runId: 'b1', assetId: 'IFC', amount: AMT, from: userAvailable(U, 'IFC') }) },
    {
      name: 'feeCharge',
      post: recipes.feeCharge({ chargeId: 'c1', userId: U, module: 'trade', mode: 'asset', assetId: 'USDT', amount: AMT }),
    },
    {
      name: 'sweepFeesToRewards',
      post: recipes.sweepFeesToRewards({ windowId: 'w1', sourceModule: 'trade', assetId: 'USDT', amount: AMT }),
    },
    {
      name: 'rewardPay',
      post: recipes.rewardPay({ rewardId: 'rw1', userId: U, assetId: 'USDT', amount: AMT, reason: 'token.yield.distributed' }),
    },
    { name: 'loanCollateralLock', post: recipes.loanCollateralLock(loanCol) },
    { name: 'loanCollateralRelease', post: recipes.loanCollateralRelease(loanCol) },
    { name: 'loanDraw', post: recipes.loanDraw({ loanId: 'ln1', userId: U, debtAssetId: 'USDT', principal: AMT }) },
    {
      name: 'loanRepay',
      post: recipes.loanRepay({ loanId: 'ln1', userId: U, debtAssetId: 'USDT', principal: AMT, interest: 0n, sequence: 1 }),
    },
    {
      name: 'loanRepay',
      post: recipes.loanRepay({ loanId: 'ln1', userId: U, debtAssetId: 'USDT', principal: AMT, interest: AMT, sequence: 1 }),
    },
    {
      name: 'loanLiquidate',
      post: recipes.loanLiquidate({
        loanId: 'ln1',
        userId: U,
        tranche: 0,
        collateralAssetId: 'BTC',
        collateralSold: AMT,
        debtAssetId: 'USDT',
        proceeds: QUOTE,
        principalRepaid: QUOTE,
        interestRepaid: 0n,
        penalty: 0n,
        surplusToBorrower: 0n,
        buyer: { collateralTo: userAvailable(U2, 'BTC'), proceedsFrom: userAvailable(U2, 'USDT') },
        markPrice: QUOTE,
      }),
    },
    { name: 'loanBadDebt', post: recipes.loanBadDebt({ loanId: 'ln1', debtAssetId: 'USDT', shortfall: AMT }) },
    { name: 'loanReserveFund', post: recipes.loanReserveFund({ fundingId: 'f1', debtAssetId: 'USDT', amount: AMT }) },
    {
      name: 'bankTransfer',
      post: recipes.bankTransfer({ transferId: 'tr1', occurrence: 0, from: fromAvail, to: toAvail, amount: AMT, kind: 'manual' }),
    },
    {
      name: 'bankTransfer',
      post: recipes.bankTransfer({ transferId: 'tr1', occurrence: 1, from: fromAvail, to: toAvail, amount: AMT, kind: 'scheduled' }),
    },
    { name: 'earnDeposit', post: recipes.earnDeposit(earn) },
    { name: 'earnWithdraw', post: recipes.earnWithdraw(earn) },
    { name: 'earnPoolFund', post: recipes.earnPoolFund({ poolId: 'pool1', fundingId: 'f1', assetId: 'USDT', amount: AMT }) },
    {
      name: 'earnInterest',
      post: recipes.earnInterest({ poolId: 'pool1', date: '2026-07-27', assetId: 'USDT', payouts: [{ userId: U, amount: AMT }] }),
    },
    { name: 'businessApprovalHold', post: recipes.businessApprovalHold({ approvalId: 'ap1', from: fromAvail, amount: AMT }) },
    { name: 'businessApprovalRelease', post: recipes.businessApprovalRelease({ approvalId: 'ap1', from: fromAvail, amount: AMT }) },
    {
      name: 'businessApprovalSettle',
      post: recipes.businessApprovalSettle({ approvalId: 'ap1', from: fromAvail, to: toAvail, amount: AMT }),
    },
    {
      name: 'businessPayroll',
      post: recipes.businessPayroll({ payrollId: 'pr1', from: fromAvail, recipients: [{ to: toAvail, amount: AMT }] }),
    },
    {
      name: 'subAccountTransfer',
      post: recipes.subAccountTransfer({ transferId: 'st1', fromSubAccountId: S1, toSubAccountId: S2, assetId: 'USDT', amount: AMT }),
    },
    {
      name: 'payReceivedHold',
      post: recipes.payReceivedHold({ holdId: 'rh1', userId: U, assetId: 'USDT', amount: AMT }),
    },
    {
      name: 'payReceivedRelease',
      post: recipes.payReceivedRelease({ holdId: 'rh1', userId: U, assetId: 'USDT', amount: AMT, heldAmount: AMT }),
    },
    {
      name: 'payReceivedReturn',
      post: recipes.payReceivedReturn({ holdId: 'rh1', userId: U, payerUserId: U2, assetId: 'USDT', amount: AMT, heldAmount: AMT }),
    },
    { name: 'staffHoldPlace', post: recipes.staffHoldPlace({ holdNo: 1, userId: U, assetId: 'USDT', amount: AMT }) },
    {
      name: 'staffHoldRelease',
      post: recipes.staffHoldRelease({
        holdNo: 1,
        releaseNo: 1,
        cause: { kind: 'expiry', expiresAt: '2026-10-24T15:00:00Z' },
        userId: U,
        assetId: 'USDT',
        amount: AMT,
      }),
    },
    {
      name: 'staffHoldConfirm',
      post: recipes.staffHoldConfirm({
        holdNo: 1,
        attempt: 1,
        approvalId: 'ap1',
        confirmAccount: 'held-funds',
        heldRemaining: AMT,
        userId: U,
        assetId: 'USDT',
        amount: AMT,
      }),
    },
    {
      name: 'campaignRewardLock',
      post: recipes.campaignRewardLock({ rewardKey: CAMPAIGN_REWARD_KEY, userId: U, assetId: 'USDT', amount: AMT }),
    },
    {
      name: 'campaignRewardUnlock',
      post: recipes.campaignRewardUnlock({ rewardKey: CAMPAIGN_REWARD_KEY, userId: U, assetId: 'USDT', amount: AMT }),
    },
    {
      name: 'campaignRewardForfeit',
      post: recipes.campaignRewardForfeit({ rewardKey: CAMPAIGN_REWARD_KEY, userId: U, assetId: 'USDT', amount: AMT }),
    },
    {
      name: 'bankTransferReversal',
      post: recipes.bankTransferReversal({
        originalKeySpace: 'p2p',
        transferId: 'tr1',
        occurrence: 0,
        consentId: 'c1',
        originalFrom: fromAvail,
        originalTo: toAvail,
        originalAmount: AMT,
        amount: AMT,
      }),
    },
    {
      name: 'marketPurchase',
      post: recipes.marketPurchase({
        purchaseId: 'mp1',
        listingId: 'l1',
        buyerId: U,
        vendorUserId: U2,
        assetId: 'USDT',
        price: QUOTE,
        commissionBps: 0,
      }),
    },
    {
      name: 'marketListingFee',
      post: recipes.marketListingFee({ listingId: 'l1', vendorUserId: U, assetId: 'USDT', amount: AMT }),
    },
    {
      name: 'marketPremiumPlacement',
      post: recipes.marketPremiumPlacement({ placementId: 'pl1', listingId: 'l1', vendorUserId: U, assetId: 'USDT', amount: AMT }),
    },
    {
      name: 'marketPurchaseHold',
      post: recipes.marketPurchaseHold({ purchaseId: 'mh1', listingId: 'l1', buyerId: U, assetId: 'USDT', amount: AMT }),
    },
    {
      name: 'marketPurchaseRefund',
      post: recipes.marketPurchaseRefund({
        ...{ purchaseId: 'mh1', listingId: 'l1', buyerId: U, assetId: 'USDT', amount: AMT },
        refundNo: 1,
      }),
    },
    {
      name: 'marketPurchaseRelease',
      post: recipes.marketPurchaseRelease({
        ...{ purchaseId: 'mh1', listingId: 'l1', buyerId: U, assetId: 'USDT', amount: AMT },
        vendorUserId: U2,
        commissionBps: 0,
      }),
    },
    ...extraShapePosts(),
  ];
}

/** Other leg shapes `recipes.*` actually emits, including a second length of a repeated tail. */
function extraShapePosts(): Array<{ name: RecipeName; post: PostRequest }> {
  const fill = {
    fillId: 'f1',
    makerId: U2,
    takerId: U,
    makerOrderId: 'mo',
    takerOrderId: 'to',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    qty: AMT,
    quoteAmount: QUOTE,
    takerSide: 'buy' as const,
  };
  const posts: Array<{ name: RecipeName; post: PostRequest }> = [
    { name: 'tradeFill', post: recipes.tradeFill({ ...fill, makerFeeBps: 10, takerFeeBps: 0 }) },
    { name: 'tradeFill', post: recipes.tradeFill({ ...fill, makerFeeBps: 0, takerFeeBps: 10 }) },
    { name: 'marketMakerMakerFill', post: recipes.marketMakerMakerFill({ ...fill, makerFeeBps: 10, takerFeeBps: 0 }) },
    { name: 'marketMakerMakerFill', post: recipes.marketMakerMakerFill({ ...fill, makerFeeBps: 0, takerFeeBps: 10 }) },
    { name: 'marketMakerMakerFill', post: recipes.marketMakerMakerFill({ ...fill, makerFeeBps: 10, takerFeeBps: 10 }) },
    {
      name: 'marketPurchase',
      post: recipes.marketPurchase({
        purchaseId: 'mp2',
        listingId: 'l1',
        buyerId: U,
        vendorUserId: U2,
        assetId: 'USDT',
        price: QUOTE,
        commissionBps: 10,
      }),
    },
    {
      name: 'marketPurchaseRelease',
      post: recipes.marketPurchaseRelease({
        ...{ purchaseId: 'mh1', listingId: 'l1', buyerId: U, assetId: 'USDT', amount: AMT },
        vendorUserId: U2,
        commissionBps: 10,
      }),
    },
    {
      name: 'loanRepay',
      post: recipes.loanRepay({ loanId: 'ln1', userId: U, debtAssetId: 'USDT', principal: 0n, interest: AMT, sequence: 1 }),
    },
    {
      name: 'mintEmission',
      post: recipes.mintEmission({ epoch: 2, assetId: 'IFC', amount: AMT, destination: rewardsEngine('IFC') }),
    },
    { name: 'burn', post: recipes.burn({ runId: 'b2', assetId: 'IFC', amount: AMT, from: rewardsEngine('IFC') }) },
    {
      name: 'futuresRealizeLoss',
      post: recipes.futuresRealizeLoss({
        positionId: 'pos1',
        userId: U,
        assetId: 'USDT',
        fromMargin: AMT,
        fromInsurance: AMT,
        lossId: 'l-both',
      }),
    },
    {
      name: 'tradeFillFeeCorrection',
      post: recipes.tradeFillFeeCorrection({
        fillId: 'f-corr',
        correctionId: 'c1',
        userId: U,
        assetId: 'USDT',
        difference: AMT,
      }),
    },
    {
      name: 'tradeFillMakerRebate',
      post: recipes.tradeFillMakerRebate({ ...fill, fillId: 'f-rebate', makerFeeBps: 0, takerFeeBps: 10, makerRebateBps: 5 }),
    },
    {
      name: 'deposit',
      post: recipes.deposit({
        userId: U,
        assetId: 'USDT',
        amount: AMT,
        rail: 'crypto-native',
        railRef: 'tx-sub',
        subAccountId: S1,
        confirmed: true,
      }),
    },
    {
      name: 'depositReverse',
      post: recipes.depositReverse({
        userId: U,
        assetId: 'USDT',
        amount: AMT,
        rail: 'crypto-native',
        railRef: 'tx-sub',
        depositId: 'dep-sub',
        subAccountId: S1,
        confirmed: true,
      }),
    },
    {
      name: 'futuresMarginLock',
      post: recipes.futuresMarginLock({
        positionId: 'pos-sub',
        userId: U,
        assetId: 'USDT',
        amount: AMT,
        subAccountId: S1,
      }),
    },
    {
      name: 'futuresMarginAdd',
      post: recipes.futuresMarginAdd({
        positionId: 'pos-sub',
        userId: U,
        assetId: 'USDT',
        amount: AMT,
        sequence: 1,
        subAccountId: S1,
      }),
    },
    {
      name: 'futuresMarginRelease',
      post: recipes.futuresMarginRelease({
        positionId: 'pos-sub',
        userId: U,
        assetId: 'USDT',
        amount: AMT,
        subAccountId: S1,
      }),
    },
    {
      name: 'futuresMarginRelease',
      post: recipes.futuresMarginRelease({
        positionId: 'pos-sub',
        userId: U,
        assetId: 'USDT',
        amount: AMT,
        fee: AMT,
        subAccountId: S1,
      }),
    },
    {
      name: 'futuresMarginRelease',
      post: recipes.futuresMarginRelease({
        positionId: 'pos-sub',
        userId: U,
        assetId: 'USDT',
        amount: 0n,
        fee: AMT,
        subAccountId: S1,
      }),
    },
    {
      name: 'futuresOrderMarginHold',
      post: recipes.futuresOrderMarginHold({ orderId: 'o-sub', userId: U, assetId: 'USDT', amount: AMT, subAccountId: S1 }),
    },
    {
      name: 'futuresOrderMarginRelease',
      post: recipes.futuresOrderMarginRelease({ orderId: 'o-sub', userId: U, assetId: 'USDT', amount: AMT, subAccountId: S1 }),
    },
    {
      name: 'futuresOrderMarginApply',
      post: recipes.futuresOrderMarginApply({
        orderId: 'o-sub',
        userId: U,
        assetId: 'USDT',
        positionId: 'pos-sub',
        fillId: 'm1:1:pos-sub',
        amount: AMT,
        subAccountId: S1,
      }),
    },
    {
      name: 'futuresOrderMarginApply',
      post: recipes.futuresOrderMarginApply({
        orderId: 'o-sub',
        userId: U,
        assetId: 'USDT',
        positionId: 'pos-sub',
        fillId: 'm1:1:pos-sub',
        amount: AMT,
        releaseAmount: AMT,
        subAccountId: S1,
      }),
    },
    {
      name: 'futuresOrderMarginApply',
      post: recipes.futuresOrderMarginApply({
        orderId: 'o-sub',
        userId: U,
        assetId: 'USDT',
        positionId: 'pos-sub',
        fillId: 'm1:1:pos-sub',
        amount: AMT,
        fee: AMT,
        subAccountId: S1,
      }),
    },
    {
      name: 'futuresOrderMarginApply',
      post: recipes.futuresOrderMarginApply({
        orderId: 'o-sub',
        userId: U,
        assetId: 'USDT',
        positionId: 'pos-sub',
        fillId: 'm1:1:pos-sub',
        amount: AMT,
        releaseAmount: AMT,
        fee: AMT,
        subAccountId: S1,
      }),
    },
    {
      name: 'futuresRealizeLoss',
      post: recipes.futuresRealizeLoss({
        positionId: 'pos-sub',
        userId: U,
        assetId: 'USDT',
        fromMargin: AMT,
        fromInsurance: 0n,
        lossId: 'l-sub',
        subAccountId: S1,
      }),
    },
    {
      name: 'loanReserveFund',
      post: recipes.loanReserveFund({ fundingId: 'f-user', debtAssetId: 'USDT', amount: AMT, from: userAvailable(U, 'USDT') }),
    },
    {
      name: 'earnPoolFund',
      post: recipes.earnPoolFund({
        poolId: 'pool1',
        fundingId: 'f-user',
        assetId: 'USDT',
        amount: AMT,
        from: userAvailable(U, 'USDT'),
      }),
    },
    {
      name: 'earnInterest',
      post: recipes.earnInterest({
        poolId: 'pool1',
        date: '2026-07-27',
        assetId: 'USDT',
        payouts: [
          { userId: U, amount: AMT },
          { userId: U2, amount: AMT },
        ],
      }),
    },
    {
      name: 'chargebackOpen',
      post: recipes.chargebackOpen({
        disputeId: 'd1',
        paymentId: 'p1',
        merchantId: 'm1',
        merchantUserId: U,
        assetId: 'USDT',
        rail: 'card-sandbox',
        fromClearing: AMT,
        fromMerchantBalance: AMT,
      }),
    },
    {
      name: 'chargebackWon',
      post: recipes.chargebackWon({
        disputeId: 'd1',
        paymentId: 'p1',
        merchantId: 'm1',
        merchantUserId: U,
        assetId: 'USDT',
        rail: 'card-sandbox',
        fromClearing: 0n,
        fromMerchantBalance: AMT,
      }),
    },
    {
      name: 'chargebackWon',
      post: recipes.chargebackWon({
        disputeId: 'd1',
        paymentId: 'p1',
        merchantId: 'm1',
        merchantUserId: U,
        assetId: 'USDT',
        rail: 'card-sandbox',
        fromClearing: AMT,
        fromMerchantBalance: AMT,
      }),
    },
    {
      name: 'chargebackWon',
      post: recipes.chargebackWon({
        disputeId: 'd1',
        paymentId: 'p1',
        merchantId: 'm1',
        merchantUserId: U,
        assetId: 'USDT',
        rail: 'card-sandbox',
        fromClearing: 0n,
        fromMerchantBalance: AMT,
        settledPot: 'user',
      }),
    },
  ];

  const userFrom = userAvailable(U, 'USDT');
  const userTo = userAvailable(U2, 'USDT');
  const userTo2 = userAvailable(U3, 'USDT');
  const subFrom = subAccountAvailable(S1, 'USDT');
  const subTo = subAccountAvailable(S2, 'USDT');
  const subTo2 = subAccountAvailable(S3, 'USDT');
  for (const kind of ['manual', 'scheduled'] as const) {
    for (const from of [userFrom, subFrom]) {
      for (const to of [userTo, subTo]) {
        posts.push({
          name: 'bankTransfer',
          post: recipes.bankTransfer({
            transferId: 'tr-shape',
            occurrence: kind === 'manual' ? 0 : 1,
            from,
            to,
            amount: AMT,
            kind,
          }),
        });
      }
    }
  }

  // Rail sends (personal and business bill pay, global send): svc-bank posts
  // `bankTransfer` from a space to the treasury rail boundary and back on a
  // return (services/svc-bank/src/personal-pay/post.ts). A business space is a
  // sub-account (D-149), so both sources are registered. Without these shapes
  // the gate refused every rail send svc-bank builds.
  const railTo = railBoundary('bank-rail', 'USDT');
  for (const space of [userFrom, subFrom]) {
    posts.push(
      {
        name: 'bankTransfer',
        post: recipes.bankTransfer({
          transferId: 'tr-rail',
          occurrence: 0,
          from: space,
          to: railTo,
          amount: AMT,
          kind: 'manual',
          keySpace: 'rail',
        }),
      },
      {
        name: 'bankTransfer',
        post: recipes.bankTransfer({
          transferId: 'tr-rail',
          occurrence: 1,
          from: railTo,
          to: space,
          amount: AMT,
          kind: 'manual',
          keySpace: 'rail',
        }),
      },
    );
  }

  for (const from of [userFrom, subFrom]) {
    posts.push(
      { name: 'businessApprovalHold', post: recipes.businessApprovalHold({ approvalId: 'ap-shape', from, amount: AMT }) },
      { name: 'businessApprovalRelease', post: recipes.businessApprovalRelease({ approvalId: 'ap-shape', from, amount: AMT }) },
    );
    for (const to of [userTo, subTo]) {
      posts.push({
        name: 'businessApprovalSettle',
        post: recipes.businessApprovalSettle({ approvalId: 'ap-shape', from, to, amount: AMT }),
      });
    }
  }

  const payroll = (from: ReturnType<typeof userAvailable>, recipients: ReadonlyArray<ReturnType<typeof userAvailable>>): PostRequest =>
    recipes.businessPayroll({
      payrollId: 'pr-shape',
      from,
      recipients: recipients.map((to) => ({ to, amount: AMT })),
    });
  for (const from of [userFrom, subFrom]) {
    posts.push(
      { name: 'businessPayroll', post: payroll(from, [userTo]) },
      { name: 'businessPayroll', post: payroll(from, [userTo, userTo2]) },
      { name: 'businessPayroll', post: payroll(from, [subTo]) },
      { name: 'businessPayroll', post: payroll(from, [subTo, subTo2]) },
    );
  }

  const buyers = [
    { collateralTo: userAvailable(U2, 'BTC'), proceedsFrom: userAvailable(U2, 'USDT') },
    { collateralTo: marketMaker('BTC'), proceedsFrom: marketMaker('USDT') },
  ];
  for (const buyer of buyers) {
    for (const principal of [false, true]) {
      for (const house of [false, true]) {
        for (const surplus of [false, true]) {
          if (!principal && !house && !surplus) continue;
          const principalRepaid = principal ? AMT : 0n;
          const interestRepaid = house ? AMT : 0n;
          const surplusToBorrower = surplus ? AMT : 0n;
          posts.push({
            name: 'loanLiquidate',
            post: recipes.loanLiquidate({
              loanId: 'ln1',
              userId: U,
              tranche: 0,
              collateralAssetId: 'BTC',
              collateralSold: AMT,
              debtAssetId: 'USDT',
              proceeds: principalRepaid + interestRepaid + surplusToBorrower,
              principalRepaid,
              interestRepaid,
              penalty: 0n,
              surplusToBorrower,
              buyer,
              markPrice: QUOTE,
            }),
          });
        }
      }
    }
  }

  return posts;
}

/** A tail may repeat only when two sampled posts show that same tail growing. */
function deriveRepeatRules(samples: readonly (readonly string[])[]): RepeatRule[] {
  const byPrefix = new Map<string, { prefix: string[]; tokens: Set<string>; minTail: number }>();
  for (const shorter of samples) {
    if (shorter.length < 2) continue;
    const token = shorter[shorter.length - 1];
    if (!token) continue;
    let run = 0;
    for (let i = shorter.length - 1; i >= 0 && shorter[i] === token; i--) run += 1;
    const prefix = shorter.slice(0, shorter.length - run);
    if (prefix.length === 0 || run < 1) continue;
    const extended = samples.some((longer) => {
      if (longer.length <= shorter.length) return false;
      if (longer.length < prefix.length) return false;
      for (let i = 0; i < prefix.length; i++) if (longer[i] !== prefix[i]) return false;
      for (let i = prefix.length; i < longer.length; i++) if (longer[i] !== token) return false;
      return true;
    });
    if (!extended) continue;
    const key = prefix.join(';');
    const existing = byPrefix.get(key);
    if (existing) {
      existing.tokens.add(token);
      existing.minTail = Math.min(existing.minTail, run);
      continue;
    }
    byPrefix.set(key, { prefix, tokens: new Set([token]), minTail: run });
  }
  return [...byPrefix.values()];
}

function matchesRepeat(rules: readonly RepeatRule[], sigs: readonly string[]): boolean {
  for (const rule of rules) {
    if (sigs.length < rule.prefix.length + rule.minTail) continue;
    let ok = true;
    for (let i = 0; i < rule.prefix.length; i++) {
      if (sigs[i] !== rule.prefix[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    for (let i = rule.prefix.length; i < sigs.length; i++) {
      if (!rule.tokens.has(sigs[i] ?? '')) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function buildCatalog(): { catalog: Map<string, CatalogRow>; sampled: ReadonlySet<RecipeName> } {
  const grouped = new Map<string, { name: RecipeName; minLegs: number; signatures: Set<string>; legs: string[][] }>();
  const sampled = new Set<RecipeName>();

  for (const { name, post } of samplePosts()) {
    sampled.add(name);
    if (VARIABLE_REASON_RECIPES.has(name)) continue;
    const key = `${post.module}::${post.reason}`;
    const legs = post.entries.map((entry) => legSignature(entry));
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { name, minLegs: post.entries.length, signatures: new Set([legs.join(';')]), legs: [legs] });
      continue;
    }
    if (existing.name !== name) {
      throw new Error(`recipe catalog key ${key} is shared by ${existing.name} and ${name}`);
    }
    existing.minLegs = Math.min(existing.minLegs, post.entries.length);
    existing.signatures.add(legs.join(';'));
    existing.legs.push(legs);
  }

  const catalog = new Map<string, CatalogRow>();
  for (const [key, row] of grouped) {
    catalog.set(key, {
      name: row.name,
      minLegs: row.minLegs,
      signatures: row.signatures,
      repeats: deriveRepeatRules(row.legs),
    });
  }
  return { catalog, sampled };
}

const { catalog: RECIPE_CATALOG, sampled: SAMPLED_RECIPES } = buildCatalog();

/** Every `recipes` registry key must have a sample (or the allowlist can drift). */
export function unsampledRecipeNames(): readonly RecipeName[] {
  return (Object.keys(recipes) as RecipeName[]).filter((name) => !SAMPLED_RECIPES.has(name)).sort();
}

/** Samples the catalog was built from. Tests use this to check candidate names. */
export function recipeGateSamples(): readonly { readonly name: RecipeName; readonly post: PostRequest }[] {
  return samplePosts();
}

function catalogRecipe(input: WirePost): RecipeName | null {
  const spec = RECIPE_CATALOG.get(`${input.module}::${input.reason}`);
  if (!spec) return null;
  if (input.entries.length < spec.minLegs) return null;

  const sigs = input.entries.map((entry) => legSignature(entry));
  if (spec.signatures.has(sigs.join(';'))) return spec.name;
  if (matchesRepeat(spec.repeats, sigs)) return spec.name;
  return null;
}

/**
 * Every recipe this body matches.
 *
 * Fee, reward, and sweep can share a shape with a catalog recipe (an
 * interest-only loan repayment is also the feeCharge shape). The first hit
 * is not the only name the caller may have been granted.
 */
export function recipeCandidates(input: WirePost): RecipeName[] {
  const found: RecipeName[] = [];
  if (matchesFeeCharge(input)) found.push('feeCharge');
  if (matchesRewardPay(input)) found.push('rewardPay');
  if (matchesFeeSweep(input)) found.push('sweepFeesToRewards');
  const catalog = catalogRecipe(input);
  if (catalog !== null && !found.includes(catalog)) found.push(catalog);
  return found;
}

export function assertKnownRecipePost(input: WirePost): void {
  if (recipeCandidates(input).length > 0) return;
  throw recipeError(input.module, input.reason);
}
