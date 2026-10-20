import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import type { MarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import type { ComboLeg, EngineAmend, EngineOrder, EngineOrderType, OrderId, OrderSide, SpreadTerms, TimeInForce } from './types.js';
import { fromWireSpread, toWireSpread, type WireSpreadInstrument } from './spread-instrument.js';
import {
  persistAon,
  persistAuction,
  persistBenchmark,
  persistCollar,
  persistCombo,
  persistExercise,
  persistExpiry,
  persistIceberg,
  persistLegs,
  persistMax,
  persistMin,
  persistMinNotional,
  persistMinQty,
  persistMidpoint,
  persistOffset,
  persistPeg,
  persistReference,
  persistRelative,
  persistStrike,
  persistTrail,
} from './journal-persist.js';

export interface WireOrder {
  readonly orderId: OrderId;
  readonly accountId: string;
  readonly type: EngineOrderType;
  readonly side: OrderSide;
  readonly qty: string;
  readonly price: string | null;
  readonly stopPrice: string | null;
  readonly tif: TimeInForce;
  readonly ocoSiblingId?: string;
  readonly bracket?: boolean;
  readonly oco?: boolean;
  readonly takeProfit?: string | null;
  readonly stopLoss?: string | null;
  readonly stopLossLimit?: string | null;
  readonly takeProfitOrderId?: string | null;
  readonly stopLossOrderId?: string | null;
  readonly expireAt?: string;
  /** Caller session for cancel-on-disconnect. Absent when untagged. Never invented. */
  readonly sessionId?: string;
  /**
   * Caller client order id. Absent when the caller did not supply one.
   * Recover reads this off the journaled submit. Never invented.
   */
  readonly clientOrderId?: string;
  /**
   * Caller environment for the client-id domain. Absent when not supplied.
   * Missing stays empty in the domain key — never a silent 'live' stamp.
   */
  readonly environment?: string;
  readonly reduceOnly?: boolean;
  readonly triggerRole?: 'take_profit' | 'stop_loss';
  readonly triggerBy?: 'last' | 'mark' | 'index';
  readonly instrument?: 'option' | 'option_combo';
  readonly positionQty?: string;
  readonly displayQty?: string | null;
  readonly iceberg?: boolean;
  /** Trail distance. Absent when the rest is not a trailing stop. */
  readonly trail?: string | null;
  /** Injected mark the trail walks with. Absent when not supplied. */
  readonly mark?: string | null;
  /** Strike. Absent when the rest is not an option. */
  readonly strike?: string | null;
  /** Expiry. Absent when the rest is not an option. */
  readonly expiry?: string | null;
  /** Exercise a long option at strike. Absent when not requested. Replay must still exercise rather than rest. */
  readonly exercise?: boolean;
  /** Minimum fill qty. Absent when not set. */
  readonly minQty?: string | null;
  /** All-or-none. Absent when not set. */
  readonly aon?: boolean;
  /** Pegged. Absent when not set. Replay binds reference + offset; missing those refuses. */
  readonly peg?: boolean;
  /** Midpoint. Absent when not set. Replay must still refuse. */
  readonly midpoint?: boolean;
  /** Relative. Absent when not set. Replay binds reference + offset; missing those refuses. */
  readonly relative?: boolean;
  /** Caller reference for peg/relative. Absent when not supplied. */
  readonly reference?: string | null;
  /** Caller offset for peg/relative. Absent when not supplied. */
  readonly offset?: string | null;
  /** Auction. Absent when not set. Replay must still refuse. */
  readonly auction?: boolean;
  /** Benchmark. Absent when not set. Replay must still refuse. */
  readonly benchmark?: boolean;
  /** Price collar. Absent when not set. Replay must still refuse a missing band. */
  readonly collar?: boolean;
  /** Caller collar min. Absent when not supplied. */
  readonly min?: string | null;
  /** Caller collar max. Absent when not supplied. */
  readonly max?: string | null;
  /** Caller min notional. Absent when not requested. Replay must still refuse a missing notional. */
  readonly minNotional?: string | null;
  /** Combo / multi-leg. Absent when not set. Replay must still refuse missing named legs. */
  readonly combo?: boolean;
  /** Named combo legs. Absent when not supplied. Replay must still refuse. */
  readonly legs?: readonly WireComboLeg[] | null;
  /** Spread order: the listing it was admitted under and the caller anchor reference. Absent on an outright order. */
  readonly spread?: WireSpreadTerms;
  /** Exact PX-S01 admission evidence for new HTTP submissions. */
  readonly lifecycleProof?: MarketLifecycleAdmissionProof;
}

/** Wire combo leg. Ratio/strike are decimal strings. Replay must still refuse missing fields. */
export interface WireComboLeg {
  readonly name?: string | null;
  readonly ratio?: string | null;
  readonly strike?: string | null;
  readonly expiry?: string | null;
}

/** Wire spread terms. Decimal strings. A missing reference stays null so replay refuses it the same way. */
export interface WireSpreadTerms {
  readonly instrument: WireSpreadInstrument;
  readonly anchorReference: string | null;
}

export interface WireAmendPatch {
  readonly qty?: string;
  readonly price?: string;
  readonly stopPrice?: string;
  readonly tif?: TimeInForce;
  readonly expireAt?: string;
  readonly strike?: string | null;
  readonly expiry?: string | null;
}

function toWireLegs(legs: readonly ComboLeg[] | null | undefined): readonly WireComboLeg[] | null {
  if (legs == null) return null;
  return legs.map((leg) => ({
    name: leg.name ?? null,
    ratio: leg.ratio == null ? null : formatAmount(leg.ratio),
    strike: leg.strike == null ? null : formatAmount(leg.strike),
    expiry: leg.expiry ?? null,
  }));
}

function fromWireLegs(legs: readonly WireComboLeg[] | null | undefined): readonly ComboLeg[] | null {
  if (legs == null) return null;
  return legs.map((leg) => ({
    name: leg.name ?? null,
    ratio: leg.ratio == null ? null : parseAmount(leg.ratio),
    strike: leg.strike == null ? null : parseAmount(leg.strike),
    expiry: leg.expiry ?? null,
  }));
}

function toWireSpreadTerms(terms: SpreadTerms): WireSpreadTerms {
  return {
    instrument: toWireSpread(terms.instrument),
    anchorReference: terms.anchorReference == null ? null : formatAmount(terms.anchorReference),
  };
}

function fromWireSpreadTerms(terms: WireSpreadTerms): SpreadTerms {
  return {
    instrument: fromWireSpread(terms.instrument),
    anchorReference: terms.anchorReference == null ? null : parseAmount(terms.anchorReference),
  };
}

export function toWire(order: EngineOrder, lifecycleProof?: MarketLifecycleAdmissionProof): WireOrder {
  return {
    orderId: order.orderId,
    accountId: order.accountId,
    type: order.type,
    side: order.side,
    qty: formatAmount(order.qty),
    price: order.price === null ? null : formatAmount(order.price),
    stopPrice: order.stopPrice === null ? null : formatAmount(order.stopPrice),
    tif: order.tif,
    ...(order.triggerRole === 'take_profit' || order.triggerRole === 'stop_loss' ? { triggerRole: order.triggerRole } : {}),
    ...(order.triggerBy === 'mark' || order.triggerBy === 'index' || order.triggerBy === 'last' ? { triggerBy: order.triggerBy } : {}),
    ...(order.instrument === 'option' || order.instrument === 'option_combo' ? { instrument: order.instrument } : {}),
    ...(order.positionQty !== undefined && order.positionQty !== null ? { positionQty: formatAmount(order.positionQty) } : {}),
    ...(order.ocoSiblingId ? { ocoSiblingId: order.ocoSiblingId } : {}),
    ...(order.bracket !== undefined ? { bracket: order.bracket } : {}),
    ...(order.oco === true ? { oco: true } : {}),
    ...(order.takeProfit !== undefined ? { takeProfit: order.takeProfit === null ? null : formatAmount(order.takeProfit) } : {}),
    ...(order.stopLoss !== undefined ? { stopLoss: order.stopLoss === null ? null : formatAmount(order.stopLoss) } : {}),
    ...(order.stopLossLimit !== undefined
      ? { stopLossLimit: order.stopLossLimit === null ? null : formatAmount(order.stopLossLimit) }
      : {}),
    ...(order.takeProfitOrderId !== undefined ? { takeProfitOrderId: order.takeProfitOrderId } : {}),
    ...(order.stopLossOrderId !== undefined ? { stopLossOrderId: order.stopLossOrderId } : {}),
    ...(order.expireAt ? { expireAt: order.expireAt } : {}),
    ...(order.sessionId ? { sessionId: order.sessionId } : {}),
    ...(order.clientOrderId ? { clientOrderId: order.clientOrderId } : {}),
    ...(order.environment ? { environment: order.environment } : {}),
    ...(order.reduceOnly ? { reduceOnly: true } : {}),
    ...(persistIceberg(order) ? { iceberg: true, displayQty: order.displayQty == null ? null : formatAmount(order.displayQty) } : {}),
    ...(persistTrail(order)
      ? {
          trail: order.trail == null ? null : formatAmount(order.trail),
          ...(order.mark !== undefined ? { mark: order.mark == null ? null : formatAmount(order.mark) } : {}),
        }
      : {}),
    ...(persistStrike(order) ? { strike: order.strike == null ? null : formatAmount(order.strike) } : {}),
    ...(persistExpiry(order) ? { expiry: order.expiry == null ? null : order.expiry } : {}),
    ...(persistExercise(order) ? { exercise: true } : {}),
    ...(persistMinQty(order) ? { minQty: order.minQty == null ? null : formatAmount(order.minQty) } : {}),
    ...(persistAon(order) ? { aon: order.aon === true } : {}),
    ...(persistPeg(order) ? { peg: order.peg === true } : {}),
    ...(persistMidpoint(order) ? { midpoint: order.midpoint === true } : {}),
    ...(persistRelative(order) ? { relative: order.relative === true } : {}),
    ...(persistReference(order) ? { reference: order.reference == null ? null : formatAmount(order.reference) } : {}),
    ...(persistOffset(order) ? { offset: order.offset == null ? null : formatAmount(order.offset) } : {}),
    ...(persistAuction(order) ? { auction: order.auction === true } : {}),
    ...(persistBenchmark(order) ? { benchmark: order.benchmark === true } : {}),
    ...(persistCollar(order) ? { collar: order.collar === true } : {}),
    ...(persistMin(order) ? { min: order.min == null ? null : formatAmount(order.min) } : {}),
    ...(persistMax(order) ? { max: order.max == null ? null : formatAmount(order.max) } : {}),
    ...(persistMinNotional(order) ? { minNotional: order.minNotional == null ? null : formatAmount(order.minNotional) } : {}),
    ...(persistCombo(order) ? { combo: order.combo === true } : {}),
    ...(persistLegs(order) ? { legs: toWireLegs(order.legs) } : {}),
    ...(order.spread != null ? { spread: toWireSpreadTerms(order.spread) } : {}),
    lifecycleProof,
  };
}

export function fromWire(order: WireOrder): EngineOrder {
  return {
    orderId: order.orderId,
    accountId: order.accountId,
    type: order.type,
    side: order.side,
    qty: parseAmount(order.qty),
    price: order.price === null ? null : parseAmount(order.price),
    stopPrice: order.stopPrice === null ? null : parseAmount(order.stopPrice),
    tif: order.tif,
    ...(order.triggerRole === 'take_profit' || order.triggerRole === 'stop_loss' ? { triggerRole: order.triggerRole } : {}),
    ...(order.triggerBy === 'mark' || order.triggerBy === 'index' || order.triggerBy === 'last' ? { triggerBy: order.triggerBy } : {}),
    ...(order.instrument === 'option' || order.instrument === 'option_combo' ? { instrument: order.instrument } : {}),
    ...(order.positionQty !== undefined ? { positionQty: parseAmount(order.positionQty) } : {}),
    ...(order.ocoSiblingId ? { ocoSiblingId: order.ocoSiblingId } : {}),
    ...(order.bracket !== undefined ? { bracket: order.bracket } : {}),
    ...(order.oco === true ? { oco: true } : {}),
    ...(order.takeProfit !== undefined ? { takeProfit: order.takeProfit === null ? null : parseAmount(order.takeProfit) } : {}),
    ...(order.stopLoss !== undefined ? { stopLoss: order.stopLoss === null ? null : parseAmount(order.stopLoss) } : {}),
    ...(order.stopLossLimit !== undefined ? { stopLossLimit: order.stopLossLimit === null ? null : parseAmount(order.stopLossLimit) } : {}),
    ...(order.takeProfitOrderId !== undefined ? { takeProfitOrderId: order.takeProfitOrderId } : {}),
    ...(order.stopLossOrderId !== undefined ? { stopLossOrderId: order.stopLossOrderId } : {}),
    ...(order.expireAt ? { expireAt: order.expireAt } : {}),
    ...(order.sessionId ? { sessionId: order.sessionId } : {}),
    ...(order.clientOrderId ? { clientOrderId: order.clientOrderId } : {}),
    ...(order.environment ? { environment: order.environment } : {}),
    ...(order.reduceOnly ? { reduceOnly: true } : {}),
    ...(persistIceberg(order) ? { iceberg: true, displayQty: order.displayQty == null ? null : parseAmount(order.displayQty) } : {}),
    ...(persistTrail(order)
      ? {
          trail: order.trail == null ? null : parseAmount(order.trail),
          ...(order.mark !== undefined ? { mark: order.mark == null ? null : parseAmount(order.mark) } : {}),
        }
      : {}),
    ...(persistStrike(order) ? { strike: order.strike == null ? null : parseAmount(order.strike) } : {}),
    ...(persistExpiry(order) ? { expiry: order.expiry == null ? null : order.expiry } : {}),
    ...(persistExercise(order) ? { exercise: true } : {}),
    ...(persistMinQty(order) ? { minQty: order.minQty == null ? null : parseAmount(order.minQty) } : {}),
    ...(persistAon(order) ? { aon: order.aon === true } : {}),
    ...(persistPeg(order) ? { peg: order.peg === true } : {}),
    ...(persistMidpoint(order) ? { midpoint: order.midpoint === true } : {}),
    ...(persistRelative(order) ? { relative: order.relative === true } : {}),
    ...(persistReference(order) ? { reference: order.reference == null ? null : parseAmount(order.reference) } : {}),
    ...(persistOffset(order) ? { offset: order.offset == null ? null : parseAmount(order.offset) } : {}),
    ...(persistAuction(order) ? { auction: order.auction === true } : {}),
    ...(persistBenchmark(order) ? { benchmark: order.benchmark === true } : {}),
    ...(persistCollar(order) ? { collar: order.collar === true } : {}),
    ...(persistMin(order) ? { min: order.min == null ? null : parseAmount(order.min) } : {}),
    ...(persistMax(order) ? { max: order.max == null ? null : parseAmount(order.max) } : {}),
    ...(persistMinNotional(order) ? { minNotional: order.minNotional == null ? null : parseAmount(order.minNotional) } : {}),
    ...(persistCombo(order) ? { combo: order.combo === true } : {}),
    ...(persistLegs(order) ? { legs: fromWireLegs(order.legs) } : {}),
    ...(order.spread != null ? { spread: fromWireSpreadTerms(order.spread) } : {}),
  };
}

export function toWireAmend(cmd: EngineAmend): WireAmendPatch {
  return {
    ...(cmd.qty !== undefined ? { qty: formatAmount(cmd.qty) } : {}),
    ...(cmd.price !== undefined ? { price: formatAmount(cmd.price) } : {}),
    ...(cmd.stopPrice !== undefined ? { stopPrice: formatAmount(cmd.stopPrice) } : {}),
    ...(cmd.tif !== undefined ? { tif: cmd.tif } : {}),
    ...(cmd.expireAt !== undefined ? { expireAt: cmd.expireAt } : {}),
    ...(cmd.strike !== undefined ? { strike: cmd.strike === null ? null : formatAmount(cmd.strike) } : {}),
    ...(cmd.expiry !== undefined ? { expiry: cmd.expiry } : {}),
  };
}

export function fromWireAmend(orderId: OrderId, expectedVersion: number, patch: WireAmendPatch): EngineAmend {
  return {
    orderId,
    expectedVersion,
    ...(patch.qty !== undefined ? { qty: parseAmount(patch.qty) } : {}),
    ...(patch.price !== undefined ? { price: parseAmount(patch.price) } : {}),
    ...(patch.stopPrice !== undefined ? { stopPrice: parseAmount(patch.stopPrice) } : {}),
    ...(patch.tif !== undefined ? { tif: patch.tif } : {}),
    ...(patch.expireAt !== undefined ? { expireAt: patch.expireAt } : {}),
    ...(patch.strike !== undefined ? { strike: patch.strike === null ? null : parseAmount(patch.strike) } : {}),
    ...(patch.expiry !== undefined ? { expiry: patch.expiry } : {}),
  };
}
