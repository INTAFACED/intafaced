import type { MarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { persistIfmQty, persistInFlight, type IfmMutation } from './ifm.js';
import type { WireAmendPatch, WireOrder } from './journal-wire.js';
import {
  persistAon,
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
import type { AccountId, CancelReason, MarketId, OrderId, OrderSide } from './types.js';
import type { WireSpreadInstrument } from './spread-instrument.js';

/**
 * THE ENGINE JOURNAL (§5.1).
 *
 * "Every input persisted to an append-only engine_journal before processing →
 *  full replay = current book state (recovery guarantee)."
 *
 * Two properties do all the work:
 *
 *   1. INPUTS ONLY. The journal records what was asked, never what happened.
 *      If it recorded outcomes, a replay would be a transcript rather than a
 *      proof — and a bug in the matcher would replay perfectly while the book
 *      stayed wrong. Replaying inputs through the same matcher is what makes
 *      the state verifiable.
 *
 *   2. BEFORE PROCESSING. The record is durable before the book moves. A crash
 *      between the two costs a **replay of that input into an empty book**.
 *      Recovery rebuilds once from the journal and republishes recovered fills
 *      with the original `idempotencyKey` (sequence watermark) — it does not
 *      invent fills. Safety is **not** "duplicate_order_id on live re-submit" —
 *      that guard only covers **still-live** resting/stop ids (README).
 *      Never-rests markets and fully filled ids are reusable by design; a
 *      second live submit of the same id after the order is gone is a new
 *      trade-side concern, not journal crash safety. A crash the other way
 *      (book moved before journal) would cost a fill nobody can reconstruct.
 *
 * Amounts are decimal strings on disk. A journal is read years after it is
 * written, by processes that may not share this build — a scaled bigint is our
 * private representation, not an archival format.
 */

export type JournalCommand =
  | {
      readonly kind: 'submit';
      readonly marketId: MarketId;
      /** Wall clock at admission. Journalled because event payloads carry it — the book never reads it. */
      readonly at: string;
      readonly order: WireOrder;
    }
  | {
      readonly kind: 'cancel';
      readonly marketId: MarketId;
      readonly at: string;
      readonly orderId: OrderId;
      /** Absent on older journals and on a caller cancel (`requested`). Replay removes the order either way. */
      readonly reason?: CancelReason;
    }
  | {
      readonly kind: 'in_flight';
      readonly marketId: MarketId;
      readonly at: string;
      readonly orderId: OrderId;
      readonly mutation: IfmMutation;
      readonly inFlight: true;
      /** Remaining qty evidence. Decimal string. Never used to rest a second live order. */
      readonly qty: string | null;
    }
  | {
      readonly kind: 'open_surveillance';
      readonly marketId: MarketId;
      readonly at: string;
      readonly accountId: AccountId;
      /** Named evidence only. Replay does not adjudicate or cancel from this record. */
      readonly reason: 'self_trade' | 'spoofing' | 'layering';
    }
  | {
      readonly kind: 'mass_cancel';
      readonly marketId: MarketId;
      readonly at: string;
      readonly accountId: AccountId;
      /** Absent on older journals — replay cancels both sides. */
      readonly side?: OrderSide;
    }
  | {
      readonly kind: 'amend';
      readonly marketId: MarketId;
      readonly at: string;
      readonly orderId: OrderId;
      readonly expectedVersion: number;
      readonly patch: WireAmendPatch;
      readonly lifecycleProof?: MarketLifecycleAdmissionProof;
    }
  | {
      /** A server-side mark that moved a trailing stop's peak or trigger. Replay re-applies it in order. */
      readonly kind: 'mark';
      readonly marketId: MarketId;
      readonly at: string;
      readonly mark: string;
    }
  | {
      readonly kind: 'halt';
      readonly marketId: MarketId;
      readonly at: string;
      readonly operatorId: string;
      readonly confirmOperatorId?: string;
    }
  | {
      readonly kind: 'resume';
      readonly marketId: MarketId;
      readonly at: string;
      readonly operatorId: string;
      readonly confirmOperatorId?: string;
    }
  | {
      readonly kind: 'reduce_only';
      readonly marketId: MarketId;
      readonly at: string;
      readonly operatorId: string;
      readonly confirmOperatorId?: string;
    }
  | {
      readonly kind: 'resume_reduce_only';
      readonly marketId: MarketId;
      readonly at: string;
      readonly operatorId: string;
      readonly confirmOperatorId?: string;
    }
  | {
      readonly kind: 'post_only';
      readonly marketId: MarketId;
      readonly at: string;
      readonly operatorId: string;
      readonly confirmOperatorId?: string;
    }
  | {
      readonly kind: 'resume_post_only';
      readonly marketId: MarketId;
      readonly at: string;
      readonly operatorId: string;
      readonly confirmOperatorId?: string;
    }
  | {
      readonly kind: 'prelaunch';
      readonly marketId: MarketId;
      readonly at: string;
      readonly operatorId: string;
      readonly confirmOperatorId?: string;
    }
  | {
      readonly kind: 'open';
      readonly marketId: MarketId;
      readonly at: string;
      readonly operatorId: string;
      readonly confirmOperatorId?: string;
    }
  | {
      readonly kind: 'expire';
      readonly marketId: MarketId;
      readonly at: string;
      readonly operatorId: string;
      readonly confirmOperatorId?: string;
    }
  | {
      readonly kind: 'delist';
      readonly marketId: MarketId;
      readonly at: string;
      readonly operatorId: string;
      readonly confirmOperatorId?: string;
    }
  | {
      readonly kind: 'maintenance';
      readonly marketId: MarketId;
      readonly at: string;
      readonly operatorId: string;
      readonly confirmOperatorId?: string;
    }
  | {
      readonly kind: 'end_maintenance';
      readonly marketId: MarketId;
      readonly at: string;
      readonly operatorId: string;
      readonly confirmOperatorId?: string;
    }
  | {
      readonly kind: 'halt_all';
      readonly at: string;
      readonly operatorId: string;
      readonly confirmOperatorId?: string;
    }
  | {
      readonly kind: 'resume_all';
      readonly at: string;
      readonly operatorId: string;
      readonly confirmOperatorId?: string;
    }
  | {
      readonly kind: 'session_dead';
      readonly at: string;
      readonly sessionId: string;
    }
  | {
      /** Owner spread listing (CB-otc-16), consumed through dual-control approval. `marketId` is the spread id. */
      readonly kind: 'spread_list';
      readonly marketId: MarketId;
      readonly at: string;
      readonly operatorId: string;
      readonly confirmOperatorId?: string;
      readonly instrument: WireSpreadInstrument;
    }
  | {
      readonly kind: 'split_brain';
      readonly at: string;
      readonly operatorId: string;
      readonly confirmOperatorId: string;
    }
  | {
      readonly kind: 'clear_split_brain';
      readonly at: string;
      readonly operatorId: string;
      readonly confirmOperatorId: string;
    };

export type JournalRecord = JournalCommand & { readonly seq: number };

export interface EngineJournal {
  /** Append and make durable. Returns the record with its assigned position. */
  append(command: JournalCommand): JournalRecord;
  read(): readonly JournalRecord[];
  readonly length: number;
  close(): void;
}

/** Fixed key order for a spread listing on disk. */
function wireSpreadOrdered(instrument: WireSpreadInstrument): WireSpreadInstrument {
  return {
    spreadId: instrument.spreadId,
    kind: instrument.kind,
    legs: instrument.legs.map((leg) => ({ symbol: leg.symbol, side: leg.side, ratio: leg.ratio })),
    tick: instrument.tick,
    lot: instrument.lot,
  };
}

/** Fixed key order — two equal records must serialise to identical bytes. */
export function encode(record: JournalRecord): string {
  if (record.kind === 'submit') {
    const o = record.order;
    return JSON.stringify({
      seq: record.seq,
      kind: record.kind,
      marketId: record.marketId,
      at: record.at,
      order: {
        orderId: o.orderId,
        accountId: o.accountId,
        type: o.type,
        side: o.side,
        qty: o.qty,
        price: o.price,
        stopPrice: o.stopPrice,
        tif: o.tif,
        ...(o.ocoSiblingId ? { ocoSiblingId: o.ocoSiblingId } : {}),
        ...(o.bracket !== undefined ? { bracket: o.bracket } : {}),
        ...(o.oco === true ? { oco: true } : {}),
        ...(o.takeProfit !== undefined ? { takeProfit: o.takeProfit } : {}),
        ...(o.stopLoss !== undefined ? { stopLoss: o.stopLoss } : {}),
        ...(o.stopLossLimit !== undefined ? { stopLossLimit: o.stopLossLimit } : {}),
        ...(o.takeProfitOrderId !== undefined ? { takeProfitOrderId: o.takeProfitOrderId } : {}),
        ...(o.stopLossOrderId !== undefined ? { stopLossOrderId: o.stopLossOrderId } : {}),
        ...(o.expireAt ? { expireAt: o.expireAt } : {}),
        ...(o.sessionId ? { sessionId: o.sessionId } : {}),
        ...(o.clientOrderId ? { clientOrderId: o.clientOrderId } : {}),
        ...(o.environment ? { environment: o.environment } : {}),
        ...(o.reduceOnly ? { reduceOnly: true } : {}),
        ...(o.triggerRole ? { triggerRole: o.triggerRole } : {}),
        ...(o.triggerBy ? { triggerBy: o.triggerBy } : {}),
        ...(o.instrument ? { instrument: o.instrument } : {}),
        ...(o.positionQty !== undefined ? { positionQty: o.positionQty } : {}),
        ...(persistIceberg(o) ? { iceberg: true, displayQty: o.displayQty == null ? null : o.displayQty } : {}),
        ...(persistTrail(o) ? { trail: o.trail == null ? null : o.trail, ...(o.mark !== undefined ? { mark: o.mark } : {}) } : {}),
        ...(persistStrike(o) ? { strike: o.strike == null ? null : o.strike } : {}),
        ...(persistExpiry(o) ? { expiry: o.expiry == null ? null : o.expiry } : {}),
        ...(persistExercise(o) ? { exercise: true } : {}),
        ...(persistMinQty(o) ? { minQty: o.minQty == null ? null : o.minQty } : {}),
        ...(persistAon(o) ? { aon: o.aon === true } : {}),
        ...(persistPeg(o) ? { peg: o.peg === true } : {}),
        ...(persistMidpoint(o) ? { midpoint: o.midpoint === true } : {}),
        ...(persistRelative(o) ? { relative: o.relative === true } : {}),
        ...(persistReference(o) ? { reference: o.reference == null ? null : o.reference } : {}),
        ...(persistOffset(o) ? { offset: o.offset == null ? null : o.offset } : {}),
        ...(persistCollar(o) ? { collar: o.collar === true } : {}),
        ...(persistMin(o) ? { min: o.min == null ? null : o.min } : {}),
        ...(persistMax(o) ? { max: o.max == null ? null : o.max } : {}),
        ...(persistMinNotional(o) ? { minNotional: o.minNotional == null ? null : o.minNotional } : {}),
        ...(persistCombo(o) ? { combo: o.combo === true } : {}),
        ...(persistLegs(o) ? { legs: o.legs ?? null } : {}),
        ...(o.spread !== undefined
          ? { spread: { instrument: wireSpreadOrdered(o.spread.instrument), anchorReference: o.spread.anchorReference } }
          : {}),
        lifecycleProof: o.lifecycleProof,
      },
    });
  }

  if (record.kind === 'amend') {
    const p = record.patch;
    const patch: WireAmendPatch = {
      ...(p.qty !== undefined ? { qty: p.qty } : {}),
      ...(p.price !== undefined ? { price: p.price } : {}),
      ...(p.stopPrice !== undefined ? { stopPrice: p.stopPrice } : {}),
      ...(p.tif !== undefined ? { tif: p.tif } : {}),
      ...(p.expireAt !== undefined ? { expireAt: p.expireAt } : {}),
      ...(p.strike !== undefined ? { strike: p.strike } : {}),
      ...(p.expiry !== undefined ? { expiry: p.expiry } : {}),
    };
    return JSON.stringify({
      seq: record.seq,
      kind: record.kind,
      marketId: record.marketId,
      at: record.at,
      orderId: record.orderId,
      expectedVersion: record.expectedVersion,
      patch,
      lifecycleProof: record.lifecycleProof,
    });
  }

  if (record.kind === 'mass_cancel') {
    return JSON.stringify({
      seq: record.seq,
      kind: record.kind,
      marketId: record.marketId,
      at: record.at,
      accountId: record.accountId,
      ...(record.side ? { side: record.side } : {}),
    });
  }

  if (record.kind === 'halt_all' || record.kind === 'resume_all') {
    return JSON.stringify({
      seq: record.seq,
      kind: record.kind,
      at: record.at,
      operatorId: record.operatorId,
      ...(record.confirmOperatorId ? { confirmOperatorId: record.confirmOperatorId } : {}),
    });
  }

  if (record.kind === 'split_brain' || record.kind === 'clear_split_brain') {
    return JSON.stringify({
      seq: record.seq,
      kind: record.kind,
      at: record.at,
      operatorId: record.operatorId,
      confirmOperatorId: record.confirmOperatorId,
    });
  }

  if (record.kind === 'spread_list') {
    return JSON.stringify({
      seq: record.seq,
      kind: record.kind,
      marketId: record.marketId,
      at: record.at,
      operatorId: record.operatorId,
      ...(record.confirmOperatorId ? { confirmOperatorId: record.confirmOperatorId } : {}),
      instrument: wireSpreadOrdered(record.instrument),
    });
  }

  if (record.kind === 'session_dead') {
    return JSON.stringify({
      seq: record.seq,
      kind: record.kind,
      at: record.at,
      sessionId: record.sessionId,
    });
  }

  if (record.kind === 'in_flight') {
    return JSON.stringify({
      seq: record.seq,
      kind: record.kind,
      marketId: record.marketId,
      at: record.at,
      orderId: record.orderId,
      mutation: record.mutation,
      ...(persistInFlight(record) ? { inFlight: true } : {}),
      ...(persistIfmQty(record) ? { qty: record.qty == null ? null : record.qty } : {}),
    });
  }

  if (record.kind === 'open_surveillance') {
    return JSON.stringify({
      seq: record.seq,
      kind: record.kind,
      marketId: record.marketId,
      at: record.at,
      accountId: record.accountId,
      reason: record.reason,
    });
  }

  if (record.kind === 'mark') {
    return JSON.stringify({
      seq: record.seq,
      kind: record.kind,
      marketId: record.marketId,
      at: record.at,
      mark: record.mark,
    });
  }

  if (record.kind === 'halt' || record.kind === 'resume') {
    return JSON.stringify({
      seq: record.seq,
      kind: record.kind,
      marketId: record.marketId,
      at: record.at,
      operatorId: record.operatorId,
      ...(record.confirmOperatorId ? { confirmOperatorId: record.confirmOperatorId } : {}),
    });
  }

  if (
    record.kind === 'reduce_only' ||
    record.kind === 'resume_reduce_only' ||
    record.kind === 'post_only' ||
    record.kind === 'resume_post_only' ||
    record.kind === 'prelaunch' ||
    record.kind === 'open' ||
    record.kind === 'expire' ||
    record.kind === 'delist' ||
    record.kind === 'maintenance' ||
    record.kind === 'end_maintenance'
  ) {
    return JSON.stringify({
      seq: record.seq,
      kind: record.kind,
      marketId: record.marketId,
      at: record.at,
      operatorId: record.operatorId,
      ...(record.confirmOperatorId ? { confirmOperatorId: record.confirmOperatorId } : {}),
    });
  }

  if (record.kind === 'cancel') {
    return JSON.stringify({
      seq: record.seq,
      kind: record.kind,
      marketId: record.marketId,
      at: record.at,
      orderId: record.orderId,
      ...(record.reason && record.reason !== 'requested' ? { reason: record.reason } : {}),
    });
  }

  const uncovered: never = record;
  throw new Error(`journal encode missed ${(uncovered as { kind: string }).kind}`);
}
