import type { PrivateOrderUpdate, PrivatePositionUpdate } from './hub.js';

/**
 * READ PORT FOR PRIVATE SNAPSHOTS.
 *
 * The hub is push-only; it does not remember open orders. After reconnect the
 * client has no book unless something reads current open rows. This port is
 * that read — injected in tests, HTTP to svc-trade private REST in production.
 *
 * Never invents a mid or a price. Decimal strings on the wire; a JSON number
 * fails the parse and the snapshot is empty rather than coerced.
 */
export interface PrivateBookPort {
  listOpenOrders(input: { accessToken: string; userId: string }): Promise<readonly PrivateOrderUpdate[]>;
  listOpenPositions(input: { accessToken: string; userId: string }): Promise<readonly PrivatePositionUpdate[]>;
  /**
   * Strict open-positions read for the positions-stream seed.
   * Throws {@link PrivateBookError} on a failed fetch, timeout, non-2xx,
   * unparseable JSON, a non-array body, or any row `parseOpenPosition` refuses.
   * Optional so a port that only lists still compiles. The positions seed stays
   * unwired when this method is absent — a cold subscribe then refuses.
   */
  readOpenPositions?(input: { accessToken: string; userId: string }): Promise<readonly unknown[]>;
}

export class PrivateBookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivateBookError';
  }
}

const UNSIGNED_DECIMAL = /^\d+(\.\d{1,18})?$/;
const SIGNED_DECIMAL = /^-?\d+(\.\d{1,18})?$/;
const MISSING_OPEN_ORDER_FILL = 'filledQty is missing';

export const EMPTY_PRIVATE_BOOK: PrivateBookPort = {
  async listOpenOrders() {
    return [];
  },
  async listOpenPositions() {
    return [];
  },
};

function refuseNumber(value: unknown, field: string): void {
  if (typeof value === 'number') {
    throw new PrivateBookError(`${field} is a JSON number — decimal strings only`);
  }
}

function unsignedDecimal(value: unknown, field: string): string {
  refuseNumber(value, field);
  if (typeof value !== 'string' || !UNSIGNED_DECIMAL.test(value)) {
    throw new PrivateBookError(`${field} is not an unsigned decimal string`);
  }
  return value;
}

function signedDecimalOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  refuseNumber(value, field);
  if (typeof value !== 'string' || !SIGNED_DECIMAL.test(value)) {
    throw new PrivateBookError(`${field} is not a decimal string`);
  }
  return value;
}

function unsignedDecimalOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return unsignedDecimal(value, field);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PrivateBookError(`${field} is missing`);
  }
  return value;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Map one REST open-order row (CCXT `presentCcxtOrder` or tRPC `presentOrder`)
 * onto the same shape private deltas already use. `userId` comes from the
 * verified socket principal — never from the body.
 */
export function parseOpenOrder(raw: unknown, userId: string): PrivateOrderUpdate {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PrivateBookError('open order row is not an object');
  }
  const row = raw as Record<string, unknown>;
  const orderId = text(typeof row.orderId === 'string' ? row.orderId : row.id, 'orderId');
  const qty = unsignedDecimal(row.qty ?? row.amount, 'qty');
  const rawFilled = row.filledQty ?? row.filled;
  if (rawFilled === undefined || rawFilled === null) {
    throw new PrivateBookError(MISSING_OPEN_ORDER_FILL);
  }
  const filledQty = unsignedDecimal(rawFilled, 'filledQty');
  const price = unsignedDecimalOrNull(row.price, 'price');
  const ts = typeof row.ts === 'string' ? row.ts : typeof row.datetime === 'string' ? row.datetime : new Date(0).toISOString();
  const marketId = text(typeof row.marketId === 'string' && row.marketId.length > 0 ? row.marketId : row.symbol, 'marketId');
  return {
    orderId,
    userId,
    marketId,
    status: text(row.status, 'status'),
    side: text(row.side, 'side'),
    type: text(row.type, 'type'),
    qty,
    filledQty,
    price,
    clientOrderId: textOrNull(row.clientOrderId),
    ts,
  };
}

export function parseOpenPosition(raw: unknown, userId: string): PrivatePositionUpdate {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PrivateBookError('open position row is not an object');
  }
  const row = raw as Record<string, unknown>;
  const positionId = text(typeof row.positionId === 'string' ? row.positionId : row.id, 'positionId');
  const symbol = text(row.symbol, 'symbol');
  const marketId = typeof row.marketId === 'string' && row.marketId.length > 0 ? row.marketId : symbol;
  const statusRaw = row.status;
  const status = statusRaw === 'open' || statusRaw === 'closing' || statusRaw === 'closed' || statusRaw === 'liquidated' ? statusRaw : null;
  if (status === null) throw new PrivateBookError('status is not open, closing, closed, or liquidated');
  const side = row.side === 'short' ? 'short' : row.side === 'long' ? 'long' : null;
  if (side === null) throw new PrivateBookError('side is not long or short');
  const ts = typeof row.ts === 'string' ? row.ts : typeof row.datetime === 'string' ? row.datetime : new Date(0).toISOString();
  const marginMode = row.marginMode === 'isolated' ? 'isolated' : row.marginMode === 'cross' ? 'cross' : null;
  return {
    positionId,
    userId,
    marketId,
    symbol,
    status,
    side,
    contracts: unsignedDecimal(row.contracts, 'contracts'),
    entryPrice: unsignedDecimal(row.entryPrice, 'entryPrice'),
    markPrice: unsignedDecimalOrNull(row.markPrice, 'markPrice'),
    notional: unsignedDecimal(row.notional, 'notional'),
    leverage: unsignedDecimalOrNull(row.leverage, 'leverage'),
    collateral: unsignedDecimalOrNull(row.collateral, 'collateral'),
    unrealizedPnl: signedDecimalOrNull(row.unrealizedPnl, 'unrealizedPnl'),
    realizedPnl: signedDecimalOrNull(row.realizedPnl, 'realizedPnl'),
    liquidationPrice: unsignedDecimalOrNull(row.liquidationPrice, 'liquidationPrice'),
    marginMode,
    fundingPaid: signedDecimalOrNull(row.fundingPaid, 'fundingPaid'),
    closingReason: textOrNull(row.closingReason),
    ts,
  };
}

export function parseOpenOrderList(body: unknown, userId: string): PrivateOrderUpdate[] {
  if (!Array.isArray(body)) throw new PrivateBookError('open orders body is not an array');
  // A dropped row would make the reconnect snapshot look complete or empty.
  // Refuse the read so hydration names the unavailable book instead.
  return body.map((row) => parseOpenOrder(row, userId));
}

export function parseOpenPositionList(body: unknown, userId: string): PrivatePositionUpdate[] {
  if (!Array.isArray(body)) throw new PrivateBookError('open positions body is not an array');
  return body.map((row) => parseOpenPosition(row, userId));
}

export interface HttpPrivateBookPortOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * svc-trade private REST: `GET /api/v1/orders/open` and `GET /api/v1/positions`.
 *
 * Forwards the socket's access token. The process still holds no edge principal
 * secret and no service secret — it is a user-scoped read, same token the
 * client already presented on upgrade. Non-OK / unreachable → empty list
 * (honest miss, not a fabricated book).
 */
export class HttpPrivateBookPort implements PrivateBookPort {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: HttpPrivateBookPortOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async listOpenOrders(input: { accessToken: string; userId: string }): Promise<readonly PrivateOrderUpdate[]> {
    const body = await this.#get('/api/v1/orders/open', input.accessToken);
    if (body === null) return [];
    try {
      return parseOpenOrderList(body, input.userId);
    } catch {
      return [];
    }
  }

  async listOpenPositions(input: { accessToken: string; userId: string }): Promise<readonly PrivatePositionUpdate[]> {
    const body = await this.#get('/api/v1/positions', input.accessToken);
    if (body === null) return [];
    try {
      return parseOpenPositionList(body, input.userId);
    } catch {
      return [];
    }
  }

  /**
   * Same `GET /api/v1/positions` as {@link listOpenPositions}, but a miss is a
   * throw. The positions stream must not store that miss as an empty book.
   * Returns the raw JSON rows after every row has passed `parseOpenPosition`.
   */
  async readOpenPositions(input: { accessToken: string; userId: string }): Promise<readonly unknown[]> {
    const body = await this.#getStrict('/api/v1/positions', input.accessToken);
    if (!Array.isArray(body)) throw new PrivateBookError('open positions body is not an array');
    for (const row of body) parseOpenPosition(row, input.userId);
    return body;
  }

  async #getStrict(path: string, accessToken: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw new PrivateBookError(err instanceof Error ? err.message : 'open positions read failed');
    }
    if (!response.ok) throw new PrivateBookError(`open positions read failed: HTTP ${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new PrivateBookError('open positions body is not JSON');
    }
  }

  async #get(path: string, accessToken: string): Promise<unknown | null> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
}
