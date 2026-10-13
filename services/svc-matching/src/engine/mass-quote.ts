/**
 * Mass quote + paired-side (PX-S03 / M11 / PTX-M11-R05).
 * Required two-sided set: one side rejected → cancel/reject the pair.
 * oneSided explicit. Do not rest two independent options and call it a quote set.
 * Qty is ledger Amount. Margin is quoted qty only — no sidecar hold.
 * Hitch: imported from index.ts so MatchingEngine is wrapped without recutting engine.ts.
 */
import type { MarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { MatchingEngine } from './engine.js';
import type { CancelResult, EngineOrder, MarketId, OrderId, SubmitResult } from './types.js';

export const QUOTE_SET_MISSING = 'quote_set_missing' as const;
export const QUOTE_PAIR_INCOMPLETE = 'quote_pair_incomplete' as const;
export const QUOTE_PAIR_REJECTED = 'quote_pair_rejected' as const;

export const QUOTE_SET_MISSING_MESSAGE = 'quote setId is required';
export const QUOTE_PAIR_INCOMPLETE_MESSAGE = 'required two-sided quote set is missing a side; neither rests';
export const QUOTE_PAIR_REJECTED_MESSAGE = 'quote pair refused; applied side was unwound so the book is not one-sided';

const FLAG = Symbol.for('intafaced.matching.mass-quote');

export type QuoteSide = 'bid' | 'ask';
export type QuoteSideStatus = 'APPLIED' | 'REFUSED';

export type MillRejectReason = {
  readonly code: string;
  readonly message: string;
};

export type QuoteSet = {
  readonly setId: string;
  readonly marketId: MarketId;
  readonly accountId: string;
  readonly oneSided?: boolean;
  readonly bid?: EngineOrder | null;
  readonly ask?: EngineOrder | null;
  /** Admission object the order routes already forward into submit. */
  readonly lifecycleProof?: MarketLifecycleAdmissionProof;
};

export type MassQuoteCommand = QuoteSet;

export type QuoteSideResult = {
  readonly side: QuoteSide;
  readonly status: QuoteSideStatus;
  readonly orderId?: OrderId;
  readonly rejected?: MillRejectReason;
};

export type MassQuoteResult = {
  readonly setId: string | null;
  readonly oneSided: boolean;
  readonly results: readonly QuoteSideResult[];
  readonly rejected?: MillRejectReason;
};

type Host = MatchingEngine & {
  submit: (marketId: MarketId, order: EngineOrder, lifecycleProof?: MarketLifecycleAdmissionProof) => Promise<SubmitResult>;
  cancel: (marketId: MarketId, orderId: OrderId) => Promise<CancelResult>;
};

export function setMissingRefuse(): MillRejectReason {
  return { code: QUOTE_SET_MISSING, message: QUOTE_SET_MISSING_MESSAGE };
}

export function pairIncompleteRefuse(): MillRejectReason {
  return { code: QUOTE_PAIR_INCOMPLETE, message: QUOTE_PAIR_INCOMPLETE_MESSAGE };
}

export function pairRejectedRefuse(): MillRejectReason {
  return { code: QUOTE_PAIR_REJECTED, message: QUOTE_PAIR_REJECTED_MESSAGE };
}

function readSetId(cmd: MassQuoteCommand): string | null {
  if (typeof cmd.setId !== 'string') return null;
  const trimmed = cmd.setId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function presentSide(value: EngineOrder | null | undefined): EngineOrder | null {
  return value == null ? null : value;
}

function isLive(engine: MatchingEngine, marketId: MarketId, orderId: OrderId): boolean {
  return engine.restingOrders(marketId).some((row) => row.orderId === orderId);
}

function acceptedTerminal(engine: MatchingEngine, marketId: MarketId, orderId: OrderId): boolean {
  return engine.existingBook(marketId)?.toState().acceptedOrderIds?.includes(orderId) === true;
}

function refusedSide(side: QuoteSide, reason: MillRejectReason, orderId?: OrderId): QuoteSideResult {
  return orderId === undefined ? { side, status: 'REFUSED', rejected: reason } : { side, status: 'REFUSED', orderId, rejected: reason };
}

function appliedSide(side: QuoteSide, orderId: OrderId): QuoteSideResult {
  return { side, status: 'APPLIED', orderId };
}

async function submitSide(
  engine: Host,
  marketId: MarketId,
  side: QuoteSide,
  order: EngineOrder,
  lifecycleProof?: MarketLifecycleAdmissionProof,
  filled?: Set<OrderId>,
): Promise<QuoteSideResult> {
  const orderId = order.orderId;
  try {
    const result = await engine.submit(marketId, order, lifecycleProof);
    if (result.fills.length > 0 || result.triggered.some((row) => row.fills.length > 0)) filled?.add(orderId);
    if (result.accepted) return appliedSide(side, orderId);
    if (result.rejected) return refusedSide(side, result.rejected, orderId);
    return refusedSide(side, pairRejectedRefuse(), orderId);
  } catch (err) {
    if (acceptedTerminal(engine, marketId, orderId)) {
      filled?.add(orderId);
      return appliedSide(side, orderId);
    }
    if (isLive(engine, marketId, orderId)) return appliedSide(side, orderId);
    // A durable input may precede a failed fsync acknowledgement and an empty
    // live book. No observed rest is not proof that the submission did nothing.
    // Keep the original uncertain outcome and IDs for the caller to reconcile.
    throw err;
  }
}

async function unwindSide(
  engine: Host,
  marketId: MarketId,
  current: QuoteSideResult,
  filled: ReadonlySet<OrderId>,
): Promise<QuoteSideResult> {
  if (current.status !== 'APPLIED' || current.orderId === undefined) return current;
  const orderId = current.orderId;
  // Cancel releases a remainder; it cannot reverse a fill already printed.
  if (filled.has(orderId)) {
    try {
      await engine.cancel(marketId, orderId);
    } catch {
      /* Retain the applied outcome. */
    }
    return current;
  }
  const unwound = refusedSide(current.side, pairRejectedRefuse(), orderId);
  try {
    const cancelled = await engine.cancel(marketId, orderId);
    if (isLive(engine, marketId, orderId)) return current;
    if (cancelled.cancelled || !isLive(engine, marketId, orderId)) return unwound;
    return current;
  } catch {
    if (isLive(engine, marketId, orderId)) return current;
    return unwound;
  }
}

async function processQuote(engine: Host, cmd: MassQuoteCommand): Promise<MassQuoteResult> {
  const oneSided = cmd.oneSided === true;
  const setId = readSetId(cmd);
  const bid = presentSide(cmd.bid);
  const ask = presentSide(cmd.ask);
  const marketId = cmd.marketId;

  if (setId === null) {
    const reason = setMissingRefuse();
    return {
      setId: null,
      oneSided,
      results: [refusedSide('bid', reason, bid?.orderId), refusedSide('ask', reason, ask?.orderId)],
      rejected: reason,
    };
  }

  if (!oneSided && (bid === null || ask === null)) {
    const reason = pairIncompleteRefuse();
    return {
      setId,
      oneSided,
      results: [refusedSide('bid', reason, bid?.orderId), refusedSide('ask', reason, ask?.orderId)],
      rejected: reason,
    };
  }

  // One market, the sides that were given. Never invent a second market or the missing side.
  const results: QuoteSideResult[] = [];
  const filled = new Set<OrderId>();
  if (bid !== null) results.push(await submitSide(engine, marketId, 'bid', bid, cmd.lifecycleProof, filled));
  if (ask !== null) results.push(await submitSide(engine, marketId, 'ask', ask, cmd.lifecycleProof, filled));

  if (!oneSided && results.some((row) => row.status !== 'APPLIED')) {
    for (let index = 0; index < results.length; index += 1) {
      results[index] = await unwindSide(engine, marketId, results[index]!, filled);
    }
    const stillResting = results.some(
      (row) => row.status === 'APPLIED' && row.orderId !== undefined && isLive(engine, marketId, row.orderId),
    );
    if (stillResting) return { setId, oneSided, results };
    return { setId, oneSided, results, rejected: pairRejectedRefuse() };
  }

  return { setId, oneSided, results };
}

export function installMassQuote(ctor: typeof MatchingEngine = MatchingEngine): void {
  const proto = ctor.prototype as {
    massQuote?: (cmd: MassQuoteCommand) => Promise<MassQuoteResult>;
    [FLAG]?: boolean;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  proto.massQuote = async function (this: MatchingEngine, cmd: MassQuoteCommand) {
    return processQuote(this as Host, cmd);
  };
}

try {
  installMassQuote();
} catch {
  queueMicrotask(() => installMassQuote());
}
