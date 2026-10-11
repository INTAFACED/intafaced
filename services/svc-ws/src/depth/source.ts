import type { DepthSnapshot, WireLevel } from '@intafaced/market-data';
import {
  DEPTH_VENUE_HALTED,
  parseMatchingBoard,
  parseMatchingTrading,
  matchingTradingOpenEvidence,
  type MatchingTradingOpenEvidence,
  tradingFromBoard,
  type DepthMatchingTradingCode,
  type MatchingTradingBoard,
} from '../matching-trading.js';

/**
 * WHERE DEPTH COMES FROM.
 *
 * One port, one implementation, so the hub can be driven by a fake in tests
 * without a socket or a clock anywhere near it.
 */
export type NativeL3Order = {
  readonly orderId: string;
  readonly remaining: string;
  readonly sequence: number;
};

export type NativeL3Level = {
  readonly price: string;
  readonly orders: readonly NativeL3Order[];
};

/** Matching native queue — per-order remaining, never L2 [price, size] tuples. */
export type NativeL3Queue = {
  readonly level: 'L3';
  readonly marketId: string;
  readonly bids: readonly NativeL3Level[];
  readonly asks: readonly NativeL3Level[];
};

export interface DepthSource {
  /**
   * Market ids the engine actually has a book for.
   *
   * This is a `MarketRegistry` (see `registry.ts`) and it is one of the two the
   * hub unions, but it is NOT the authority on what is listed. It is
   * `engine.markets` — the books the engine currently holds — so it omits every
   * listed market that has not traded yet, and after a `trade.markets` reseed it
   * can hold ids that nothing else recognises. The listing service answers "what
   * may a client watch"; this answers "what has the engine ever seen", which is
   * a strictly-real subset worth keeping in the union.
   */
  markets(): Promise<readonly string[]>;

  /**
   * Top-N aggregated depth, current as of an engine sequence.
   *
   * A listed market the engine has no book for throws `DepthNoBookError` —
   * absence, not a fabricated empty snapshot. See `HttpDepthSource.snapshot`.
   */
  snapshot(marketId: string, limit: number): Promise<DepthSnapshot>;

  /**
   * Native matching L3/queue (`GET /markets/:id/depth/l3?limit=`). Missing hitch
   * or an L2-shaped body throws `DepthL3UnavailableError` — never copy `snapshot()`.
   * Caller passes the published WS window — never invent 20/50.
   */
  l3Queue?(marketId: string, limit: number): Promise<NativeL3Queue>;

  /**
   * Last matching trading status observed for this id. `null` = tradable or
   * matching has not published flags (do not invent halt from silence).
   */
  trading?(marketId: string): DepthMatchingTradingCode | null;

  /** Explicit non-halted/OPEN evidence; null trading by itself remains unknown. */
  tradingOpenEvidence?(marketId: string): MatchingTradingOpenEvidence;

  /** Venue-wide matching halt-all, from `GET /markets` when matching publishes it. */
  venueHalted?(): boolean;
}

export class DepthSourceError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'DepthSourceError';
  }
}

/**
 * Matching has no book for this id (HTTP 404). That is absence, not a live
 * zero book — callers must not coerce it into `{ bids: [], asks: [], sequence: 0 }`.
 */
export class DepthNoBookError extends DepthSourceError {
  constructor(readonly marketId: string) {
    super(`${marketId}: matching holds no book`, 404);
    this.name = 'DepthNoBookError';
  }
}

/**
 * Matching did not publish a native queue. Callers must name `depth.l3_unavailable`
 * and must not substitute L2 aggregates.
 */
export class DepthL3UnavailableError extends DepthSourceError {
  constructor(readonly marketId: string) {
    super(`${marketId}: matching native L3 unavailable`, 409);
    this.name = 'DepthL3UnavailableError';
  }
}

/**
 * Is this a decimal string?
 *
 * The wire between two of our own services is still a wire. A JSON number where
 * a price should be would parse into a float somewhere downstream, and the
 * whole point of decimal strings is that it never gets the chance. Rejecting
 * the response is better than silently coercing it — a coercion would be
 * invisible until the eighteenth decimal place mattered.
 */
const DECIMAL = /^\d+(\.\d{1,18})?$/;

function parseLevels(raw: unknown, side: string, marketId: string): WireLevel[] {
  if (!Array.isArray(raw)) throw new DepthSourceError(`${marketId}: ${side} is not an array`, null);

  return raw.map((level) => {
    if (!Array.isArray(level) || level.length !== 2) {
      throw new DepthSourceError(`${marketId}: ${side} level is not a [price, quantity] pair`, null);
    }
    const [price, quantity] = level as [unknown, unknown];
    if (typeof price !== 'string' || typeof quantity !== 'string' || !DECIMAL.test(price) || !DECIMAL.test(quantity)) {
      throw new DepthSourceError(`${marketId}: ${side} level is not a pair of decimal strings`, null);
    }
    return [price, quantity] as WireLevel;
  });
}

function isL2TupleRow(row: unknown): boolean {
  return Array.isArray(row) && row.length >= 2;
}

function sideLooksLikeL2(side: unknown): boolean {
  if (!Array.isArray(side)) return false;
  return side.some((row) => {
    if (isL2TupleRow(row)) return true;
    if (row !== null && typeof row === 'object' && !Array.isArray(row)) {
      const rec = row as { orders?: unknown; size?: unknown };
      return rec.size !== undefined && rec.orders === undefined;
    }
    return false;
  });
}

function l3RefuseCode(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const rec = body as { accepted?: unknown; rejected?: { code?: unknown } };
  if (rec.accepted !== false) return null;
  const code = rec.rejected?.code;
  return typeof code === 'string' ? code : 'l3_unavailable';
}

function parseL3Orders(raw: unknown, marketId: string, side: string): NativeL3Order[] {
  if (!Array.isArray(raw)) {
    throw new DepthSourceError(`${marketId}: L3 ${side} orders is not an array`, null);
  }
  return raw.map((row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new DepthL3UnavailableError(marketId);
    }
    const rec = row as { orderId?: unknown; remaining?: unknown; sequence?: unknown; accountId?: unknown };
    if (typeof rec.accountId === 'string') {
      throw new DepthSourceError(`${marketId}: L3 order carries accountId`, null);
    }
    if (typeof rec.orderId !== 'string' || rec.orderId.length === 0) {
      throw new DepthSourceError(`${marketId}: L3 orderId is not a string`, null);
    }
    if (typeof rec.remaining !== 'string' || !DECIMAL.test(rec.remaining)) {
      throw new DepthSourceError(`${marketId}: L3 remaining is not a decimal string`, null);
    }
    if (typeof rec.sequence !== 'number' || !Number.isInteger(rec.sequence)) {
      throw new DepthSourceError(`${marketId}: L3 order sequence is not an integer`, null);
    }
    return { orderId: rec.orderId, remaining: rec.remaining, sequence: rec.sequence };
  });
}

function parseL3Levels(raw: unknown, side: string, marketId: string): NativeL3Level[] {
  if (!Array.isArray(raw)) throw new DepthSourceError(`${marketId}: L3 ${side} is not an array`, null);
  if (sideLooksLikeL2(raw)) throw new DepthL3UnavailableError(marketId);
  return raw.map((row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new DepthL3UnavailableError(marketId);
    }
    const rec = row as { price?: unknown; orders?: unknown };
    if (typeof rec.price !== 'string' || !DECIMAL.test(rec.price)) {
      throw new DepthSourceError(`${marketId}: L3 ${side} price is not a decimal string`, null);
    }
    return { price: rec.price, orders: parseL3Orders(rec.orders, marketId, side) };
  });
}

/** Matching native L3 only. L2 tuples / missing hitch → unavailable, never a copy. */
export function parseNativeL3(body: unknown, marketId: string): NativeL3Queue {
  if (l3RefuseCode(body) !== null) throw new DepthL3UnavailableError(marketId);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new DepthL3UnavailableError(marketId);
  }
  const raw = body as { level?: unknown; bids?: unknown; asks?: unknown };
  if (sideLooksLikeL2(raw.bids) || sideLooksLikeL2(raw.asks)) {
    throw new DepthL3UnavailableError(marketId);
  }
  if (raw.level !== 'L3') throw new DepthL3UnavailableError(marketId);
  return {
    level: 'L3',
    marketId,
    bids: parseL3Levels(raw.bids, 'bids', marketId),
    asks: parseL3Levels(raw.asks, 'asks', marketId),
  };
}

export interface HttpDepthSourceOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  /** Injected in tests. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * svc-matching over HTTP.
 *
 * Note what is NOT sent: no `Authorization`, no `x-intafaced-service` headers,
 * no signature. svc-matching authenticates order WRITES and leaves reads open,
 * so this client needs no credential — and because it needs none, this process
 * is not given one. The absence is the security property.
 */
export class HttpDepthSource implements DepthSource {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  /** Keep explicit OPEN evidence distinct from omitted/unknown flags. */
  readonly #depthTrading = new Map<string, { code: DepthMatchingTradingCode | null; openEvidence: MatchingTradingOpenEvidence }>();
  #board: MatchingTradingBoard | null = null;

  constructor(options: HttpDepthSourceOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  trading(marketId: string): DepthMatchingTradingCode | null {
    if (this.#depthTrading.has(marketId)) return this.#depthTrading.get(marketId)?.code ?? null;
    return tradingFromBoard(this.#board, marketId);
  }

  tradingOpenEvidence(marketId: string): MatchingTradingOpenEvidence {
    const depth = this.#depthTrading.get(marketId);
    if (depth) return depth.openEvidence;
    return { market: this.#board?.openMarkets.has(marketId) === true, venue: this.#board?.venueConfirmedOpen === true };
  }

  venueHalted(): boolean {
    if (this.#board?.venueHalted === true) return true;
    for (const status of this.#depthTrading.values()) if (status.code === DEPTH_VENUE_HALTED) return true;
    return false;
  }

  /** `null` ONLY for a 404, which callers are expected to give meaning to. */
  async #get(path: string): Promise<unknown | null> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, { signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (err) {
      throw new DepthSourceError(`svc-matching unreachable: ${err instanceof Error ? err.message : String(err)}`, null);
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new DepthSourceError(`svc-matching answered ${response.status} for ${path}`, response.status);
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      // A 200 that will not parse is not a book. SyntaxError would look like a
      // bug in this process, and a stand-in ladder, price, or sequence would
      // invent one matching never sent.
      throw new DepthSourceError(
        `svc-matching returned a body that is not JSON for ${path}: ${err instanceof Error ? err.message : String(err)}`,
        null,
      );
    }
    // JSON `null` parses without throwing. It is not the 404 signal: callers
    // treat a null return as matching holding no book. A 200 null is a
    // malformed success, same family as a body that is not JSON.
    if (body === null) {
      throw new DepthSourceError(`svc-matching returned a null JSON body for ${path}`, null);
    }
    return body;
  }

  async markets(): Promise<readonly string[]> {
    const body = await this.#get('/markets');
    this.#board = body === null ? null : parseMatchingBoard(body);
    const markets = (body as { markets?: unknown } | null)?.markets;
    if (!Array.isArray(markets) || markets.some((m) => typeof m !== 'string')) {
      throw new DepthSourceError('svc-matching returned no market list', null);
    }
    return markets as readonly string[];
  }

  /**
   * A LISTED MARKET WITH NO BOOK IS ABSENCE, NOT A ZERO BOOK.
   *
   * svc-matching answers 404 for a market it holds no book for, and it is right
   * to: reading must not create. Fabricating `{ bids: [], asks: [], sequence: 0 }`
   * would let a client draw a live empty ladder — a priced zero book — when
   * matching never allocated one. "Not listed" is the hub's typed close;
   * "listed, no book" is this error. Empty ≠ zero.
   */
  async snapshot(marketId: string, limit: number): Promise<DepthSnapshot> {
    const body = await this.#get(`/markets/${encodeURIComponent(marketId)}/depth?limit=${limit}`);
    if (body === null) {
      this.#depthTrading.delete(marketId);
      throw new DepthNoBookError(marketId);
    }
    const raw = body as { marketId?: unknown; sequence?: unknown; bids?: unknown; asks?: unknown };

    if (typeof raw.sequence !== 'number' || !Number.isInteger(raw.sequence)) {
      throw new DepthSourceError(`${marketId}: depth response carries no integer sequence`, null);
    }
    // The engine's sequence is the only thing that makes a delta stream safe.
    // If we cannot read it, we must not invent one. Both sides of the ladder
    // parse before the trading flag is stored: a refused book must not leave
    // this body's halt in trading(), and must not invent OPEN.
    const bids = parseLevels(raw.bids, 'bids', marketId);
    const asks = parseLevels(raw.asks, 'asks', marketId);
    // Matching trading flags ride on the same public read. Omitted flags stay
    // unknown — never invented OPEN, never invented halt from an empty ladder.
    this.#depthTrading.set(marketId, { code: parseMatchingTrading(body), openEvidence: matchingTradingOpenEvidence(body) });
    return {
      type: 'snapshot',
      marketId,
      sequence: raw.sequence,
      bids,
      asks,
    };
  }

  /**
   * Native matching queue. Separate path from `snapshot()` so L2 tuples cannot
   * leak onto an L3 door. Matching 200 + `l3_unavailable` is still unavailable.
   */
  async l3Queue(marketId: string, limit: number): Promise<NativeL3Queue> {
    const body = await this.#get(`/markets/${encodeURIComponent(marketId)}/depth/l3?limit=${limit}`);
    if (body === null) throw new DepthNoBookError(marketId);
    return parseNativeL3(body, marketId);
  }
}
