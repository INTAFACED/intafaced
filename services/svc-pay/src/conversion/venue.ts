import {
  createVenueMarketDataAdapter,
  createVenueTradeAdapter,
  type VenueMarketDataOptions,
  type VenueTradeAdapterOptions,
} from '@intafaced/venue-adapter';
import {
  VenueCredentialsMissingError,
  VenueUnavailableError,
  topOfBook,
  type PlaceOrderRequest,
  type TradeAdapter,
  type VenueCredentials,
  type VenueOrder,
} from '@intafaced/venue-contracts';
import { mul, parseAmount, type Amount } from '@intafaced/ledger-client';
import { ConversionError } from './errors.js';

/**
 * SANDBOX CONVERSION VENUE.
 *
 * Live mode refuses to boot. A host that is not on the testnet allow-list
 * refuses to boot. With no testnet key configured, quote and order refuse —
 * they do not invent a fill. Quote expiry comes from the venue (or, for a book
 * mid, from PAY_CONVERSION_QUOTE_TTL_MS). An unset TTL refuses; it is not given
 * a default.
 */

/** Hosts a sandbox conversion may talk to. Anything else, including a live API host, refuses. */
export const CONVERSION_TESTNET_HOSTS = ['testnet.binance.vision', 'api-testnet.bybit.com'] as const;

export interface ConversionVenueQuote {
  readonly rateScaled: Amount;
  readonly targetAmount: Amount;
  readonly quotedAt: Date;
  readonly expiresAt: Date;
}

export interface ConversionVenue {
  readonly venueId: string;
  quote(input: { symbol: string; fromAmount: Amount; now: Date }): Promise<ConversionVenueQuote>;
  placeOrder(request: PlaceOrderRequest): Promise<VenueOrder>;
  /**
   * Realtime / open lookup. `null` only when the venue has confirmed the id is
   * not on the open list. A closed spot order is not here — see `fetchClosedOrder`.
   */
  fetchOrder(symbol: string, clientOrderId: string): Promise<VenueOrder | null>;
  /** Closed spot orders. `null` is a confirmed miss, not a transport failure. */
  fetchClosedOrder(symbol: string, clientOrderId: string): Promise<VenueOrder | null>;
  cancelOrder(symbol: string, clientOrderId: string): Promise<VenueOrder>;
}

type Env = Record<string, string | undefined>;

export interface ConversionBootConfig {
  readonly mode: 'off' | 'sandbox';
  readonly venueId: string | null;
  readonly restBase: string | null;
  readonly credentials: VenueCredentials | null;
  /** Null = not configured. Quote then refuses. Never a default. */
  readonly quoteTtlMs: number | null;
  /** Null = not configured. A quote refuses. Never a default tolerance. */
  readonly slippageBps: number | null;
  /**
   * How long a `placing` row must sit before a miss is reconciliation rather
   * than a wait. Null = not configured, and a miss refuses instead of placing again.
   */
  readonly placingMaxAgeMs: number | null;
}

function credentialsUnconfigured(): ConversionError {
  return new ConversionError('pay.conversion_credentials_unconfigured', 'PRECONDITION_FAILED');
}

/** A venue that refuses every call. Used when sandbox mode has no testnet key. */
export function unconfiguredConversionVenue(venueId = 'unconfigured'): ConversionVenue {
  const refuse = () => Promise.reject(credentialsUnconfigured());
  return {
    venueId,
    quote: refuse,
    placeOrder: refuse,
    fetchOrder: refuse,
    fetchClosedOrder: refuse,
    cancelOrder: refuse,
  };
}

export function isTestnetRestBase(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return (CONVERSION_TESTNET_HOSTS as readonly string[]).includes(host);
  } catch {
    return false;
  }
}

/**
 * Fail closed at boot.
 * `live` refuses. A REST base that is not a known testnet host refuses.
 * Keys present while mode is off refuse — a key must not sit on a process that
 * is not explicitly in sandbox.
 */
export function assertConversionBoot(env: Env): void {
  const config = readConversionConfig(env);
  if (config.mode === 'off' && config.credentials) {
    throw new Error('pay.conversion_live_refused: testnet credentials are set but PAY_CONVERSION_MODE is not sandbox');
  }
}

export function readConversionConfig(env: Env): ConversionBootConfig {
  const modeRaw = env.PAY_CONVERSION_MODE?.trim() || 'off';
  if (modeRaw === 'live') {
    throw new Error('pay.conversion_live_refused: USD to USDT conversion is sandbox/testnet only and refuses to boot in live mode');
  }
  if (modeRaw !== 'off' && modeRaw !== 'sandbox') {
    throw new Error('pay.conversion_mode_invalid: PAY_CONVERSION_MODE must be off or sandbox');
  }
  const restBase = env.PAY_CONVERSION_REST_BASE?.trim() || null;
  if (restBase && !isTestnetRestBase(restBase)) {
    throw new Error('pay.conversion_live_refused: PAY_CONVERSION_REST_BASE is not a known venue testnet host');
  }
  const venueId = env.PAY_CONVERSION_VENUE_ID?.trim() || null;
  const apiKey = env.PAY_CONVERSION_API_KEY?.trim() || '';
  const apiSecret = env.PAY_CONVERSION_API_SECRET?.trim() || '';
  const passphrase = env.PAY_CONVERSION_API_PASSPHRASE?.trim() || undefined;
  const hasKey = apiKey.length > 0 || apiSecret.length > 0 || passphrase !== undefined;
  let credentials: VenueCredentials | null = null;
  if (hasKey) {
    if (!venueId || !apiKey || !apiSecret) {
      throw new Error('pay.conversion_credentials_incomplete: venue id, api key and api secret are all required together');
    }
    if (!restBase) {
      throw new Error('pay.conversion_live_refused: testnet credentials require PAY_CONVERSION_REST_BASE on a known testnet host');
    }
    credentials = { venueId, apiKey, apiSecret, ...(passphrase ? { passphrase } : {}), scopes: ['read', 'trade'] };
  }
  const ttlRaw = env.PAY_CONVERSION_QUOTE_TTL_MS?.trim() ?? '';
  let quoteTtlMs: number | null = null;
  if (ttlRaw.length > 0) {
    if (!/^[1-9][0-9]*$/.test(ttlRaw)) {
      throw new Error('pay.conversion_quote_ttl_invalid: PAY_CONVERSION_QUOTE_TTL_MS must be a positive integer of milliseconds');
    }
    quoteTtlMs = Number(ttlRaw);
  }
  const slippageBps = readNonNegativeInt(env.PAY_CONVERSION_SLIPPAGE_BPS, 'pay.conversion_slippage_invalid: PAY_CONVERSION_SLIPPAGE_BPS');
  const placingMaxAgeMs = readNonNegativeInt(
    env.PAY_CONVERSION_PLACING_MAX_AGE_MS,
    'pay.conversion_placing_max_age_invalid: PAY_CONVERSION_PLACING_MAX_AGE_MS',
  );
  return { mode: modeRaw, venueId, restBase, credentials, quoteTtlMs, slippageBps, placingMaxAgeMs };
}

/** Unset is null. Zero is a configured value. Anything else refuses to boot. */
function readNonNegativeInt(raw: string | undefined, name: string): number | null {
  const trimmed = raw?.trim() ?? '';
  if (trimmed.length === 0) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(trimmed)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return Number(trimmed);
}

/**
 * A confirmed miss, and nothing else.
 * Binance says "order does not exist". Bybit's realtime list comes back empty
 * for an id that is not open — that is not proof the order was never accepted.
 * A timeout is neither of these.
 */
export function isBybitRealtimeMiss(error: unknown): boolean {
  return error instanceof VenueUnavailableError && error.reason === 'unreachable' && /realtime list is empty/i.test(error.message);
}

export function isDefiniteOrderMiss(error: unknown): boolean {
  return (
    error instanceof VenueUnavailableError &&
    error.reason === 'unreachable' &&
    (/order does not exist/i.test(error.message) || isBybitRealtimeMiss(error))
  );
}

export function conversionVenueFromTrade(trade: TradeAdapter, quote: ConversionVenue['quote']): ConversionVenue {
  return {
    venueId: trade.venue.id,
    quote,
    placeOrder: (request) => trade.placeOrder(request),
    async fetchOrder(symbol, clientOrderId) {
      try {
        return await trade.fetchOrder(symbol, clientOrderId);
      } catch (error) {
        if (isDefiniteOrderMiss(error)) return null;
        if (error instanceof VenueCredentialsMissingError) throw credentialsUnconfigured();
        throw new ConversionError('pay.conversion_venue_unknown', 'SERVICE_UNAVAILABLE');
      }
    },
    async fetchClosedOrder(symbol, clientOrderId) {
      const fetchClosed = trade.fetchClosedOrder?.bind(trade);
      if (!fetchClosed) return null;
      try {
        return await fetchClosed(symbol, clientOrderId);
      } catch (error) {
        if (error instanceof VenueCredentialsMissingError) throw credentialsUnconfigured();
        throw new ConversionError('pay.conversion_venue_unknown', 'SERVICE_UNAVAILABLE');
      }
    },
    cancelOrder: (symbol, clientOrderId) => trade.cancelOrder(symbol, clientOrderId),
  };
}

/**
 * The process venue. No key → every call refuses. A key → the venue-adapter
 * trade adapter on the configured testnet host. Quote uses that venue's book
 * mid and the configured TTL; a missing TTL or an empty book refuses.
 */
export function openConversionVenue(
  env: Env,
  ports?: { trade?: VenueTradeAdapterOptions; market?: VenueMarketDataOptions },
): ConversionVenue {
  const config = readConversionConfig(env);
  if (config.mode !== 'sandbox' || !config.credentials || !config.restBase || !config.venueId) {
    return unconfiguredConversionVenue(config.venueId ?? 'unconfigured');
  }
  const trade = createVenueTradeAdapter(config.venueId, config.credentials, { ...ports?.trade, restBase: config.restBase });
  if (!trade) throw new Error(`pay.conversion_venue_unknown: ${config.venueId} is not a venue-adapter trade venue`);
  const market = createVenueMarketDataAdapter(config.venueId, { ...ports?.market, restBase: config.restBase });
  return conversionVenueFromTrade(trade, async (input) => {
    if (config.quoteTtlMs === null) {
      throw new ConversionError('pay.conversion_quote_ttl_unconfigured', 'PRECONDITION_FAILED');
    }
    if (!market) throw new ConversionError('pay.conversion_quote_unconfigured', 'PRECONDITION_FAILED');
    const snapshot = await market.snapshotBook(input.symbol);
    // A conversion sells the from-asset, so the quote is the bid. Mid would
    // promise a price the book will not pay.
    const bid = topOfBook(snapshot.bids, snapshot.asks).bestBid;
    if (bid === null || bid <= 0n) throw new ConversionError('pay.conversion_quote_unconfigured', 'PRECONDITION_FAILED');
    const targetAmount = mul(input.fromAmount, bid);
    if (targetAmount <= 0n) throw new ConversionError('pay.conversion_quote_unconfigured', 'PRECONDITION_FAILED');
    return {
      rateScaled: bid,
      targetAmount,
      quotedAt: input.now,
      expiresAt: new Date(input.now.getTime() + config.quoteTtlMs),
    };
  });
}

export interface MemoryConversionVenue extends ConversionVenue {
  readonly placeCount: () => number;
  /** Latest order for a client id, open or closed. Assertions read this. Lookups do not. */
  readonly orders: Map<string, VenueOrder>;
  readonly lastPlace: () => PlaceOrderRequest | null;
  /**
   * The next place accepts the order, then throws a timeout. The following
   * `misses` realtime and history lookups report that the order does not exist.
   */
  armLag(misses: number): void;
}

export interface MemoryFill {
  readonly status: VenueOrder['status'];
  readonly filled: Amount;
  /** Quote per base. Required once `filled` is positive, unless the book touch supplies it. */
  readonly averagePrice: Amount | null;
  /** `null` means the venue did not say. Omit to charge the venue commission. */
  readonly feePaid?: Amount | null;
  readonly feeAsset?: string | null;
}

const CLOSED = new Set<VenueOrder['status']>(['filled', 'canceled', 'rejected', 'expired']);

/**
 * In-memory venue whose awkward cases match Binance and Bybit.
 *
 * A filled client id can be reused and creates a second order. A timed-out
 * place is followed by "order does not exist" until the lag passes. A sell
 * fills at the bid and a buy at the ask, never at the mid. An IOC that cannot
 * trade expires, including with `executedQty > 0` when the scripted fill says
 * so. Client ids longer than 36 characters are rejected. Commission is charged
 * unless the caller sets a known fee. Closed orders are absent from the
 * realtime lookup and present only in history.
 */
export function createMemoryConversionVenue(opts: {
  venueId?: string;
  /** Sell-side touch. Quote and marketable sells use this, not the mid. */
  bid: Amount;
  /** Buy-side touch. */
  ask: Amount;
  expiresAt: (now: Date) => Date;
  /** Scripted outcome. Absent uses the book: marketable IOC fills at the touch. */
  fill?: (request: PlaceOrderRequest) => MemoryFill;
  /** Charged on a fill when the script does not set `feePaid`. Known zero is `0n`, not null. */
  commission?: Amount;
  now?: () => Date;
}): MemoryConversionVenue {
  const venueId = opts.venueId ?? 'binance-spot';
  const commission = opts.commission ?? parseAmount('0.0001');
  const orders = new Map<string, VenueOrder>();
  const open = new Map<string, VenueOrder>();
  const history = new Map<string, VenueOrder>();
  let places = 0;
  let seq = 0;
  let lagRemaining = 0;
  let lagAfterTimeout = 0;
  let timeoutNext = false;
  let last: PlaceOrderRequest | null = null;
  const clock = opts.now ?? (() => new Date());

  function hidden(): boolean {
    if (lagRemaining <= 0) return false;
    lagRemaining -= 1;
    return true;
  }

  function remember(order: VenueOrder): void {
    orders.set(order.clientOrderId, order);
    if (CLOSED.has(order.status)) {
      open.delete(order.clientOrderId);
      history.set(order.clientOrderId, order);
    } else {
      history.delete(order.clientOrderId);
      open.set(order.clientOrderId, order);
    }
  }

  function match(request: PlaceOrderRequest): MemoryFill {
    if (opts.fill) return opts.fill(request);
    const sell = request.side === 'sell';
    const touch = sell ? opts.bid : opts.ask;
    const price = request.price ?? null;
    const marketable = request.type === 'market' || (price !== null && (sell ? price <= touch : price >= touch));
    if (!marketable) return { status: 'expired', filled: 0n, averagePrice: null, feePaid: 0n };
    return { status: 'filled', filled: request.amount, averagePrice: touch };
  }

  function toOrder(request: PlaceOrderRequest, fill: MemoryFill): VenueOrder {
    const remaining = request.amount - fill.filled;
    const touch = request.side === 'sell' ? opts.bid : opts.ask;
    const averagePrice = fill.filled > 0n ? (fill.averagePrice ?? touch) : fill.averagePrice;
    let feePaid: Amount | null;
    let feeAsset: string | null;
    if (fill.feePaid === null) {
      feePaid = null;
      feeAsset = null;
    } else if (fill.feePaid !== undefined) {
      feePaid = fill.feePaid;
      feeAsset = fill.feeAsset ?? (fill.feePaid > 0n ? 'USDT' : null);
    } else if (fill.filled > 0n) {
      feePaid = commission;
      feeAsset = commission > 0n ? 'USDT' : null;
    } else {
      feePaid = 0n;
      feeAsset = null;
    }
    seq += 1;
    return {
      venueId,
      venueOrderId: `mem-${seq}`,
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      price: request.price ?? null,
      amount: request.amount,
      filled: fill.filled,
      remaining: remaining < 0n ? 0n : remaining,
      averagePrice,
      status: fill.status,
      feePaid,
      feeAsset,
      createdAt: clock(),
      observedAt: clock(),
    };
  }

  return {
    venueId,
    orders,
    placeCount: () => places,
    lastPlace: () => last,
    armLag(misses: number) {
      lagAfterTimeout = misses;
      timeoutNext = true;
    },
    async quote(input) {
      const targetAmount = mul(input.fromAmount, opts.bid);
      return {
        rateScaled: opts.bid,
        targetAmount,
        quotedAt: input.now,
        expiresAt: opts.expiresAt(input.now),
      };
    },
    async placeOrder(request) {
      places += 1;
      last = request;
      if (request.clientOrderId.length > 36) {
        throw new VenueUnavailableError(venueId, 'malformed', 'clientOrderId exceeds 36 characters');
      }
      const live = open.get(request.clientOrderId);
      if (live) return live;
      const order = toOrder(request, match(request));
      remember(order);
      if (timeoutNext) {
        timeoutNext = false;
        lagRemaining = lagAfterTimeout;
        throw new Error('venue timeout');
      }
      return order;
    },
    async fetchOrder(_symbol, clientOrderId) {
      if (hidden()) return null;
      return open.get(clientOrderId) ?? null;
    },
    async fetchClosedOrder(_symbol, clientOrderId) {
      if (hidden()) return null;
      return history.get(clientOrderId) ?? null;
    },
    async cancelOrder(_symbol, clientOrderId) {
      const order = orders.get(clientOrderId);
      if (!order) throw new ConversionError('pay.conversion_venue_unknown', 'SERVICE_UNAVAILABLE');
      const canceled: VenueOrder = { ...order, status: 'canceled', remaining: 0n, observedAt: clock() };
      remember(canceled);
      return canceled;
    },
  };
}
