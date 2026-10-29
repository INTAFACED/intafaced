import { formatAmount, mulBps, sub, type Amount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';
import {
  bankTransfer,
  earnDeposit,
  earnWithdraw,
  earnPoolFund,
  earnInterest,
  businessApprovalHold,
  businessApprovalRelease,
  businessApprovalSettle,
  businessPayroll,
} from './bank.js';
import { loanCollateralLock, loanCollateralRelease, loanDraw, loanRepay, loanLiquidate, loanBadDebt, loanReserveFund } from './loans.js';
import { chargebackOpen, chargebackShortfall, chargebackWon, chargebackShortfallRecovered } from './chargeback.js';
import { orderHoldAmend } from './order-hold-amend.js';
import { futuresOrderMarginApply, futuresOrderMarginHold, futuresOrderMarginRelease } from './futures-order-margin.js';
import { subAccountTransfer } from './sub-accounts.js';
import { payReceivedHold, payReceivedRelease, payReceivedReturn } from './pay-received-hold.js';
import { bankTransferReversal } from './bank-transfer-reversal.js';
import { staffHoldConfirm, staffHoldPlace, staffHoldRelease } from './staff-hold.js';
import { campaignRewardForfeit, campaignRewardLock, campaignRewardUnlock } from './campaign-lock.js';
import { marketListingFee, marketPremiumPlacement, marketPurchase } from './market.js';
import { fxConversion, fxConversionHold, fxConversionLateFill, fxConversionRelease, fxConversionReverse } from './conversion.js';
import { tradeFillFeeCorrection } from './fill-correction.js';
import { tradeFillMakerRebate } from './fill-rebate.js';
import {
  assertEscrowDisputeRuling,
  assertEscrowRefundResolution,
  disputeRulingMeta,
  type EscrowDisputeRuling,
} from './escrow-dispute-law.js';
import {
  burnAccount,
  futuresLossSink,
  houseFees,
  merchantClearing,
  merchantProceeds,
  merchantProceedsPayoutHold as merchantProceedsPayoutHoldAccount,
  mintBoundary,
  orderHoldAccount,
  positionCollateralAccount,
  subAccountAvailable,
  subAccountPositionCollateral,
  insuranceFund,
  railBoundary,
  marketMaker,
  marketMakerOrderHoldAccount,
  rewardsEngine,
  userAvailable,
  tradeEscrowAccount,
  tokenStakeAccount,
  withdrawalHoldAccount,
} from '../accounts.js';

export type { EscrowDisputeRuling } from './escrow-dispute-law.js';
export { NATURAL_PERSON_ID, isNaturalPersonId, assertEscrowDisputeRuling, assertEscrowRefundResolution } from './escrow-dispute-law.js';
export { refusePostedFillPriceEdit, tradeFillFeeCorrection, type TradeFillFeeCorrectionInput } from './fill-correction.js';
export { makerRebateFor, tradeFillMakerRebate, type MakerRebate, type TradeFillMakerRebateInput } from './fill-rebate.js';

/**
 * LEDGER RECIPES (§4.2).
 *
 * A recipe is a pure function: business intent in, a `PostRequest` out. It does
 * no I/O and holds no state, which means every money path in the OS can be
 * unit-tested without a database, and the same recipe produces byte-identical
 * entries in a test, in dev, and in production.
 *
 * Services call `ledger.post(recipes.tradeFill({...}))`. They never assemble
 * entries by hand — an inline entry list is a code-review rejection.
 */

const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

function requirePositive(name: string, value: Amount): void {
  if (value <= 0n) throw new InvalidEntryError(`${name} must be positive`);
}

function namedSubAccount(subAccountId: string | undefined): string {
  return subAccountId?.trim() ?? '';
}

/** Tagged deposits credit the named sub-account. Untagged deposits credit the user pot. */
function depositCreditedAccount(input: { userId: string; assetId: string; subAccountId?: string }): AccountRef {
  const subAccountId = namedSubAccount(input.subAccountId);
  if (subAccountId) return subAccountAvailable(subAccountId, input.assetId);
  return userAvailable(input.userId, input.assetId);
}

function assertDepositConfirmed(input: { confirmed?: boolean }): void {
  if (input.confirmed === false) throw new InvalidEntryError('An unconfirmed deposit credits no pot');
}

function marginPots(input: { userId: string; assetId: string; positionId: string; subAccountId?: string }): {
  subAccountId: string;
  available: AccountRef;
  collateral: AccountRef;
} {
  const subAccountId = namedSubAccount(input.subAccountId);
  if (subAccountId) {
    return {
      subAccountId,
      available: subAccountAvailable(subAccountId, input.assetId),
      collateral: subAccountPositionCollateral(subAccountId, input.assetId, input.positionId),
    };
  }
  return {
    subAccountId: '',
    available: userAvailable(input.userId, input.assetId),
    collateral: positionCollateralAccount(input.userId, input.assetId, input.positionId),
  };
}

// ── Deposits & withdrawals ───────────────────────────────────────────────────

export interface DepositInput {
  userId: string;
  assetId: string;
  amount: Amount;
  /** The rail the value arrived on — 'crypto-native', 'card-sandbox', … */
  rail: string;
  /** Rail's own reference (tx hash, PSP id) — this is what makes it idempotent. */
  railRef: string;
  /**
   * When set, the credit lands on this sub-account's available pot.
   * The parent user pot is not credited.
   */
  subAccountId?: string;
  /**
   * A tagged deposit credits only after confirmation.
   * `false` posts nothing: neither the sub-account nor the parent user pot.
   * Omitted means confirmed, so existing callers are unchanged.
   */
  confirmed?: boolean;
}

/** Value enters the book from the outside world. */
export function deposit(input: DepositInput): PostRequest {
  requirePositive('deposit amount', input.amount);
  assertDepositConfirmed(input);
  const subAccountId = namedSubAccount(input.subAccountId);
  return {
    idempotencyKey: `deposit:${input.rail}:${input.railRef}`,
    module: 'ledger',
    reason: 'deposit.credited',
    meta: { rail: input.rail, railRef: input.railRef, ...(subAccountId ? { subAccountId } : {}) },
    entries: [credit(railBoundary(input.rail, input.assetId), input.amount), debit(depositCreditedAccount(input), input.amount)],
  };
}

export interface DepositReverseInput extends DepositInput {
  /** One reversal per deposit. A second post for this id returns the first. */
  depositId: string;
}

/**
 * The chain rewrote the block a deposit was credited from.
 *
 * Inverse of `deposit`: the amount leaves the user's available balance and
 * the rail boundary. A new journal row, not an edit of the credit.
 */
export function depositReverse(input: DepositReverseInput): PostRequest {
  requirePositive('deposit reversal amount', input.amount);
  assertDepositConfirmed(input);
  const depositId = input.depositId.trim();
  if (!depositId) throw new InvalidEntryError('deposit reversal requires a deposit id');
  const subAccountId = namedSubAccount(input.subAccountId);
  return {
    idempotencyKey: `deposit.reverse:${depositId}`,
    module: 'ledger',
    reason: 'deposit.reversed',
    meta: { rail: input.rail, railRef: input.railRef, depositId, ...(subAccountId ? { subAccountId } : {}) },
    entries: [debit(railBoundary(input.rail, input.assetId), input.amount), credit(depositCreditedAccount(input), input.amount)],
  };
}

export interface WithdrawInput {
  userId: string;
  assetId: string;
  amount: Amount;
  rail: string;
  withdrawalId: string;
  /**
   * The network fee the person was quoted for this withdrawal (W-withdraw-04, J-wallet-05 #6), in the same asset, charged on
   * top of `amount`. Absent means no fee leg: a withdrawal held without one settles and reverses without one. When present it
   * must be above zero (a stated zero fee is no leg, never a zero-amount entry), and the same fee must ride the hold, the
   * settle and the reverse of one withdrawal, so what leaves the balance is exactly the quote's total debit.
   */
  fee?: Amount;
}

/** What one withdrawal holds: the amount sent plus its fee, when there is one. */
function withdrawTotal(input: WithdrawInput): Amount {
  if (input.fee === undefined) return input.amount;
  requirePositive('withdrawal fee', input.fee);
  return input.amount + input.fee;
}

/** `meta.fee` on a withdrawal post that carries a fee, so the journal says which part was the fee. */
function withdrawMeta(input: WithdrawInput): Record<string, string> {
  return {
    rail: input.rail,
    withdrawalId: input.withdrawalId,
    ...(input.fee === undefined ? {} : { fee: formatAmount(input.fee) }),
  };
}

/**
 * Seed inventory into the house market-maker pot (trade.mm-bot residual).
 *
 * Value enters from a named rail boundary (ops/treasury seed), not invented.
 * Seeder jobs spend this pot via orderHold under the MM house identity.
 */
export function marketMakerSeedFund(input: {
  assetId: string;
  amount: Amount;
  /** Unique seed id for idempotency. */
  seedId: string;
  /** Rail label for the boundary pot, e.g. 'mm-seed' or 'treasury'. */
  rail?: string;
}): PostRequest {
  requirePositive('market-maker seed amount', input.amount);
  const rail = input.rail ?? 'mm-seed';
  return {
    idempotencyKey: `mm.seed.fund:${input.seedId}:${input.assetId}`,
    module: 'trade',
    reason: 'mm.seed.funded',
    meta: { seedId: input.seedId, rail },
    entries: [credit(railBoundary(rail, input.assetId), input.amount), debit(marketMaker(input.assetId), input.amount)],
  };
}

/** Step 1: funds leave `available` and sit in `hold` while the rail works. With a fee, the hold is the amount plus the fee. */
export function withdrawHold(input: WithdrawInput): PostRequest {
  requirePositive('withdrawal amount', input.amount);
  const total = withdrawTotal(input);
  return {
    idempotencyKey: `withdraw.hold:${input.withdrawalId}`,
    module: 'ledger',
    reason: 'withdraw.held',
    meta: withdrawMeta(input),
    entries: [
      credit(userAvailable(input.userId, input.assetId), total),
      debit(withdrawalHoldAccount(input.userId, input.assetId, input.withdrawalId), total),
    ],
  };
}

/** Step 2a: the rail confirmed. Value leaves the book. */
export function withdrawSettle(input: WithdrawInput): PostRequest {
  requirePositive('withdrawal amount', input.amount);
  const total = withdrawTotal(input);
  return {
    idempotencyKey: `withdraw.settle:${input.withdrawalId}`,
    module: 'ledger',
    reason: 'withdraw.settled',
    meta: withdrawMeta(input),
    // Draws on THIS withdrawal's hold. Before P0-3 this credited the user's one
    // shared hold account, so a settle could consume value an open order had
    // reserved — balanced books, unfunded order, no record of which.
    // With a fee the whole hold is drawn in the same posting: the amount goes to the rail, the fee to houseFees(pay), so no
    // crash can leave the fee sitting in a hold whose withdrawal is already sent.
    entries: [
      credit(withdrawalHoldAccount(input.userId, input.assetId, input.withdrawalId), total),
      debit(railBoundary(input.rail, input.assetId), input.amount),
      ...(input.fee === undefined ? [] : [debit(houseFees('pay', input.assetId), input.fee)]),
    ],
  };
}

/** Step 2b: the rail failed. The reversal path is defined, not improvised. */
export function withdrawReverse(input: WithdrawInput): PostRequest {
  requirePositive('withdrawal amount', input.amount);
  const total = withdrawTotal(input);
  return {
    idempotencyKey: `withdraw.reverse:${input.withdrawalId}`,
    module: 'ledger',
    reason: 'withdraw.reversed',
    meta: withdrawMeta(input),
    // Nothing was sent, so the fee goes back with the amount: the whole hold returns to available.
    entries: [
      credit(withdrawalHoldAccount(input.userId, input.assetId, input.withdrawalId), total),
      debit(userAvailable(input.userId, input.assetId), total),
    ],
  };
}

/**
 * Step 3: a settled withdrawal came back from the outside (W-withdraw-07). The rail returned some or all of what
 * `withdrawSettle` sent, and it goes back to the person's available balance from the same rail boundary it left to.
 *
 * Its own post, not an edit of the settle: both stay in the journal and the trail reads "sent, came back". One return
 * per withdrawal attempt (`withdraw.returned:<withdrawalId>`, the settle's own id), so a second delivery of the same
 * return posts nothing. svc-ledger's door books it only against the posted `withdraw.settle:<withdrawalId>`: the same
 * person, asset and rail, and no more than that settle sent (`withdraw-return-binding.ts`).
 */
export function withdrawReturned(input: WithdrawInput): PostRequest {
  requirePositive('returned withdrawal amount', input.amount);
  const withdrawalId = input.withdrawalId;
  if (!withdrawalId || withdrawalId.trim() !== withdrawalId) {
    throw new InvalidEntryError('withdrawalId is required, with no surrounding spaces');
  }
  return {
    idempotencyKey: `withdraw.returned:${withdrawalId}`,
    module: 'ledger',
    reason: 'withdraw.returned',
    meta: { rail: input.rail, withdrawalId },
    entries: [
      credit(railBoundary(input.rail, input.assetId), input.amount),
      debit(userAvailable(input.userId, input.assetId), input.amount),
    ],
  };
}

// ── Trading ──────────────────────────────────────────────────────────────────

export interface TradeFillInput {
  fillId: string;
  makerId: string;
  takerId: string;
  /**
   * Which orders are being drawn down (P0-3).
   *
   * Required, because a fill has to say whose reservation it is spending. With
   * one hold per (user, asset) a fill could be settled out of a hold placed by
   * a completely different order — or by a withdrawal — and the transaction
   * would still balance.
   */
  makerOrderId: string;
  takerOrderId: string;
  baseAsset: string;
  quoteAsset: string;
  /** Base quantity traded. */
  qty: Amount;
  /** Total quote value of the fill (price × qty, already rounded by the engine). */
  quoteAmount: Amount;
  takerSide: 'buy' | 'sell';
  makerFeeBps: number;
  takerFeeBps: number;
}

/**
 * The six-entry atomic fill (§5.2).
 *
 * Each side's fee is taken from what that side receives, so a fill never
 * requires a party to hold a balance in an asset they were not trading.
 * Funds come out of `hold` — svc-trade placed them there when the order was
 * accepted, and the engine only ever matches orders that are already funded.
 */
export function tradeFill(input: TradeFillInput): PostRequest {
  requirePositive('fill qty', input.qty);
  requirePositive('fill quote amount', input.quoteAmount);

  const takerBuys = input.takerSide === 'buy';

  // Who pays which asset, and therefore whose hold is drawn down.
  const takerPaysAsset = takerBuys ? input.quoteAsset : input.baseAsset;
  const takerPaysAmount = takerBuys ? input.quoteAmount : input.qty;
  const makerPaysAsset = takerBuys ? input.baseAsset : input.quoteAsset;
  const makerPaysAmount = takerBuys ? input.qty : input.quoteAmount;

  // Each side receives what the other paid, minus its own fee.
  const takerFee = mulBps(makerPaysAmount, input.takerFeeBps);
  const makerFee = mulBps(takerPaysAmount, input.makerFeeBps);

  const takerReceives = sub(makerPaysAmount, takerFee);
  const makerReceives = sub(takerPaysAmount, makerFee);

  // `<= 0n`, not `< 0n`. A fee LARGER than the receivable was caught here; a fee
  // exactly EQUAL to it was not, and it emits a zero-amount entry that
  // `assertBalanced` rejects four layers down with "a movement of nothing is not
  // a movement" — a message that says nothing about fee configuration.
  //
  // It is reachable at the minimum legal market grid. `mulBps` rounds `ceil` by
  // design, so any 1-wei receivable with a non-zero fee rate produces
  // `fee == amount`; fuzzing the recipe layer produced 2 329 such cases, and
  // `drizzle/0000_trade_init.sql:95` permits `tick_size * lot_size` of exactly
  // one wei. Upstream, `settleFill` guards `quoteAmount <= 0n` and raises
  // `trade.dust_fill` — it catches ZERO, not ONE. All three guards stopped at
  // zero and none covered one.
  //
  // The refusal has to happen HERE rather than at the ledger, because
  // `settleFill` inserts the fill rows before posting. The README documents that
  // ordering as safe — "worst case the funds stay in `hold`; re-running the fill
  // re-posts the same idempotency key and heals it" — and for this failure class
  // re-running throws again, every time. The fill is permanently unpostable and
  // `trade.fills` stays permanently ahead of the ledger. The documented recovery
  // does not cover it.
  if (takerReceives <= 0n || makerReceives <= 0n) {
    throw new InvalidEntryError('Fee exceeds fill value — check fee bps configuration');
  }

  const entries: EntryInput[] = [
    // Asset the taker paid: out of THIS ORDER's hold, into maker available + house fees.
    credit(orderHoldAccount(input.takerId, takerPaysAsset, input.takerOrderId), takerPaysAmount),
    debit(userAvailable(input.makerId, takerPaysAsset), makerReceives),
    ...(makerFee > 0n ? [debit(houseFees('trade', takerPaysAsset), makerFee)] : []),

    // Asset the maker paid: out of THIS ORDER's hold, into taker available + house fees.
    credit(orderHoldAccount(input.makerId, makerPaysAsset, input.makerOrderId), makerPaysAmount),
    debit(userAvailable(input.takerId, makerPaysAsset), takerReceives),
    ...(takerFee > 0n ? [debit(houseFees('trade', makerPaysAsset), takerFee)] : []),
  ];

  return {
    idempotencyKey: `trade.fill:${input.fillId}`,
    module: 'trade',
    reason: 'trade.fill',
    meta: {
      fillId: input.fillId,
      takerSide: input.takerSide,
      makerFeeBps: input.makerFeeBps,
      takerFeeBps: input.takerFeeBps,
      makerOrderId: input.makerOrderId,
      takerOrderId: input.takerOrderId,
    },
    entries,
  };
}

export interface OrderHoldInput {
  orderId: string;
  userId: string;
  assetId: string;
  amount: Amount;
}

/** Funds reserved when an order is accepted. */
export function orderHold(input: OrderHoldInput): PostRequest {
  requirePositive('order hold amount', input.amount);
  return {
    idempotencyKey: `order.hold:${input.orderId}`,
    module: 'trade',
    reason: 'order.hold',
    meta: { orderId: input.orderId },
    entries: [
      credit(userAvailable(input.userId, input.assetId), input.amount),
      debit(orderHoldAccount(input.userId, input.assetId, input.orderId), input.amount),
    ],
  };
}

/** Unfilled remainder returned on cancel or expiry. */
export function orderHoldRelease(input: OrderHoldInput & { sequence?: number }): PostRequest {
  requirePositive('order release amount', input.amount);
  return {
    idempotencyKey: `order.release:${input.orderId}:${input.sequence ?? 0}`,
    module: 'trade',
    reason: 'order.hold.released',
    meta: { orderId: input.orderId },
    entries: [
      credit(orderHoldAccount(input.userId, input.assetId, input.orderId), input.amount),
      debit(userAvailable(input.userId, input.assetId), input.amount),
    ],
  };
}

export interface MarketMakerOrderHoldInput {
  orderId: string;
  assetId: string;
  amount: Amount;
}

/**
 * Reserve house market-maker inventory for one seed/open order (trade.mm-bot).
 * Draws from marketMaker available — fund via marketMakerSeedFund first.
 */
export function marketMakerOrderHold(input: MarketMakerOrderHoldInput): PostRequest {
  requirePositive('mm order hold amount', input.amount);
  return {
    idempotencyKey: `order.hold.mm:${input.orderId}`,
    module: 'trade',
    reason: 'order.hold.mm',
    meta: { orderId: input.orderId, house: 'market-maker' },
    entries: [
      credit(marketMaker(input.assetId), input.amount),
      debit(marketMakerOrderHoldAccount(input.assetId, input.orderId), input.amount),
    ],
  };
}

/** Release unfilled MM seed order hold back to house market-maker available. */
export function marketMakerOrderHoldRelease(input: MarketMakerOrderHoldInput & { sequence?: number }): PostRequest {
  requirePositive('mm order release amount', input.amount);
  return {
    idempotencyKey: `order.release.mm:${input.orderId}:${input.sequence ?? 0}`,
    module: 'trade',
    reason: 'order.hold.mm.released',
    meta: { orderId: input.orderId, house: 'market-maker' },
    entries: [
      credit(marketMakerOrderHoldAccount(input.assetId, input.orderId), input.amount),
      debit(marketMaker(input.assetId), input.amount),
    ],
  };
}

/**
 * Fill where house market-maker is the **maker** and a user is the taker
 * (trade.mm-bot residual — user takes against a seed quote).
 *
 * Same six-entry economics as `tradeFill`, but maker legs use
 * `marketMakerOrderHoldAccount` / `marketMaker` instead of user hold/available.
 * Does not invent fees or amounts — caller supplies engine qty/quote + bps.
 *
 * Wiring into svc-trade settleFill still residual (seed orders need store rows).
 */
export interface MarketMakerMakerFillInput {
  fillId: string;
  /** User taker id. */
  takerId: string;
  makerOrderId: string;
  takerOrderId: string;
  baseAsset: string;
  quoteAsset: string;
  qty: Amount;
  quoteAmount: Amount;
  takerSide: 'buy' | 'sell';
  makerFeeBps: number;
  takerFeeBps: number;
}

export function marketMakerMakerFill(input: MarketMakerMakerFillInput): PostRequest {
  requirePositive('fill qty', input.qty);
  requirePositive('fill quote amount', input.quoteAmount);

  const takerBuys = input.takerSide === 'buy';
  const takerPaysAsset = takerBuys ? input.quoteAsset : input.baseAsset;
  const takerPaysAmount = takerBuys ? input.quoteAmount : input.qty;
  const makerPaysAsset = takerBuys ? input.baseAsset : input.quoteAsset;
  const makerPaysAmount = takerBuys ? input.qty : input.quoteAmount;

  const takerFee = mulBps(makerPaysAmount, input.takerFeeBps);
  const makerFee = mulBps(takerPaysAmount, input.makerFeeBps);
  const takerReceives = sub(makerPaysAmount, takerFee);
  const makerReceives = sub(takerPaysAmount, makerFee);

  // `<= 0n` for the same reason as `tradeFill` above: a fee exactly equal to the
  // receivable emits a zero-amount entry the ledger always refuses, and the
  // error it produces names nothing the operator can act on.
  if (takerReceives <= 0n || makerReceives <= 0n) {
    throw new InvalidEntryError('Fee exceeds fill value — check fee bps configuration');
  }

  const entries: EntryInput[] = [
    // Taker paid: out of user order hold → house MM available + house fees.
    credit(orderHoldAccount(input.takerId, takerPaysAsset, input.takerOrderId), takerPaysAmount),
    debit(marketMaker(takerPaysAsset), makerReceives),
    ...(makerFee > 0n ? [debit(houseFees('trade', takerPaysAsset), makerFee)] : []),

    // MM paid: out of MM order hold → user available + house fees.
    credit(marketMakerOrderHoldAccount(makerPaysAsset, input.makerOrderId), makerPaysAmount),
    debit(userAvailable(input.takerId, makerPaysAsset), takerReceives),
    ...(takerFee > 0n ? [debit(houseFees('trade', makerPaysAsset), takerFee)] : []),
  ];

  return {
    idempotencyKey: `trade.fill.mm-maker:${input.fillId}`,
    module: 'trade',
    reason: 'trade.fill.mm_maker',
    meta: {
      fillId: input.fillId,
      takerSide: input.takerSide,
      makerFeeBps: input.makerFeeBps,
      takerFeeBps: input.takerFeeBps,
      makerOrderId: input.makerOrderId,
      takerOrderId: input.takerOrderId,
      house: 'market-maker',
    },
    entries,
  };
}

// ── Futures margin (§5.2 / trade.futures) ────────────────────────────────────
//
// Pure recipes only — no mark price, no liquidation engine. svc-trade posts
// these when positions open/close/adjust. Insurance fund path is for realized
// losses that the user's margin cannot cover (engine decides amounts).

export interface FuturesMarginInput {
  positionId: string;
  userId: string;
  /** Margin asset (typically quote, e.g. USDT). */
  assetId: string;
  amount: Amount;
  /**
   * When set, the margin pot is this sub-account. The parent user pot is not used.
   */
  subAccountId?: string;
}

/** Lock margin into purpose-keyed collateral for one position. */
export function futuresMarginLock(input: FuturesMarginInput): PostRequest {
  requirePositive('futures margin lock amount', input.amount);
  const pots = marginPots(input);
  return {
    idempotencyKey: `futures.margin.lock:${input.positionId}`,
    module: 'trade',
    reason: 'futures.margin.lock',
    meta: { positionId: input.positionId, ...(pots.subAccountId ? { subAccountId: pots.subAccountId } : {}) },
    entries: [credit(pots.available, input.amount), debit(pots.collateral, input.amount)],
  };
}

/**
 * Add margin to an open position (same pot). Sequence in the key so repeated
 * top-ups do not collide with the open lock idempotency key.
 */
export function futuresMarginAdd(input: FuturesMarginInput & { sequence: number }): PostRequest {
  requirePositive('futures margin add amount', input.amount);
  if (input.sequence < 1) throw new InvalidEntryError('futures margin add sequence must be >= 1');
  const pots = marginPots(input);
  return {
    idempotencyKey: `futures.margin.add:${input.positionId}:${input.sequence}`,
    module: 'trade',
    reason: 'futures.margin.add',
    meta: {
      positionId: input.positionId,
      sequence: input.sequence,
      ...(pots.subAccountId ? { subAccountId: pots.subAccountId } : {}),
    },
    entries: [credit(pots.available, input.amount), debit(pots.collateral, input.amount)],
  };
}

/**
 * Release remaining margin on close / cancel before open risk.
 *
 * `fee` is a closing fill's trading fee, paid from the position's pot into
 * `houseFees('trade')` in the same posting as the release, so no crash can
 * return margin the fee needed (docs/adr/2026-10-20-futures-matched-traders.md).
 * With a fee, `amount` may be zero: a close whose loss took the rest of the
 * margin still pays its fee from what the pot holds. The engine names both
 * amounts; this recipe never chooses a rate.
 */
export function futuresMarginRelease(input: FuturesMarginInput & { sequence?: number; fee?: Amount }): PostRequest {
  const fee = input.fee ?? 0n;
  if (typeof fee !== 'bigint' || fee < 0n) throw new InvalidEntryError('futures margin release fee must not be negative');
  if (fee === 0n) requirePositive('futures margin release amount', input.amount);
  else if (typeof input.amount !== 'bigint' || input.amount < 0n) {
    throw new InvalidEntryError('futures margin release amount must not be negative');
  }
  const pots = marginPots(input);
  return {
    idempotencyKey: `futures.margin.release:${input.positionId}:${input.sequence ?? 0}`,
    module: 'trade',
    reason: 'futures.margin.release',
    meta: {
      positionId: input.positionId,
      ...(fee > 0n ? { fee: fee.toString() } : {}),
      ...(pots.subAccountId ? { subAccountId: pots.subAccountId } : {}),
    },
    entries: [
      credit(pots.collateral, input.amount + fee),
      ...(input.amount > 0n ? [debit(pots.available, input.amount)] : []),
      ...(fee > 0n ? [debit(houseFees('trade', input.assetId), fee)] : []),
    ],
  };
}

export interface FuturesLossInput {
  positionId: string;
  userId: string;
  assetId: string;
  /** Loss covered from the position's own margin. */
  fromMargin: Amount;
  /** Residual loss taken from insurance fund (may be 0n — then omit by not calling). */
  fromInsurance: Amount;
  /** Idempotency id. A retry of this id posts once. */
  lossId: string;
  /**
   * When set, margin leaves this sub-account's position pot, never the parent user pot.
   */
  subAccountId?: string;
  /**
   * Pot the caller asks to draw. It must be `subAccountId`.
   * Any other id is a sibling partition and is refused before an entry is built.
   */
  drawSubAccountId?: string;
}

/**
 * Realize a loss against position margin (+ optional insurance).
 *
 * The debit is `futuresLossSink`, not `houseFees('trade')`. A fee total stays fees.
 * Engine names the amounts. A sub-account loss stays on that sub-account's pot.
 */
export function futuresRealizeLoss(input: FuturesLossInput): PostRequest {
  const named = namedSubAccount(input.subAccountId);
  const draw = namedSubAccount(input.drawSubAccountId);
  if (draw && draw !== named) {
    throw new InvalidEntryError('A futures loss cannot draw a sibling sub-account pot');
  }
  if (input.fromMargin < 0n || input.fromInsurance < 0n) {
    throw new InvalidEntryError('futures loss legs must be non-negative');
  }
  const total = input.fromMargin + input.fromInsurance;
  requirePositive('futures realized loss total', total);

  const collateral = named
    ? subAccountPositionCollateral(named, input.assetId, input.positionId)
    : positionCollateralAccount(input.userId, input.assetId, input.positionId);

  const entries: EntryInput[] = [];
  if (input.fromMargin > 0n) {
    entries.push(credit(collateral, input.fromMargin));
  }
  if (input.fromInsurance > 0n) {
    entries.push(credit(insuranceFund(input.assetId), input.fromInsurance));
  }
  entries.push(debit(futuresLossSink(input.assetId), total));

  return {
    idempotencyKey: `futures.loss:${input.lossId}`,
    module: 'trade',
    reason: 'futures.loss.realized',
    meta: {
      positionId: input.positionId,
      fromMargin: input.fromMargin.toString(),
      fromInsurance: input.fromInsurance.toString(),
      ...(named ? { subAccountId: named } : {}),
    },
    entries,
  };
}

export interface FuturesProfitInput {
  positionId: string;
  userId: string;
  assetId: string;
  amount: Amount;
  /** Unique close/profit attempt key (idempotency). */
  profitId: string;
}

/**
 * Realize a profit on close (trade.futures).
 *
 * Paid from the clearing pot `futuresLossSink`, the account every realised
 * loss pays into. Futures match trader against trader, so every unit of profit
 * is a unit another trader lost (docs/adr/2026-10-20-futures-matched-traders.md).
 * House trade fees never pay a winner. The engine names the amount from an
 * **external** exit price and bounds it by the pot's balance before posting —
 * this recipe never invents a price.
 */
export function futuresRealizeProfit(input: FuturesProfitInput): PostRequest {
  requirePositive('futures realized profit', input.amount);
  return {
    idempotencyKey: `futures.profit:${input.profitId}`,
    module: 'trade',
    reason: 'futures.profit.realized',
    meta: {
      positionId: input.positionId,
      amount: input.amount.toString(),
    },
    entries: [credit(futuresLossSink(input.assetId), input.amount), debit(userAvailable(input.userId, input.assetId), input.amount)],
  };
}

/**
 * Periodic funding payment between two positions (trade.futures F5 recipe).
 *
 * Engine chooses who pays whom and the amount from the funding rate × notional.
 * Value leaves the payer's position collateral and lands in the payee's
 * available balance (received funding is free cash, not forced re-margin).
 * Keyed on fundingId so an 8h period settles exactly once per pair.
 */
export interface FuturesFundingInput {
  /** Unique period key, e.g. `${marketId}:${periodStartIso}:${payerPositionId}`. */
  fundingId: string;
  payerUserId: string;
  payerPositionId: string;
  payeeUserId: string;
  payeePositionId: string;
  assetId: string;
  amount: Amount;
}

export function futuresFundingPay(input: FuturesFundingInput): PostRequest {
  requirePositive('futures funding amount', input.amount);
  return {
    idempotencyKey: `futures.funding:${input.fundingId}`,
    module: 'trade',
    reason: 'futures.funding.paid',
    meta: {
      fundingId: input.fundingId,
      payerPositionId: input.payerPositionId,
      payeePositionId: input.payeePositionId,
    },
    entries: [
      credit(positionCollateralAccount(input.payerUserId, input.assetId, input.payerPositionId), input.amount),
      debit(userAvailable(input.payeeUserId, input.assetId), input.amount),
    ],
  };
}

/**
 * Seed or top up the futures insurance fund from house trade fees.
 * Liquidation shortfalls draw via futuresRealizeLoss({ fromInsurance }).
 */
export function futuresInsuranceTopup(input: { topupId: string; assetId: string; amount: Amount }): PostRequest {
  requirePositive('insurance topup amount', input.amount);
  return {
    idempotencyKey: `futures.insurance.topup:${input.topupId}`,
    module: 'trade',
    reason: 'futures.insurance.topup',
    meta: { topupId: input.topupId },
    entries: [credit(houseFees('trade', input.assetId), input.amount), debit(insuranceFund(input.assetId), input.amount)],
  };
}

// ── P2P escrow (§6.2) ────────────────────────────────────────────────────────

export interface EscrowInput {
  tradeId: string;
  sellerId: string;
  buyerId: string;
  assetId: string;
  amount: Amount;
}

/**
 * Seller's crypto moves into escrow the moment the taker accepts — the hold.
 *
 * Under dispute law (ADR 2026-08-04) this pot stays put through `disputed` and
 * through escalate-and-hold: the timer never posts a release/refund. Disposition
 * is `escrowRelease` / `escrowRefund` only after a human ruling (optional
 * `ruling` on those recipes enforces natural-person attribution on the wire).
 */
export function escrowLock(input: EscrowInput): PostRequest {
  requirePositive('escrow amount', input.amount);
  return {
    idempotencyKey: `p2p.escrow.lock:${input.tradeId}`,
    module: 'p2p',
    reason: 'p2p.escrow.lock',
    meta: { tradeId: input.tradeId },
    entries: [
      credit(userAvailable(input.sellerId, input.assetId), input.amount),
      debit(tradeEscrowAccount(input.sellerId, input.assetId, input.tradeId), input.amount),
    ],
  };
}

/**
 * Seller confirms fiat received — escrow releases to the buyer.
 *
 * Optional `ruling` (ADR D-S-08): when the caller marks this post as a
 * moderated dispute disposition, `rulingBy` must be a natural-person UUID.
 * Happy-path seller confirm omits `ruling` and is unchanged. Idempotency key
 * stays `p2p.escrow.release:<tradeId>` so svc-p2p can adopt attribution without
 * a key migration.
 */
export function escrowRelease(input: EscrowInput & { feeBps: number; ruling?: EscrowDisputeRuling }): PostRequest {
  requirePositive('escrow amount', input.amount);
  assertEscrowDisputeRuling(input.ruling, 'escrowRelease');
  // A blank fee is not a zero fee: the caller passes the trade's own feeBps
  // (0 explicitly when the trade carries none). Defaulting to 0 would pay the
  // buyer the house's fee on any caller that forgot it.
  const feeBps = input.feeBps;
  if (feeBps === undefined || feeBps === null) {
    throw new InvalidEntryError('escrow feeBps is required; pass 0 explicitly for a fee-free release');
  }
  // Same class as tradeFill: an unbound feeBps at 10000 gives the buyer nothing;
  // above that the buyer leg goes negative and is refused four layers down with a
  // message that says nothing about fees (STOP §4.2b #2). Refuse here, clearly.
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 9_999) {
    throw new InvalidEntryError(`escrow feeBps must be an integer in 0..9999, got ${feeBps}`);
  }
  const fee = mulBps(input.amount, feeBps);
  const toBuyer = sub(input.amount, fee);
  // `<= 0n` — fee equal to amount is unreachable under 9999 bps ceil for amount>0
  // except pathological rounding; still refuse zero/negative buyer leg.
  if (toBuyer <= 0n) {
    throw new InvalidEntryError('Fee exceeds escrow value — check fee bps configuration');
  }

  const rulingMeta = disputeRulingMeta(input.ruling);
  return {
    idempotencyKey: `p2p.escrow.release:${input.tradeId}`,
    module: 'p2p',
    reason: 'p2p.escrow.release',
    meta: { tradeId: input.tradeId, feeBps, ...rulingMeta },
    entries: [
      credit(tradeEscrowAccount(input.sellerId, input.assetId, input.tradeId), input.amount),
      debit(userAvailable(input.buyerId, input.assetId), toBuyer),
      ...(fee > 0n ? [debit(houseFees('p2p', input.assetId), fee)] : []),
    ],
  };
}

/**
 * Cancelled or resolved in the seller's favour — escrow returns untouched.
 *
 * Machine disposition strings (`system:p2p-backstop`, `timeout`, …) are refused
 * on `resolution`. Moderated dispute refunds pass `ruling` with a natural-person
 * `rulingBy` (same allowlist as `escrowRelease`).
 */
export function escrowRefund(input: EscrowInput & { resolution?: string; ruling?: EscrowDisputeRuling }): PostRequest {
  requirePositive('escrow amount', input.amount);
  assertEscrowRefundResolution(input.resolution, 'escrowRefund');
  assertEscrowDisputeRuling(input.ruling, 'escrowRefund');
  const resolution = input.resolution ?? 'cancelled';
  const rulingMeta = disputeRulingMeta(input.ruling);
  return {
    idempotencyKey: `p2p.escrow.refund:${input.tradeId}`,
    module: 'p2p',
    reason: 'p2p.escrow.refund',
    meta: { tradeId: input.tradeId, resolution, ...rulingMeta },
    entries: [
      credit(tradeEscrowAccount(input.sellerId, input.assetId, input.tradeId), input.amount),
      debit(userAvailable(input.sellerId, input.assetId), input.amount),
    ],
  };
}

// ── Payments (§6.1) ──────────────────────────────────────────────────────────
//
// Three recipes cover the whole gateway money path, and they are deliberately
// staged rather than collapsed into one:
//
//   capture     rail → merchant clearing        (value enters the book)
//   settlement  clearing → merchant proceeds + house fee
//   refund      clearing or proceeds → rail     (value leaves the book)
//
// The clearing stop in the middle is what makes "captured but not settled"
// a balance you can read rather than an incident you have to reconstruct.

export interface PaymentCaptureInput {
  paymentId: string;
  merchantId: string;
  assetId: string;
  amount: Amount;
  /** The rail the value arrived on — 'crypto-native', 'card-sandbox', … */
  rail: string;
  /** The rail's own reference for the capture, for reconciliation against it. */
  railRef: string;
}

/**
 * A payment was captured at the rail. Value enters the book.
 *
 * Keyed on the payment, not on the rail reference: the business fact is "this
 * payment was captured", and it happens exactly once however many times a PSP
 * redelivers the webhook that announces it.
 */
export function paymentCapture(input: PaymentCaptureInput): PostRequest {
  requirePositive('capture amount', input.amount);
  return {
    idempotencyKey: `payment.capture:${input.paymentId}`,
    module: 'pay',
    reason: 'payment.captured',
    meta: { paymentId: input.paymentId, merchantId: input.merchantId, rail: input.rail, railRef: input.railRef },
    entries: [
      credit(railBoundary(input.rail, input.assetId), input.amount),
      debit(merchantClearing(input.merchantId, input.assetId), input.amount),
    ],
  };
}

export interface MerchantSettlementInput {
  merchantId: string;
  /**
   * Kept so existing callers still type-check. The recipe does not credit this
   * user. Settled net lands on `merchantProceeds(merchantId)`, not on the
   * owner's trading balance.
   */
  merchantUserId: string;
  /** Settlement window label, e.g. '2026-07-27'. Part of the business key. */
  window: string;
  assetId: string;
  /** Captured, non-refunded value in the window. */
  gross: Amount;
  /** Platform fee for the window. May be zero. */
  fee: Amount;
}

/**
 * Settlement: gross leaves clearing, the fee lands in house fees, and the net
 * is the merchant's proceeds. The owner's `userAvailable` is not a leg.
 *
 * The asset is part of the idempotency key as well as the merchant and window.
 * A merchant settling USDT and BTC for the same day is two settlements; without
 * the asset in the key the second would find the first's transaction, return it,
 * and silently strand a whole currency's takings in clearing.
 *
 * The key is unchanged from the cutover that used to credit `userAvailable`.
 * A window already posted under that key replays the historical transaction
 * (or refuses a different body). It does not also credit proceeds.
 */
export function merchantSettlement(input: MerchantSettlementInput): PostRequest {
  requirePositive('settlement gross', input.gross);
  if (input.fee < 0n) throw new InvalidEntryError('Settlement fee cannot be negative');

  const net = sub(input.gross, input.fee);
  // A fee that swallows the entire settlement is a pricing bug, and posting it
  // would leave the merchant a zero-value transaction as their only record of
  // a window they actually earned in.
  requirePositive('settlement net', net);

  return {
    idempotencyKey: `settlement:${input.merchantId}:${input.window}:${input.assetId}`,
    module: 'pay',
    reason: 'pay.settled',
    meta: { merchantId: input.merchantId, window: input.window, assetId: input.assetId },
    entries: [
      credit(merchantClearing(input.merchantId, input.assetId), input.gross),
      debit(merchantProceeds(input.merchantId, input.assetId), net),
      ...(input.fee > 0n ? [debit(houseFees('pay', input.assetId), input.fee)] : []),
    ],
  };
}

export interface PaymentRefundInput {
  /** Business key for THIS refund — a payment may be refunded in parts. */
  refundId: string;
  paymentId: string;
  merchantId: string;
  /**
   * The owner's trading balance. A settled refund uses it only when
   * `settledPot` is `user`: that payment's settlement post debited
   * `userAvailable`. The default settled pot is proceeds, and a settled refund
   * does not take a shortfall from this balance.
   */
  merchantUserId: string;
  assetId: string;
  amount: Amount;
  rail: string;
  /**
   * Where the money comes back from.
   *
   * Before settlement the value is still in clearing. After settlement it is
   * in the pot that settlement post debited. A settled refund that exceeds
   * that pot fails with insufficient funds.
   */
  source: 'clearing' | 'settled';
  /**
   * Which account a settled refund draws. Omitted means proceeds.
   * `user` is the pre-cutover pot: the settlement key debited `userAvailable`.
   */
  settledPot?: 'proceeds' | 'user';
}

function refundPot(input: PaymentRefundInput): AccountRef {
  if (input.source === 'clearing') return merchantClearing(input.merchantId, input.assetId);
  if (input.settledPot === 'user') return userAvailable(input.merchantUserId, input.assetId);
  return merchantProceeds(input.merchantId, input.assetId);
}

/**
 * Value leaves the book, back out through the rail it came in on.
 *
 * Key is namespaced by `paymentId` so an explicit merchant `refundId` reused
 * on a second payment cannot no-op the ledger while the rail still pays out
 * (cross-payment key collision).
 */
export function paymentRefund(input: PaymentRefundInput): PostRequest {
  requirePositive('refund amount', input.amount);

  const from = refundPot(input);

  return {
    idempotencyKey: `payment.refund:${input.paymentId}:${input.refundId}`,
    module: 'pay',
    reason: 'payment.refunded',
    meta: { paymentId: input.paymentId, refundId: input.refundId, source: input.source, rail: input.rail },
    entries: [credit(from, input.amount), debit(railBoundary(input.rail, input.assetId), input.amount)],
  };
}

/**
 * The refund did not go out after all — the rail refused it.
 *
 * Same shape as `withdrawReverse`: the reversal path on an outbound movement is
 * DEFINED, not improvised. svc-pay debits the merchant before asking the rail
 * to send anything, so a rail that says no leaves value sitting at the boundary
 * that belongs back with the merchant, and this puts it there.
 *
 * A separate transaction rather than an edit, because a ledger reverses; it
 * does not amend. Both postings stay in the journal and the trail reads
 * "we tried, it failed, we put it back".
 */
export function paymentRefundReverse(input: PaymentRefundInput): PostRequest {
  requirePositive('refund reversal amount', input.amount);

  const to = refundPot(input);

  return {
    idempotencyKey: `payment.refund.reverse:${input.paymentId}:${input.refundId}`,
    module: 'pay',
    reason: 'payment.refund.reversed',
    meta: { paymentId: input.paymentId, refundId: input.refundId, source: input.source, rail: input.rail },
    entries: [credit(railBoundary(input.rail, input.assetId), input.amount), debit(to, input.amount)],
  };
}

export interface MerchantProceedsPayoutInput {
  merchantId: string;
  assetId: string;
  amount: Amount;
  rail: string;
  /** `${settlementId}:${payoutAttempt}` so a retry is a new hold. */
  withdrawalId: string;
}

/**
 * Merchant payout, step 1. Proceeds decrease; the purpose hold on the same
 * owner increases. Not `withdrawHold`: that recipe debits `userAvailable`.
 */
function merchantProceedsPayoutHold(input: MerchantProceedsPayoutInput): PostRequest {
  requirePositive('payout amount', input.amount);
  return {
    idempotencyKey: `pay.proceeds.payout.hold:${input.withdrawalId}`,
    module: 'pay',
    reason: 'pay.proceeds.payout.held',
    meta: { merchantId: input.merchantId, rail: input.rail, withdrawalId: input.withdrawalId },
    entries: [
      credit(merchantProceeds(input.merchantId, input.assetId), input.amount),
      debit(merchantProceedsPayoutHoldAccount(input.merchantId, input.assetId, input.withdrawalId), input.amount),
    ],
  };
}

/** Merchant payout, step 2a. The hold leaves the book through the rail. */
export function merchantProceedsPayoutSettle(input: MerchantProceedsPayoutInput): PostRequest {
  requirePositive('payout amount', input.amount);
  return {
    idempotencyKey: `pay.proceeds.payout.settle:${input.withdrawalId}`,
    module: 'pay',
    reason: 'pay.proceeds.payout.settled',
    meta: { merchantId: input.merchantId, rail: input.rail, withdrawalId: input.withdrawalId },
    entries: [
      credit(merchantProceedsPayoutHoldAccount(input.merchantId, input.assetId, input.withdrawalId), input.amount),
      debit(railBoundary(input.rail, input.assetId), input.amount),
    ],
  };
}

/**
 * Merchant payout, step 2b. The rail refused. Value returns to proceeds.
 * A reverse onto `userAvailable` would put merchant money on the personal book.
 */
export function merchantProceedsPayoutReverse(input: MerchantProceedsPayoutInput): PostRequest {
  requirePositive('payout reversal amount', input.amount);
  return {
    idempotencyKey: `pay.proceeds.payout.reverse:${input.withdrawalId}`,
    module: 'pay',
    reason: 'pay.proceeds.payout.reversed',
    meta: { merchantId: input.merchantId, rail: input.rail, withdrawalId: input.withdrawalId },
    entries: [
      credit(merchantProceedsPayoutHoldAccount(input.merchantId, input.assetId, input.withdrawalId), input.amount),
      debit(merchantProceeds(input.merchantId, input.assetId), input.amount),
    ],
  };
}

// ── Token: staking, emissions, burn (§4.3) ───────────────────────────────────

export interface StakeInput {
  stakeId: string;
  userId: string;
  assetId: string;
  amount: Amount;
  tier: 'flex' | 'm3' | 'm12';
}

export function stake(input: StakeInput): PostRequest {
  requirePositive('stake amount', input.amount);
  return {
    idempotencyKey: `token.stake:${input.stakeId}`,
    module: 'token',
    reason: 'token.stake',
    meta: { stakeId: input.stakeId, tier: input.tier },
    entries: [
      credit(userAvailable(input.userId, input.assetId), input.amount),
      debit(tokenStakeAccount(input.userId, input.assetId, input.stakeId), input.amount),
    ],
  };
}

export function unstake(input: StakeInput): PostRequest {
  requirePositive('unstake amount', input.amount);
  return {
    idempotencyKey: `token.unstake:${input.stakeId}`,
    module: 'token',
    reason: 'token.unstake',
    meta: { stakeId: input.stakeId, tier: input.tier },
    entries: [
      credit(tokenStakeAccount(input.userId, input.assetId, input.stakeId), input.amount),
      debit(userAvailable(input.userId, input.assetId), input.amount),
    ],
  };
}

export interface MintInput {
  epoch: number;
  assetId: string;
  amount: Amount;
  /** Where newly minted supply lands — a pool payout account or the rewards engine. */
  destination: AccountRef;
}

/** svc-token is the only minter (§4.3). New supply enters at the mint boundary. */
export function mintEmission(input: MintInput): PostRequest {
  requirePositive('emission amount', input.amount);
  return {
    // Asset in the key: one epoch can mint more than one asset. Without it the
    // second asset's post is an idempotent no-op of the first (supply never lands).
    idempotencyKey: `token.emission:${input.assetId}:${input.epoch}`,
    module: 'token',
    reason: 'token.emission',
    meta: { epoch: input.epoch, assetId: input.assetId },
    entries: [credit(mintBoundary(input.assetId), input.amount), debit(input.destination, input.amount)],
  };
}

export interface BurnInput {
  runId: string;
  assetId: string;
  amount: Amount;
  from: AccountRef;
}

/** Tokens debited to the burn account never move again. */
export function burn(input: BurnInput): PostRequest {
  requirePositive('burn amount', input.amount);
  return {
    // Asset in the key: same runId across assets must not collide.
    idempotencyKey: `token.burn:${input.assetId}:${input.runId}`,
    module: 'token',
    reason: 'token.burn',
    meta: { runId: input.runId, assetId: input.assetId },
    entries: [credit(input.from, input.amount), debit(burnAccount(input.assetId), input.amount)],
  };
}

// ── Fees & rewards ───────────────────────────────────────────────────────────

export type FeeChargeInput = {
  chargeId: string;
  userId: string;
  module: string;
  reason?: string;
} & (
  | { mode: 'asset'; assetId: string; amount: Amount }
  | {
      /**
       * §4.3 fee-discount branch: the payer settles the fee in IFC and the
       * published decay schedule takes a cut off the gross. The caller supplies
       * the converted token amount — the recipe does not price anything.
       */
      mode: 'token';
      tokenAssetId: string;
      grossTokenAmount: Amount;
      discountBps: number;
    }
);

export function feeCharge(input: FeeChargeInput): PostRequest {
  if (input.mode === 'asset') {
    requirePositive('fee amount', input.amount);
    return {
      idempotencyKey: `fee:${input.module}:${input.chargeId}`,
      module: input.module,
      reason: input.reason ?? 'fee.charged',
      meta: { mode: 'asset' },
      entries: [
        credit(userAvailable(input.userId, input.assetId), input.amount),
        debit(houseFees(input.module, input.assetId), input.amount),
      ],
    };
  }

  requirePositive('fee amount', input.grossTokenAmount);
  if (input.discountBps < 0 || input.discountBps >= 10_000) {
    throw new InvalidEntryError(`Fee discount must be between 0 and 9999 bps, got ${input.discountBps}`);
  }

  // Discount rounds in the payer's favour: they never pay a rounding unit more
  // than the published schedule promises.
  const discount = mulBps(input.grossTokenAmount, input.discountBps, 'ceil');
  const net = sub(input.grossTokenAmount, discount);
  requirePositive('discounted fee amount', net);

  return {
    idempotencyKey: `fee:${input.module}:${input.chargeId}`,
    module: input.module,
    reason: input.reason ?? 'fee.charged',
    meta: { mode: 'token', discountBps: input.discountBps, gross: input.grossTokenAmount.toString() },
    entries: [credit(userAvailable(input.userId, input.tokenAssetId), net), debit(houseFees(input.module, input.tokenAssetId), net)],
  };
}

export interface RewardPayInput {
  rewardId: string;
  userId: string;
  assetId: string;
  amount: Amount;
  reason: string;
}

export interface FeeSweepInput {
  /** Identifies the revenue window being swept — the dedupe key. */
  windowId: string;
  /** Module whose fee account is being drained, e.g. 'trade'. */
  sourceModule: string;
  assetId: string;
  amount: Amount;
}

/**
 * Move accrued fees from a module's house account into the rewards engine, so
 * real-yield can be paid out of one pot (§4.3).
 *
 * This is what makes staking yield *real revenue* rather than emissions: the
 * value paid to stakers demonstrably came from fees the platform actually
 * earned, and the trail from `houseFees(module)` to a user's balance is two
 * ledger transactions, both queryable.
 */
export function sweepFeesToRewards(input: FeeSweepInput): PostRequest {
  requirePositive('fee sweep amount', input.amount);
  return {
    idempotencyKey: `token.fee.sweep:${input.windowId}:${input.sourceModule}:${input.assetId}`,
    module: 'token',
    reason: 'token.fee.swept',
    meta: { windowId: input.windowId, sourceModule: input.sourceModule },
    entries: [credit(houseFees(input.sourceModule, input.assetId), input.amount), debit(rewardsEngine(input.assetId), input.amount)],
  };
}

/** Real-yield distribution, cashback, tournament prizes — all from one pot. */
export function rewardPay(input: RewardPayInput): PostRequest {
  requirePositive('reward amount', input.amount);
  return {
    idempotencyKey: `reward:${input.rewardId}`,
    module: 'token',
    reason: input.reason,
    meta: { rewardId: input.rewardId },
    entries: [credit(rewardsEngine(input.assetId), input.amount), debit(userAvailable(input.userId, input.assetId), input.amount)],
  };
}

// ── Lending (§8.1) ───────────────────────────────────────────────────
//
// Moved to ./loans.ts, and REWRITTEN rather than relocated. Three stubs used to
// live here — `collateralLock`, `collateralRelease` and `liquidate`. Nothing in
// the monorepo called any of them, and a loan could not have been built on them:
// there was no way to release principal, no debt for a repayment to reduce, the
// whole of a seizure was booked as house revenue, and the liquidation key allowed
// exactly one liquidation per loan for all time. ./loans.ts sets out each one.

export * from './bank.js';
export * from './loans.js';
export * from './chargeback.js';
export * from './order-hold-amend.js';
export * from './futures-order-margin.js';
export * from './pay-received-hold.js';
export * from './bank-transfer-reversal.js';
export * from './staff-hold.js';
export * from './campaign-lock.js';
export {
  marketPurchase,
  marketListingFee,
  marketPremiumPlacement,
  type MarketPurchaseInput,
  type MarketListingFeeInput,
  type MarketPremiumPlacementInput,
} from './market.js';
export {
  fxConversion,
  fxConversionHold,
  fxConversionLateFill,
  fxConversionRelease,
  fxConversionReverse,
  type FxConversionHoldInput,
  type FxConversionInput,
  type FxConversionLateFillInput,
} from './conversion.js';

export const recipes = {
  deposit,
  depositReverse,
  marketMakerSeedFund,
  withdrawHold,
  withdrawSettle,
  withdrawReverse,
  withdrawReturned,
  tradeFill,
  tradeFillFeeCorrection,
  tradeFillMakerRebate,
  orderHold,
  orderHoldRelease,
  orderHoldAmend,
  marketMakerOrderHold,
  marketMakerOrderHoldRelease,
  marketMakerMakerFill,
  futuresMarginLock,
  futuresMarginAdd,
  futuresMarginRelease,
  futuresOrderMarginHold,
  futuresOrderMarginRelease,
  futuresOrderMarginApply,
  futuresRealizeLoss,
  futuresRealizeProfit,
  futuresFundingPay,
  futuresInsuranceTopup,
  escrowLock,
  escrowRelease,
  escrowRefund,
  paymentCapture,
  merchantSettlement,
  paymentRefund,
  paymentRefundReverse,
  merchantProceedsPayoutHold,
  merchantProceedsPayoutSettle,
  merchantProceedsPayoutReverse,
  // §6.1 chargebacks — see ./chargeback.ts. ⚠ NEW RECIPES, OWNER SIGN-OFF
  // REQUIRED BEFORE MERGE (DIRECTION §3 Class M). Nothing calls them yet: they
  // exist so a card rail can be honest about a dispute before one is written,
  // which is clause 3 of the 2026-08-04 ADR's done bar for `pay.rails`.
  // No existing recipe was modified to add them.
  chargebackOpen,
  chargebackShortfall,
  chargebackWon,
  chargebackShortfallRecovered,
  stake,
  unstake,
  mintEmission,
  burn,
  feeCharge,
  sweepFeesToRewards,
  rewardPay,
  // §8.1 loans — see ./loans.ts. Flagged shared-package change; replaces the
  // three unreachable collateral stubs that used to sit here.
  loanCollateralLock,
  loanCollateralRelease,
  loanDraw,
  loanRepay,
  loanLiquidate,
  loanBadDebt,
  loanReserveFund,
  // §8.1 svc-bank — see ./bank.ts. Flagged shared-package change.
  bankTransfer,
  earnDeposit,
  earnWithdraw,
  earnPoolFund,
  earnInterest,
  // bank.business dual-control — purposed holds so pending is not paper-only.
  businessApprovalHold,
  businessApprovalRelease,
  businessApprovalSettle,
  businessPayroll,
  // SPEC-SUBACCOUNTS — only legal cross-partition value path. See ./sub-accounts.ts.
  subAccountTransfer,
  payReceivedHold,
  payReceivedRelease,
  payReceivedReturn,
  bankTransferReversal,
  // ops staff holds (OPS-accounts-desk-01, ops ENGINE LC-8/LC-9), posted by svc-ops staff-holds/desk.ts. See ./staff-hold.ts.
  staffHoldPlace,
  staffHoldRelease,
  staffHoldConfirm,
  // locked campaign rewards and bonuses (CM-payouts-ledger-01, CM-rewards-hub-02). See ./campaign-lock.ts.
  campaignRewardLock,
  campaignRewardUnlock,
  campaignRewardForfeit,
  // §8.7 market — purchase (live) + listing/premium fees (§13 unwired; D26-P1-M2).
  // Flagged shared-package. No existing recipe body was rewritten for the fee legs.
  marketPurchase,
  marketListingFee,
  marketPremiumPlacement,
  // W6 sandbox conversion. USD and USDT on separate accounts; fee and spread to house revenue.
  // Hold and release reserve clearing around the venue call. Reverse keeps the venue legs.
  fxConversion,
  fxConversionHold,
  fxConversionRelease,
  fxConversionReverse,
  // Late fill after the hold was released. Clearing pays the merchant when it can cover.
  // Inventory takes the venue position only: no second credit to the merchant.
  fxConversionLateFill,
} as const;

export type RecipeName = keyof typeof recipes;
