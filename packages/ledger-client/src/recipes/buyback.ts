import { houseFees, houseHold, rewardsEngine, orderHoldAccount, userAvailable } from '../accounts.js';
import { mulBps, sub, type Amount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';

/**
 * The token buyback's own buy on the spot book (J-dex-protocol-17).
 *
 * The buy is funded by the existing `sweepFeesToRewards`: svc-token sweeps the fee share it will spend from
 * `houseFees(<module>, <quote>)` into `rewardsEngine(<quote>)`, so no recipe here touches a fee pot to fund it.
 * svc-trade then reserves the spend for one IOC order in the rewards engine's own hold (`buybackOrderHold`), settles each fill against a resting
 * customer ask (`buybackTakerFill`) and returns any unfilled remainder (`buybackOrderHoldRelease`). The bought base
 * lands in `rewardsEngine(<base>)`, where svc-token's settle burns its share and leaves the rest for rewards.
 *
 * The house is always the taker and always buys. It charges itself no taker fee. The customer maker pays the maker
 * fee the caller states, into `houseFees('trade', <quote>)`, as on a `tradeFill`; that is the one fee leg here
 * (fee-revenue map row `trade.spot.buyback_maker_fee`). A resting house market-maker ask has no recipe: house against
 * house is wash volume, and svc-trade refuses that match before it posts anything.
 *
 * svc-ledger's history and holdings reads know `trade.fill.buyback` as a fill. Other readers that list fill reasons
 * (svc-tax lots, svc-bank activity, the customer ledger tab) do not yet: until they learn it, svc-tax reads the sold
 * base as an outflow from outside the lot book, and svc-bank files the line as other activity.
 */

export interface BuybackOrderHoldInput {
  /** The IOC order svc-trade placed for one buyback run. */
  orderId: string;
  quoteAsset: string;
  amount: Amount;
}

export interface BuybackOrderHoldReleaseInput extends BuybackOrderHoldInput {
  sequence?: number;
}

export interface BuybackTakerFillInput {
  fillId: string;
  /** The customer whose resting ask was hit. */
  makerId: string;
  makerOrderId: string;
  /** The buyback IOC order, whose hold pays the quote. */
  takerOrderId: string;
  baseAsset: string;
  quoteAsset: string;
  /** Base quantity bought. */
  qty: Amount;
  /** Total quote value of the fill (price × qty, already rounded by the engine). */
  quoteAmount: Amount;
  makerFeeBps: number;
}

const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

function requirePositive(name: string, value: Amount): void {
  if (value <= 0n) throw new InvalidEntryError(`${name} must be positive`);
}

function requireId(name: string, value: string | undefined): string {
  const id = value ?? '';
  if (!id.trim() || id.trim() !== id) throw new InvalidEntryError(`${name} is required, with no surrounding spaces`);
  return id;
}

/**
 * The reservation for one buyback IOC order. It is the rewards engine's own hold, because a lock must be funded from
 * the same owner's available balance (`assertPairedLocks`): the spend never leaves the rewards engine's name until it
 * fills.
 */
export function buybackOrderHoldAccount(assetId: string, orderId: string): AccountRef {
  return houseHold(rewardsEngine(assetId).ownerId, assetId, `order:${requireId('orderId', orderId)}`);
}

/** Reserve the swept quote for one buyback IOC order: rewards engine → that order's house hold. */
export function buybackOrderHold(input: BuybackOrderHoldInput): PostRequest {
  const orderId = requireId('orderId', input.orderId);
  requireId('quoteAsset', input.quoteAsset);
  requirePositive('buyback order hold amount', input.amount);
  return {
    idempotencyKey: `order.hold.buyback:${orderId}`,
    module: 'trade',
    reason: 'order.hold.buyback',
    meta: { orderId, house: 'buyback' },
    entries: [
      credit(rewardsEngine(input.quoteAsset), input.amount),
      debit(buybackOrderHoldAccount(input.quoteAsset, orderId), input.amount),
    ],
  };
}

/** Return the unfilled remainder of a buyback IOC order to the rewards engine. */
export function buybackOrderHoldRelease(input: BuybackOrderHoldReleaseInput): PostRequest {
  const orderId = requireId('orderId', input.orderId);
  requireId('quoteAsset', input.quoteAsset);
  requirePositive('buyback order release amount', input.amount);
  const sequence = input.sequence ?? 0;
  if (!Number.isInteger(sequence) || sequence < 0) throw new InvalidEntryError(`sequence must be a whole number, got ${sequence}`);
  return {
    idempotencyKey: `order.release.buyback:${orderId}:${sequence}`,
    module: 'trade',
    reason: 'order.hold.buyback.released',
    meta: { orderId, house: 'buyback' },
    entries: [
      credit(buybackOrderHoldAccount(input.quoteAsset, orderId), input.amount),
      debit(rewardsEngine(input.quoteAsset), input.amount),
    ],
  };
}

/**
 * One fill of the buyback IOC order against a customer's resting ask.
 *
 * Quote leaves the buyback order's hold: the maker receives it less the maker fee, and the fee goes to
 * `houseFees('trade', <quote>)`. Base leaves the maker's own order hold into `rewardsEngine(<base>)`, in full, since
 * the house takes no taker fee from itself.
 */
export function buybackTakerFill(input: BuybackTakerFillInput): PostRequest {
  const fillId = requireId('fillId', input.fillId);
  const makerId = requireId('makerId', input.makerId);
  const makerOrderId = requireId('makerOrderId', input.makerOrderId);
  const takerOrderId = requireId('takerOrderId', input.takerOrderId);
  requireId('baseAsset', input.baseAsset);
  requireId('quoteAsset', input.quoteAsset);
  requirePositive('fill qty', input.qty);
  requirePositive('fill quote amount', input.quoteAmount);
  if (!Number.isInteger(input.makerFeeBps) || input.makerFeeBps < 0) {
    throw new InvalidEntryError(`makerFeeBps must be a whole number of bps, got ${input.makerFeeBps}`);
  }
  if (input.baseAsset === input.quoteAsset) throw new InvalidEntryError('A buyback fill needs two different assets');

  const makerFee = mulBps(input.quoteAmount, input.makerFeeBps);
  const makerReceives = sub(input.quoteAmount, makerFee);
  // `<= 0n` for the same reason as `tradeFill`: a fee equal to the receivable would emit a zero-amount entry.
  if (makerReceives <= 0n) throw new InvalidEntryError('Fee exceeds fill value — check fee bps configuration');

  return {
    idempotencyKey: `trade.fill.buyback:${fillId}`,
    module: 'trade',
    reason: 'trade.fill.buyback',
    meta: {
      fillId,
      takerSide: 'buy',
      makerFeeBps: input.makerFeeBps,
      takerFeeBps: 0,
      makerOrderId,
      takerOrderId,
      house: 'buyback',
    },
    entries: [
      credit(buybackOrderHoldAccount(input.quoteAsset, takerOrderId), input.quoteAmount),
      debit(userAvailable(makerId, input.quoteAsset), makerReceives),
      ...(makerFee > 0n ? [debit(houseFees('trade', input.quoteAsset), makerFee)] : []),
      credit(orderHoldAccount(makerId, input.baseAsset, makerOrderId), input.qty),
      debit(rewardsEngine(input.baseAsset), input.qty),
    ],
  };
}
