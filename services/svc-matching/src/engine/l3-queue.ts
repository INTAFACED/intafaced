/**
 * Native L3 / queue (PX-S03 / PTX-M06-R01 / PTX-M06-R06 / PTX-M06-R11).
 * L3/queue is matching truth from existingBook/book.toState() per-order queue.
 * depth() is L2 aggregates — never labeled L3. Never call L2 L3.
 * Queue-probability from L2 alone refuses. Public maker identity / L4 refuses unpublished.
 * Hitch: imported from index.ts so MatchingEngine is wrapped without recutting engine.ts.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { publishedEngineL2Limit } from '../l2-limit.js';
import { MatchingEngine } from './engine.js';
import type { MarketId, PriceLevelState, RejectReason } from './types.js';

export const QUEUE_PROBABILITY_L2 = 'queue_probability_l2' as const;
export const QUEUE_PROBABILITY_UNSET = 'queue_probability_unset' as const;
export const L3_UNAVAILABLE = 'l3_unavailable' as const;
export const L4_UNPUBLISHED = 'l4_unpublished' as const;
export const MAKER_IDENTITY_UNPUBLISHED = 'maker_identity_unpublished' as const;

export const QUEUE_PROBABILITY_L2_MESSAGE =
  'queue probability cannot be derived from L2 aggregates; matching does not invent a fill probability from size';
export const QUEUE_PROBABILITY_UNSET_MESSAGE = 'queue probability is unset; matching does not invent a fill percent from queue position';
export const L3_UNAVAILABLE_MESSAGE = 'L3 is the native matching queue; matching does not synthesize L3 from L2';
export const L4_UNPUBLISHED_MESSAGE = 'L4 is unpublished; matching does not produce L4';
export const MAKER_IDENTITY_UNPUBLISHED_MESSAGE = 'public maker identity is unpublished; matching does not produce maker names';

const FLAG = Symbol.for('intafaced.matching.l3-queue');

export type L3QueueOrder = {
  readonly orderId: string;
  readonly remaining: string;
  readonly sequence: number;
};

export type L3QueueLevel = {
  readonly price: string;
  readonly orders: readonly L3QueueOrder[];
};

export type L3Queue = {
  readonly level: 'L3';
  readonly marketId: MarketId;
  /** The book's own sequence this queue was read at (the same number `/depth` answers); 0 for a book never opened. */
  readonly sequence: number;
  readonly bids: readonly L3QueueLevel[];
  readonly asks: readonly L3QueueLevel[];
};

export type L2Level = readonly [price: string, size: string];

export type L2Depth = {
  readonly level: 'L2';
  readonly marketId: MarketId;
  readonly bids: readonly L2Level[];
  readonly asks: readonly L2Level[];
};

export type QueueProbabilityInput = {
  readonly level?: string;
  readonly marketId?: MarketId;
  readonly bids?: unknown;
  readonly asks?: unknown;
};

export type QueueProbabilityResult = {
  readonly accepted: false;
  readonly rejected: RejectReason;
};

export type PublicMakerIdentityResult = {
  readonly accepted: false;
  readonly marketId: MarketId;
  readonly identity: null;
  readonly rejected: RejectReason;
};

export type L4Result = {
  readonly accepted: false;
  readonly marketId: MarketId;
  readonly rejected: RejectReason;
};

type BookView = {
  toState(): { bids: readonly PriceLevelState[]; asks: readonly PriceLevelState[] };
  depth(n: number): { bids: readonly L2Level[]; asks: readonly L2Level[] };
  readonly currentSequence: number;
};

type Host = MatchingEngine & {
  existingBook(marketId: MarketId): BookView | null;
};

function decimal(value: string): string {
  return formatAmount(parseAmount(value));
}

function mapLevels(levels: readonly PriceLevelState[]): L3QueueLevel[] {
  return levels.map((level) => ({
    price: decimal(level.price),
    orders: level.orders.map((order) => ({
      orderId: order.orderId,
      remaining: decimal(order.remaining),
      sequence: order.sequence,
    })),
  }));
}

export function emptyL3(marketId: MarketId): L3Queue {
  return { level: 'L3', marketId, sequence: 0, bids: [], asks: [] };
}

export function l3QueueFromBook(book: BookView, marketId: MarketId): L3Queue {
  const state = book.toState();
  return {
    level: 'L3',
    marketId,
    sequence: book.currentSequence,
    bids: mapLevels(state.bids),
    asks: mapLevels(state.asks),
  };
}

export function l2DepthFromBook(book: BookView, marketId: MarketId, n: number): L2Depth {
  const depth = book.depth(n);
  return { level: 'L2', marketId, bids: depth.bids, asks: depth.asks };
}

function sideHasOrders(side: unknown): boolean {
  if (!Array.isArray(side)) return false;
  return side.some(
    (row) => row !== null && typeof row === 'object' && !Array.isArray(row) && Array.isArray((row as { orders?: unknown }).orders),
  );
}

function isTupleLevel(row: unknown): boolean {
  return Array.isArray(row) && row.length >= 2 && typeof row[0] === 'string' && typeof row[1] === 'string';
}

function sideLooksL2(side: unknown): boolean {
  if (!Array.isArray(side)) return false;
  return side.some((row) => {
    if (isTupleLevel(row)) return true;
    if (row !== null && typeof row === 'object' && !Array.isArray(row)) {
      const rec = row as { orders?: unknown; size?: unknown };
      return rec.size !== undefined && rec.orders === undefined;
    }
    return false;
  });
}

export function isL2OnlyInput(input: QueueProbabilityInput): boolean {
  if (input.level === 'L3' || sideHasOrders(input.bids) || sideHasOrders(input.asks)) return false;
  if (input.level === 'L2') return true;
  if (sideLooksL2(input.bids) || sideLooksL2(input.asks)) return true;
  return true;
}

export function queueProbabilityL2Refuse(): RejectReason {
  return { code: QUEUE_PROBABILITY_L2, message: QUEUE_PROBABILITY_L2_MESSAGE };
}

export function queueProbabilityUnsetRefuse(): RejectReason {
  return { code: QUEUE_PROBABILITY_UNSET, message: QUEUE_PROBABILITY_UNSET_MESSAGE };
}

export function l3UnavailableRefuse(): RejectReason {
  return { code: L3_UNAVAILABLE, message: L3_UNAVAILABLE_MESSAGE };
}

export function l4UnpublishedRefuse(): RejectReason {
  return { code: L4_UNPUBLISHED, message: L4_UNPUBLISHED_MESSAGE };
}

/** Native L3 only. Missing hitch refuses — never fall back to depth() L2 tuples. */
export function nativeL3FromEngine(
  engine: MatchingEngine,
  marketId: MarketId,
): { ok: true; queue: L3Queue } | { ok: false; rejected: RejectReason } {
  const hitch = engine as MatchingEngine & { l3Queue?: (id: MarketId) => L3Queue };
  if (typeof hitch.l3Queue !== 'function') {
    return { ok: false, rejected: l3UnavailableRefuse() };
  }
  return { ok: true, queue: hitch.l3Queue(marketId) };
}

export function makerIdentityUnpublishedRefuse(): RejectReason {
  return { code: MAKER_IDENTITY_UNPUBLISHED, message: MAKER_IDENTITY_UNPUBLISHED_MESSAGE };
}

export function queueProbability(input: QueueProbabilityInput): QueueProbabilityResult {
  if (isL2OnlyInput(input)) {
    return { accepted: false, rejected: queueProbabilityL2Refuse() };
  }
  return { accepted: false, rejected: queueProbabilityUnsetRefuse() };
}

export function publicMakerIdentity(marketId: MarketId): PublicMakerIdentityResult {
  return {
    accepted: false,
    marketId,
    identity: null,
    rejected: makerIdentityUnpublishedRefuse(),
  };
}

export function l4(marketId: MarketId): L4Result {
  return {
    accepted: false,
    marketId,
    rejected: l4UnpublishedRefuse(),
  };
}

export function installL3Queue(ctor: typeof MatchingEngine = MatchingEngine): void {
  const proto = ctor.prototype as {
    existingBook(marketId: MarketId): BookView | null;
    l3Queue?: (marketId: MarketId) => L3Queue;
    l2Depth?: (marketId: MarketId, n?: number | null) => L2Depth;
    queueProbability?: (input: QueueProbabilityInput) => QueueProbabilityResult;
    publicMakerIdentity?: (marketId: MarketId) => PublicMakerIdentityResult;
    l4?: (marketId: MarketId) => L4Result;
    [FLAG]?: boolean;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  proto.l3Queue = function (this: MatchingEngine, marketId: MarketId) {
    const book = (this as Host).existingBook(marketId);
    if (!book) return emptyL3(marketId);
    return l3QueueFromBook(book, marketId);
  };

  proto.l2Depth = function (this: MatchingEngine, marketId: MarketId, n?: number | null) {
    const limit = publishedEngineL2Limit(n);
    const book = (this as Host).existingBook(marketId);
    if (!book) return { level: 'L2', marketId, bids: [], asks: [] };
    return l2DepthFromBook(book, marketId, limit);
  };

  proto.queueProbability = function (this: MatchingEngine, input: QueueProbabilityInput) {
    return queueProbability(input);
  };

  proto.publicMakerIdentity = function (this: MatchingEngine, marketId: MarketId) {
    return publicMakerIdentity(marketId);
  };

  proto.l4 = function (this: MatchingEngine, marketId: MarketId) {
    return l4(marketId);
  };
}

try {
  installL3Queue();
} catch {
  queueMicrotask(() => installL3Queue());
}
