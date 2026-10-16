import {
  createVenueMarketDataAdapter,
  createVenueTradeAdapter,
  type VenueMarketDataOptions,
  type VenueTradeAdapterOptions,
} from '@intafaced/venue-adapter';
import {
  VenueCredentialsMissingError,
  VenueUnavailableError,
  midFromSnapshot,
  type PlaceOrderRequest,
  type TradeAdapter,
  type VenueCredentials,
  type VenueOrder,
} from '@intafaced/venue-contracts';
import { mul, type Amount } from '@intafaced/ledger-client';
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
  /** `null` only when the venue has confirmed there is no such client order. */
  fetchOrder(symbol: string, clientOrderId: string): Promise<VenueOrder | null>;
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
  return { mode: modeRaw, venueId, restBase, credentials, quoteTtlMs };
}

/** Binance says this, and only this, when the client id was never accepted. Any other failure is not a miss. */
export function isDefiniteOrderMiss(error: unknown): boolean {
  return error instanceof VenueUnavailableError && error.reason === 'unreachable' && /order does not exist/i.test(error.message);
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
    const mid = midFromSnapshot(snapshot);
    if (mid === null || mid <= 0n) throw new ConversionError('pay.conversion_quote_unconfigured', 'PRECONDITION_FAILED');
    const targetAmount = mul(input.fromAmount, mid);
    if (targetAmount <= 0n) throw new ConversionError('pay.conversion_quote_unconfigured', 'PRECONDITION_FAILED');
    return {
      rateScaled: mid,
      targetAmount,
      quotedAt: input.now,
      expiresAt: new Date(input.now.getTime() + config.quoteTtlMs),
    };
  });
}

export interface MemoryConversionVenue extends ConversionVenue {
  readonly placeCount: () => number;
  readonly orders: Map<string, VenueOrder>;
}

export interface MemoryFill {
  readonly status: VenueOrder['status'];
  readonly filled: Amount;
  /** Quote per base. Required once `filled` is positive. */
  readonly averagePrice: Amount | null;
}

/**
 * In-memory venue for tests. `fetchOrder` returns null until `placeOrder`.
 * A second place increments the counter and does not create a second order.
 */
export function createMemoryConversionVenue(opts: {
  venueId?: string;
  rateScaled: Amount;
  expiresAt: (now: Date) => Date;
  fill: (request: PlaceOrderRequest) => MemoryFill;
  now?: () => Date;
}): MemoryConversionVenue {
  const venueId = opts.venueId ?? 'binance-spot';
  const orders = new Map<string, VenueOrder>();
  let places = 0;
  const clock = opts.now ?? (() => new Date());

  function toOrder(request: PlaceOrderRequest, fill: MemoryFill): VenueOrder {
    const remaining = request.amount - fill.filled;
    return {
      venueId,
      venueOrderId: `mem-${request.clientOrderId}`,
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      price: request.price ?? null,
      amount: request.amount,
      filled: fill.filled,
      remaining: remaining < 0n ? 0n : remaining,
      averagePrice: fill.averagePrice,
      status: fill.status,
      feePaid: null,
      feeAsset: null,
      createdAt: clock(),
      observedAt: clock(),
    };
  }

  return {
    venueId,
    orders,
    placeCount: () => places,
    async quote(input) {
      const targetAmount = mul(input.fromAmount, opts.rateScaled);
      return {
        rateScaled: opts.rateScaled,
        targetAmount,
        quotedAt: input.now,
        expiresAt: opts.expiresAt(input.now),
      };
    },
    async placeOrder(request) {
      places += 1;
      const existing = orders.get(request.clientOrderId);
      if (existing) return existing;
      const order = toOrder(request, opts.fill(request));
      orders.set(request.clientOrderId, order);
      return order;
    },
    async fetchOrder(_symbol, clientOrderId) {
      return orders.get(clientOrderId) ?? null;
    },
    async cancelOrder(_symbol, clientOrderId) {
      const order = orders.get(clientOrderId);
      if (!order) throw new ConversionError('pay.conversion_venue_unknown', 'SERVICE_UNAVAILABLE');
      const canceled: VenueOrder = { ...order, status: 'canceled', remaining: 0n, observedAt: clock() };
      orders.set(clientOrderId, canceled);
      return canceled;
    },
  };
}
