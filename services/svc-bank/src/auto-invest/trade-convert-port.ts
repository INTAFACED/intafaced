import { createHash } from 'node:crypto';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { div, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import type { ConvertPort } from './auto-invest-service.js';

/**
 * HTTP ConvertPort — svc-trade `convert.quote` + `convert.execute`.
 *
 * Bank never invents a mid. Pairing comes from the public markets listing
 * (not a price). Size and fill amounts come from convert itself. If trade
 * cannot quote or execute, this port refuses `bank.auto_invest_rate_unset`.
 */

export interface TradeConvertPortOptions {
  baseUrl: string;
  /**
   * Ignored. Auto-invest acts as svc-bank. It does not mint a user principal.
   * Kept so existing callers compile while the wiring moves to `serviceSecret`.
   */
  edgeSecret?: string;
  /** Service identity for the convert call. The user id travels in the body. */
  serviceSecret?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  region?: string;
  /**
   * Owner-published page size for `GET /api/v1/markets?limit=` (trade 1..500).
   * Unset refuses `bank.convert_markets_limit_unset` — never invent 50.
   */
  marketsLimit?: number;
}

interface ListedMarket {
  symbol: string;
  base: string;
  quote: string;
  spot?: boolean;
  active?: boolean;
  limits?: { amount?: { min?: string | null } };
}

interface ConvertQuoteWire {
  symbol: string;
  side: 'buy' | 'sell';
  requestedQty: string;
  filledQty: string;
  userNotional: string;
  avgPrice: string;
  fullyFilled: boolean;
}

interface ConvertExecuteWire {
  id: string;
  filled: string;
  remaining?: string;
  status?: string;
  /** Quote asset the fill received on a sell. Decimal string on the wire. */
  outAmount?: string;
}

const RATE_UNSET = 'bank.auto_invest_rate_unset' as const;
/** Trade public markets window — same 1..500 as `publishedMarketsLimit`. */
export const CONVERT_MARKETS_LIMIT_MAX = 500;

function rateUnset(detail: string): never {
  throw new BankError(`Auto-invest DCA convert refused — trade did not supply a rate (${detail})`, RATE_UNSET);
}

/** Decimal string → scaled bigint. Missing, blank, or unreadable refuses. Never a number. */
function parseWireAmount(raw: unknown, detail: string): Amount {
  if (typeof raw !== 'string' || raw.trim() === '') rateUnset(detail);
  try {
    return parseAmount(raw);
  } catch {
    rateUnset(detail);
  }
}

/** Owner-published convert markets page. Blank / non-int / out of 1..500 refuses — never invent 50. */
export function assertConvertMarketsListLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > CONVERT_MARKETS_LIMIT_MAX) {
    throw new BankError(
      'convert markets listing page size is unset. Blank refuses — never 50. Pass a positive integer 1..500 (50 is allowed if explicit).',
      'bank.convert_markets_limit_unset',
    );
  }
  return limit;
}

/** TRADE_URL is usable when it is an http(s) URL with a host. */
export function usableTradeConvertUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function convertClientId(raw: string): string {
  if (raw.length >= 1 && raw.length <= 48) return raw;
  return createHash('sha256').update(raw).digest('hex').slice(0, 48);
}

function floorToStep(qty: Amount, step: Amount): Amount {
  if (step <= 0n) return qty;
  return qty - (qty % step);
}

function unwrapTrpc<T>(body: unknown): T {
  if (body !== null && typeof body === 'object') {
    const rec = body as { error?: { message?: string; data?: { intafacedCode?: string } }; result?: { data?: T } | T };
    if (rec.error) {
      const code = rec.error.data?.intafacedCode ?? rec.error.message ?? 'trade.convert_refused';
      rateUnset(code);
    }
    if (rec.result && typeof rec.result === 'object' && rec.result !== null && 'data' in rec.result) {
      return rec.result.data as T;
    }
    if (rec.result !== undefined) return rec.result as T;
  }
  return body as T;
}

export function tradeConvertPort(options: TradeConvertPortOptions): ConvertPort {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const baseUrl = options.baseUrl.replace(/\/$/, '');

  const serviceHeaders = (body: string | undefined): Record<string, string> => {
    if (!options.serviceSecret || options.serviceSecret.length < 32 || body === undefined) return {};
    return serviceAuthHeadersForBody('svc-bank', options.serviceSecret, body);
  };

  async function call<T>(input: {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    query?: Record<string, string>;
    headers?: Record<string, string>;
  }): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const params = new URLSearchParams();
      if (input.method === 'GET' && input.body !== undefined) {
        params.set('input', JSON.stringify(input.body));
      }
      if (input.query) {
        for (const [key, value] of Object.entries(input.query)) params.set(key, value);
      }
      const qs = params.toString();
      const url = qs ? `${baseUrl}${input.path}?${qs}` : `${baseUrl}${input.path}`;
      const payload = input.method === 'POST' ? JSON.stringify(input.body ?? {}) : undefined;
      const res = await doFetch(url, {
        method: input.method,
        headers: {
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json' } : {}),
          ...(input.headers ?? {}),
        },
        body: payload,
        signal: controller.signal,
      });
      const text = await res.text().catch(() => '');
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { error: { message: text || `http ${res.status}` } };
      }
      if (!res.ok) {
        const rec = parsed as { error?: { message?: string; data?: { intafacedCode?: string } }; intafacedCode?: string };
        rateUnset(rec.error?.data?.intafacedCode ?? rec.intafacedCode ?? rec.error?.message ?? `http ${res.status}`);
      }
      return unwrapTrpc<T>(parsed);
    } catch (err) {
      if (err instanceof BankError) throw err;
      rateUnset(err instanceof Error ? err.message : 'convert unreachable');
    } finally {
      clearTimeout(timer);
    }
  }

  async function listedSpot(fromAsset: string, toAsset: string): Promise<{ symbol: string; base: string; quote: string; minQty: Amount }> {
    const page = assertConvertMarketsListLimit(options.marketsLimit);
    const markets = await call<ListedMarket[]>({
      method: 'GET',
      path: '/api/v1/markets',
      query: { limit: String(page) },
    });
    if (!Array.isArray(markets)) rateUnset('markets listing unreadable');
    const match = markets.find((m) => {
      if (m.spot !== true || m.active !== true) return false;
      const pair = (m.base === fromAsset && m.quote === toAsset) || (m.base === toAsset && m.quote === fromAsset);
      return pair && typeof m.symbol === 'string';
    });
    if (!match) rateUnset(`no listed spot market for ${fromAsset}/${toAsset}`);
    const minQty = parseWireAmount(match.limits?.amount?.min, 'limits.amount.min');
    if (minQty <= 0n) rateUnset('limits.amount.min is not positive');
    return { symbol: match.symbol, base: match.base, quote: match.quote, minQty };
  }

  async function quote(userId: string, symbol: string, side: 'buy' | 'sell', qty: Amount): Promise<ConvertQuoteWire> {
    const body = { userId, symbol, side, qty: formatAmount(qty) };
    const q = await call<ConvertQuoteWire>({
      method: 'GET',
      path: '/trpc/convert.quote',
      body,
      headers: serviceHeaders(JSON.stringify(body)),
    });
    if (!q || typeof q.avgPrice !== 'string' || typeof q.userNotional !== 'string' || typeof q.filledQty !== 'string') {
      rateUnset('convert quote missing amounts');
    }
    if (q.fullyFilled !== true) rateUnset('trade.convert_insufficient_depth');
    const avg = parseAmount(q.avgPrice);
    if (avg <= 0n) rateUnset('convert quote avgPrice is not a positive rate');
    return q;
  }

  async function execute(
    userId: string,
    symbol: string,
    side: 'buy' | 'sell',
    qty: Amount,
    clientConvertId: string,
    maxAvgPrice: Amount,
  ): Promise<ConvertExecuteWire> {
    const body = {
      userId,
      symbol,
      side,
      qty: formatAmount(qty),
      clientConvertId: convertClientId(clientConvertId),
      maxAvgPrice: formatAmount(maxAvgPrice),
    };
    const order = await call<ConvertExecuteWire>({
      method: 'POST',
      path: '/trpc/convert.execute',
      body,
      headers: serviceHeaders(JSON.stringify(body)),
    });
    if (!order || typeof order.filled !== 'string' || typeof order.id !== 'string') {
      rateUnset('convert execute missing fill');
    }
    if (order.status !== 'filled') rateUnset('convert execute status is not filled');
    const remaining = parseWireAmount(order.remaining, 'convert execute remaining');
    if (remaining !== 0n) rateUnset('convert execute remaining is not zero');
    const filled = parseWireAmount(order.filled, 'convert execute filled');
    if (filled <= 0n) rateUnset('convert execute filled nothing');
    return order;
  }

  return {
    async convert(input) {
      const market = await listedSpot(input.fromAsset, input.toAsset);
      const sellingBase = input.fromAsset === market.base && input.toAsset === market.quote;
      const buyingBase = input.fromAsset === market.quote && input.toAsset === market.base;
      if (!sellingBase && !buyingBase) rateUnset('assets do not match listed market');

      if (sellingBase) {
        const q = await quote(input.userId, market.symbol, 'sell', input.fromAmount);
        const order = await execute(input.userId, market.symbol, 'sell', input.fromAmount, input.clientConvertId, parseAmount(q.avgPrice));
        const received = parseWireAmount(order.outAmount, 'sell convert outAmount');
        if (received <= 0n) rateUnset('sell convert received nothing');
        return { toAmount: received, ledgerTxId: order.id };
      }

      // Spend quote, receive base: size the base qty from convert's own avg.
      // The probe quantity is the market's published minimum. Never invent one.
      const probe = await quote(input.userId, market.symbol, 'buy', market.minQty);
      const avg = parseAmount(probe.avgPrice);
      const sized = floorToStep(div(input.fromAmount, avg, 'floor'), market.minQty);
      if (sized <= 0n) rateUnset('spend amount below convert min qty at trade rate');
      const live = await quote(input.userId, market.symbol, 'buy', sized);
      const liveNotional = parseWireAmount(live.userNotional, 'buy convert userNotional');
      if (liveNotional <= 0n) rateUnset('buy convert notional is not positive');
      if (liveNotional > input.fromAmount) rateUnset('buy convert notional exceeds authorized fromAmount');
      const order = await execute(input.userId, market.symbol, 'buy', sized, input.clientConvertId, parseAmount(live.avgPrice));
      return { toAmount: parseAmount(order.filled), ledgerTxId: order.id };
    },
  };
}
