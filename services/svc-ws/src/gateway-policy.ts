/**
 * ws.gateway product policy — depth/trade/private fan-out honesty (§5.2 / D26-P4-06).
 *
 * Empty book stays empty. No fake depth, no invent mid, no seed fills as live tape.
 * Pure mechanism: consolidates the public-door posture already enforced in the hubs.
 */

import {
  DEPTH_MARKET_DELISTED,
  DEPTH_MARKET_EXPIRED,
  DEPTH_MARKET_HALTED,
  DEPTH_MARKET_PRELAUNCH,
  DEPTH_VENUE_HALTED,
  ORDERS_MARKET_DELISTED,
  ORDERS_MARKET_EXPIRED,
  ORDERS_MARKET_HALTED,
  ORDERS_MARKET_PRELAUNCH,
  ORDERS_VENUE_HALTED,
} from './matching-trading.js';

export {
  DEPTH_MARKET_DELISTED,
  DEPTH_MARKET_EXPIRED,
  DEPTH_MARKET_HALTED,
  DEPTH_MARKET_PRELAUNCH,
  DEPTH_VENUE_HALTED,
  ORDERS_MARKET_DELISTED,
  ORDERS_MARKET_EXPIRED,
  ORDERS_MARKET_HALTED,
  ORDERS_MARKET_PRELAUNCH,
  ORDERS_VENUE_HALTED,
};

/** Mirrors `depth/hub.ts` — named unavailability, not a priced empty ladder. */
export const DEPTH_ENGINE_UNAVAILABLE = 'depth.engine_unavailable' as const;

/**
 * Matching native L3/queue is missing or was an L2-shaped body.
 * JSON L2 depth is not L3 — refuse, never synthesize. Queue-probability from
 * L2 (or L3) alone is the same refuse (PTX-M06-R01).
 */
export const DEPTH_L3_UNAVAILABLE = 'depth.l3_unavailable' as const;

/**
 * No binary/SBE feed exists on this door. JSON depth is not binary — refuse,
 * never pretend a text frame is a schema-id'd SBE payload.
 * Public L2 SBE is a different door (`isPublicSbeL2Ask` + sbe-codec).
 */
export const DEPTH_BINARY_UNAVAILABLE = 'depth.binary_unavailable' as const;

/** Real Logic SBE 1.39.0 is not linked — refuse rather than invent protobuf. */
export const DEPTH_SBE_UNAVAILABLE = 'depth.sbe_unavailable' as const;

/** L4 / public maker identity is not entitled on this L2 SBE tape. */
export const DEPTH_ENTITLEMENT_UNAUTHORIZED = 'depth.entitlement_unauthorized' as const;

/**
 * Depth / native L3 are HTTP polls of matching. A client asking for engine
 * push on those doors must not get a snapshot that reads as live push.
 * Public trades / private / drop-copy are bus push — not this code.
 */
export const DEPTH_PUSH_UNAVAILABLE = 'depth.push_unavailable' as const;

export const DEPTH_TRANSPORT_POLL = 'poll' as const;
export const TRADES_TRANSPORT_PUSH = 'push' as const;

export type MarketDataFeedRefuseCode =
  | typeof DEPTH_L3_UNAVAILABLE
  | typeof DEPTH_BINARY_UNAVAILABLE
  | typeof DEPTH_SBE_UNAVAILABLE
  | typeof DEPTH_ENTITLEMENT_UNAUTHORIZED
  | typeof DEPTH_PUSH_UNAVAILABLE;

/** HTTP status for an explicit L3/binary subscribe the product does not publish. */
export const MARKET_DATA_FEED_REFUSE_HTTP = 409 as const;

const NATIVE_L3_TOKENS = new Set([
  'l3',
  'mbo',
  'market-by-order',
  'market_by_order',
  'order-by-order',
  'order_by_order',
  'orderbyorder',
  'queue',
  'queue-position',
  'queue_position',
  'queueposition',
]);

const QUEUE_PROBABILITY_TOKENS = new Set([
  'fill-probability',
  'fill_probability',
  'fillprobability',
  'queue-probability',
  'queue_probability',
  'queueprobability',
]);

const BINARY_TOKENS = new Set(['sbe', 'binary', 'sbe-like', 'sbe_like']);

const PUSH_TOKENS = new Set(['push', 'engine-push', 'engine_push', 'live-push', 'live_push']);

const UNAUTHORIZED_ENTITLEMENT = new Set([
  'l4',
  'mbo-l4',
  'maker',
  'maker-id',
  'maker_id',
  'maker-identity',
  'maker_identity',
  'public-maker',
  'attribution',
]);

function normToken(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase();
}

function firstParam(params: URLSearchParams, keys: readonly string[]): string {
  for (const key of keys) {
    const value = normToken(params.get(key));
    if (value !== '') return value;
  }
  return '';
}

/** Later aliases and repeated keys are asks too. The first value is not the only one. */
function anyAlias(params: URLSearchParams, keys: readonly string[], match: (value: string) => boolean): boolean {
  for (const key of keys) {
    for (const raw of params.getAll(key)) {
      const value = normToken(raw);
      if (value !== '' && match(value)) return true;
    }
  }
  return false;
}

function flagOn(params: URLSearchParams, key: string): boolean {
  return params.getAll(key).includes('1');
}

function isL3Ask(params: URLSearchParams): boolean {
  return isNativeL3Ask(params) || isQueueProbabilityAsk(params);
}

/** Public matching queue (per-order remaining). Not fill-probability. */
export function isNativeL3Ask(params: URLSearchParams): boolean {
  const levelKeys = ['level', 'book', 'dataLevel', 'data_level'] as const;
  return (
    anyAlias(params, ['channel'], (value) => NATIVE_L3_TOKENS.has(value)) ||
    anyAlias(params, levelKeys, (value) => NATIVE_L3_TOKENS.has(value) || value === '3') ||
    flagOn(params, 'l3') ||
    flagOn(params, 'mbo')
  );
}

/** Derived fill % — matching refuses; never invent from L2 or L3. */
export function isQueueProbabilityAsk(params: URLSearchParams): boolean {
  const levelKeys = ['level', 'book', 'dataLevel', 'data_level'] as const;
  return (
    anyAlias(params, ['channel'], (value) => QUEUE_PROBABILITY_TOKENS.has(value)) ||
    anyAlias(params, levelKeys, (value) => QUEUE_PROBABILITY_TOKENS.has(value))
  );
}

function isBinaryAsk(params: URLSearchParams): boolean {
  const formatKeys = ['format', 'encoding', 'protocol', 'codec', 'schema'] as const;
  return (
    anyAlias(params, ['channel'], (value) => BINARY_TOKENS.has(value)) ||
    anyAlias(params, formatKeys, (value) => BINARY_TOKENS.has(value)) ||
    flagOn(params, 'sbe') ||
    flagOn(params, 'binary')
  );
}

/** Public `orderFilled` tape — the one door that is actually bus push. */
export function isTradesChannelAsk(params: URLSearchParams): boolean {
  return firstParam(params, ['channel']) === 'trades';
}

/**
 * Client asked for engine push. Depth and native L3 are polls of matching HTTP.
 * Trades stay out — that door is NATS push.
 */
export function isDepthPushAsk(params: URLSearchParams): boolean {
  if (isTradesChannelAsk(params)) return false;
  const transportKeys = ['transport', 'mode', 'feed', 'source'] as const;
  return (
    anyAlias(params, ['channel'], (value) => PUSH_TOKENS.has(value)) ||
    anyAlias(params, transportKeys, (value) => PUSH_TOKENS.has(value)) ||
    flagOn(params, 'push')
  );
}

/**
 * Public L2 SBE tape ask — depth (default) with our schema. Trades stay off this
 * door. L3/queue never counts as L2 SBE.
 */
export function isPublicSbeL2Ask(params: URLSearchParams): boolean {
  if (isL3Ask(params)) return false;
  const channel = firstParam(params, ['channel']);
  if (channel === 'trades') return false;
  return isBinaryAsk(params);
}

/** L4 / public maker identity on the L2 SBE tape — not entitled (C5 is native L3). */
export function sbeL2EntitlementRefuse(params: URLSearchParams): typeof DEPTH_ENTITLEMENT_UNAUTHORIZED | null {
  const levelKeys = ['level', 'book', 'dataLevel', 'data_level'] as const;
  const productKeys = ['product', 'as', 'name'] as const;
  if (
    anyAlias(params, ['channel'], (value) => UNAUTHORIZED_ENTITLEMENT.has(value)) ||
    anyAlias(params, levelKeys, (value) => UNAUTHORIZED_ENTITLEMENT.has(value) || value === '4') ||
    anyAlias(params, productKeys, (value) => UNAUTHORIZED_ENTITLEMENT.has(value)) ||
    flagOn(params, 'l4') ||
    flagOn(params, 'maker')
  ) {
    return DEPTH_ENTITLEMENT_UNAUTHORIZED;
  }
  return null;
}

/**
 * Named refuse for unpublished L3/queue-probability or binary/SBE asks.
 * Pass `{ allowPublicSbeL2: true }` on the public depth door so C4 can publish.
 * Pass `{ allowNativeL3: true }` to project matching `GET /depth/l3` as JSON.
 * Queue-probability stays refused. L3+SBE is binary_unavailable (no L3 SBE).
 * Private / trades keep the default (L3 and binary unavailable).
 * Depth/L3 push asks are `depth.push_unavailable` — poll is not push.
 */
export function marketDataFeedRefuse(
  params: URLSearchParams,
  opts: { readonly allowPublicSbeL2?: boolean; readonly allowNativeL3?: boolean } = {},
): MarketDataFeedRefuseCode | null {
  if (isQueueProbabilityAsk(params)) return DEPTH_L3_UNAVAILABLE;
  if (isDepthPushAsk(params)) return DEPTH_PUSH_UNAVAILABLE;
  if (isNativeL3Ask(params)) {
    if (!opts.allowNativeL3) return DEPTH_L3_UNAVAILABLE;
    if (isBinaryAsk(params)) return DEPTH_BINARY_UNAVAILABLE;
    return null;
  }
  if (opts.allowPublicSbeL2 && isPublicSbeL2Ask(params)) return null;
  if (isBinaryAsk(params)) return DEPTH_BINARY_UNAVAILABLE;
  return null;
}

export function marketDataFeedRefuseMessage(code: MarketDataFeedRefuseCode): string {
  if (code === DEPTH_L3_UNAVAILABLE) {
    return 'matching native L3 is unavailable; L2 depth is not L3';
  }
  if (code === DEPTH_PUSH_UNAVAILABLE) {
    return 'depth and native L3 are polled from matching HTTP; poll is not push';
  }
  if (code === DEPTH_SBE_UNAVAILABLE) {
    return 'Real Logic SBE 1.39.0 is not linked; JSON L2 is not SBE';
  }
  if (code === DEPTH_ENTITLEMENT_UNAUTHORIZED) {
    return 'this L2 SBE tape is not entitled for L4 / public maker identity';
  }
  return 'binary/SBE feed does not exist; JSON depth is not binary';
}

export function marketDataFeedRefusePayload(code: MarketDataFeedRefuseCode): {
  readonly type: 'status';
  readonly code: MarketDataFeedRefuseCode;
  readonly message: string;
} {
  return { type: 'status', code, message: marketDataFeedRefuseMessage(code) };
}

/** Upgrade-time refuse: JSON body with the named code, never an L2/JSON socket. */
export function writeMarketDataFeedRefuse(
  socket: {
    write(chunk: string, callback?: (error?: Error | null) => void): unknown;
    destroy(): void;
  },
  code: MarketDataFeedRefuseCode,
): void {
  const body = JSON.stringify(marketDataFeedRefusePayload(code));
  // A writable drops bytes still buffered when destroy runs in this turn.
  socket.write(
    `HTTP/1.1 ${MARKET_DATA_FEED_REFUSE_HTTP} Conflict\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    () => {
      socket.destroy();
    },
  );
}

/**
 * Mirrors `private/hub.ts` — matching-down on the private orders stream.
 * Honest private name in the `*.engine_unavailable` family; not a blank blotter.
 */
export const ORDERS_ENGINE_UNAVAILABLE = 'orders.engine_unavailable' as const;

/** HTTP + WS refuse/close codes on the public depth door. */
export const GATEWAY_DEPTH_REFUSE_CODES = [
  'NoBook',
  'MarketNotFound',
  DEPTH_ENGINE_UNAVAILABLE,
  DEPTH_L3_UNAVAILABLE,
  DEPTH_BINARY_UNAVAILABLE,
  DEPTH_SBE_UNAVAILABLE,
  DEPTH_ENTITLEMENT_UNAUTHORIZED,
  DEPTH_PUSH_UNAVAILABLE,
  DEPTH_MARKET_HALTED,
  DEPTH_VENUE_HALTED,
  DEPTH_MARKET_PRELAUNCH,
  DEPTH_MARKET_EXPIRED,
  DEPTH_MARKET_DELISTED,
] as const;

/** Named unavailability on the authenticated private orders/fills stream. */
export const GATEWAY_PRIVATE_REFUSE_CODES = [
  ORDERS_ENGINE_UNAVAILABLE,
  ORDERS_MARKET_HALTED,
  ORDERS_VENUE_HALTED,
  ORDERS_MARKET_PRELAUNCH,
  ORDERS_MARKET_EXPIRED,
  ORDERS_MARKET_DELISTED,
] as const;

/** Connect watermark: this replica is not a durable historical drop-copy tape. */
export const DROP_COPY_RECOVERY_REQUIRED = 'drop_copy.recovery_required' as const;
/** Drop-copy JetStream consumer is down — not an empty complete tape. */
export const DROP_COPY_COMMON_UPSTREAM_FAILURE = 'drop_copy.common_upstream_failure' as const;
/** A live seat missed an execution (slow consumer). Not invented. */
export const DROP_COPY_GAP = 'drop_copy.gap' as const;

export const GATEWAY_DROP_COPY_REFUSE_CODES = [DROP_COPY_RECOVERY_REQUIRED, DROP_COPY_COMMON_UPSTREAM_FAILURE, DROP_COPY_GAP] as const;

/** PX-S03 §11 — owner lease range blank; client clock is not a substitute. */
export const COD_LEASE_RANGE_UNCONFIGURED = 'cod.lease_range_unconfigured' as const;
export const COD_TRADE_NOT_REACHED = 'cod.trade_not_reached' as const;
export const COD_SESSION_SCOPE_NOT_MAPPED = 'cod.session_scope_not_mapped' as const;

export const GATEWAY_COD_REFUSE_CODES = [
  'cod.malformed',
  COD_LEASE_RANGE_UNCONFIGURED,
  'cod.write_required',
  'cod.excluded_classes_unconfigured',
  'cod.scope_unsupported',
  'cod.ttl_out_of_range',
  'cod.unarmed',
] as const;

export interface DepthSnapshotSides {
  readonly bids: readonly (readonly [string, string])[];
  readonly asks: readonly (readonly [string, string])[];
}

export type GatewayPolicySummary = ReturnType<typeof describeGatewayPolicy>;

/** Resting depth on either side. Empty sides are absence, not a live zero book. */
export function snapshotHasRestingDepth(snapshot: DepthSnapshotSides): boolean {
  return snapshot.bids.length > 0 || snapshot.asks.length > 0;
}

/** Public honesty board for ws.gateway HTTP + websocket fan-out. */
export function describeGatewayPolicy() {
  return {
    emptyBookStaysEmpty: true as const,
    emptyNotZeroOnWire: true as const,
    noFakeDepth: true as const,
    noSynthesizeL3FromL2: true as const,
    noPretendJsonIsBinary: true as const,
    l3FeedPublished: true as const,
    binaryFeedPublished: true as const,
    l2SbeFeedPublished: true as const,
    depthTransport: DEPTH_TRANSPORT_POLL,
    l3Transport: DEPTH_TRANSPORT_POLL,
    tradesTransport: TRADES_TRANSPORT_PUSH,
    privateTransport: TRADES_TRANSPORT_PUSH,
    dropCopyTransport: TRADES_TRANSPORT_PUSH,
    depthPush: false as const,
    l3Push: false as const,
    noInventMid: true as const,
    noSeedFillsAsLiveTape: true as const,
    engineDownNamesUnavailable: true as const,
    matchingNotTradableNamed: true as const,
    unknownMarketTypedClose: true as const,
    holeNotSyntheticEmptyBook: true as const,
    depthWorksWithoutNats: true as const,
    privateRequiresAuth: true as const,
    dropCopyIndependentOfTradingSession: true as const,
    dropCopyReadOnly: true as const,
    dropCopyReplayDurable: false as const,
    cancelOnDisconnectLease: true as const,
    codClientClockIgnored: true as const,
    codInventedMassSuccess: false as const,
    refuseCodes: [...GATEWAY_DEPTH_REFUSE_CODES],
    privateRefuseCodes: [...GATEWAY_PRIVATE_REFUSE_CODES],
    dropCopyRefuseCodes: [...GATEWAY_DROP_COPY_REFUSE_CODES],
    codRefuseCodes: [...GATEWAY_COD_REFUSE_CODES],
    inventsQuietMarket: false as const,
    inventsFuturesPositions: false as const,
  };
}

/**
 * First depth frame on connect. Absence beats bids/asks `[]` — a listed never-traded
 * market stays open with no frames until resting depth exists.
 */
export function allowsConnectDepthSnapshot(hasRestingDepth: boolean, hasPriorBook: boolean): boolean {
  return hasRestingDepth || hasPriorBook;
}

/**
 * seq-0 (or any snapshot) with empty sides reads as a priced zero book when there
 * was no prior hub book. That is invention, not honest empty.
 */
export function wouldInventInitialEmptyLadder(snapshot: DepthSnapshotSides, hasPriorBook: boolean): boolean {
  return !hasPriorBook && !snapshotHasRestingDepth(snapshot);
}

/**
 * Matching-down / seed-fail must disclose `depth.engine_unavailable`, not a silent
 * seq-0 empty ladder that looks like a quiet market.
 */
export function wouldInventQuietMarketFromEngineDown(wouldSendEmptySnapshot: boolean, engineAvailable: boolean): boolean {
  return !engineAvailable && wouldSendEmptySnapshot;
}

/** A resting ladder on the wire while matching refuses submits looks tradable. */
export function wouldInventTradableWhileMatchingClosed(hasRestingDepth: boolean, matchingNotTradable: boolean): boolean {
  return hasRestingDepth && matchingNotTradable;
}
