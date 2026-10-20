import { createHash } from 'node:crypto';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { div, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import type { ConvertPort } from './auto-invest-service.js';

/**
 * HTTP ConvertPort — svc-trade `standing.quote` + `standing.execute`.
 *
 * A standing instruction is not an interactive customer: there is no session
 * and no minted principal. Bank makes a body-bound service call; the user and
 * instruction ride in the signed body and trade accepts only an authenticated
 * svc-bank.
 *
 * Bank never invents a mid. Pairing comes from the public markets listing
 * (not a price). Size and fill amounts come from convert itself. If trade
 * cannot quote or execute, this port refuses `bank.auto_invest_rate_unset`.
 */

export interface TradeConvertPortOptions {
  baseUrl: string;
  /** Shared internal service secret — svc-trade verifies the body-bound service call with it. */
  serviceSecret: string;
  /** Present once svc-bank has a signing key and S2S is on; absent leaves the shared secret alone. */
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
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
  quoteId: string;
  symbol: string;
  side: 'buy' | 'sell';
  requestedQty: string;
  filledQty: string;
  userNotional: string;
  avgPrice: string;
  fullyFilled: boolean;
}

interface ConvertExecuteWire {
  fillId: string;
  /** What the settled convert spent (in asset) and received (out asset). Decimal strings on the wire. */
  inAmount: string;
  outAmount: string;
}

const RATE_UNSET = 'bank.auto_invest_rate_unset' as const;
/** Trade public markets window — same 1..500 as `publishedMarketsLimit`. */
export const CONVERT_MARKETS_LIMIT_MAX = 500;

/**
 * The execute request was sent and its result is unknown or unusable. Not a
 * BankError on purpose: the run stays `pending` for reconciliation, because the
 * settle may have committed.
 */
export class ConvertOutcomeUnknown extends Error {
  constructor(detail: string) {
    super(`Auto-invest DCA convert outcome unknown (${detail})`);
    this.name = 'ConvertOutcomeUnknown';
  }
}

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
  const sign = serviceCallSigner({ service: 'svc-bank', audience: 'svc-trade', legacySecret: options.serviceSecret, s2s: options.s2s });

  async function call<T>(input: {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    query?: Record<string, string>;
    /** Sign the POST body as svc-bank. */
    service?: boolean;
    /**
     * The call can settle money. Once it is sent, only a typed trade refusal is
     * definite; a timeout, 5xx or unreadable answer is an unknown outcome and
     * throws a plain Error so the run stays `pending` (never `rejected`).
     */
    settles?: boolean;
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
          ...(input.service && payload ? sign(payload, { method: input.method, url: new URL(url), contentType: 'application/json' }) : {}),
        },
        body: payload,
        signal: controller.signal,
      });
      const text = await res.text().catch(() => '');
      let parsed: unknown = text;
      let unreadable = false;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        unreadable = true;
        parsed = { error: { message: text || `http ${res.status}` } };
      }
      if (input.settles && res.ok && (unreadable || (parsed !== null && typeof parsed === 'object' && 'error' in parsed))) {
        // A 2xx that is not a clean answer: the settle may have committed.
        throw new ConvertOutcomeUnknown('convert execute answered 2xx with an unreadable or error body');
      }
      if (!res.ok) {
        const rec = (parsed ?? {}) as { error?: { message?: string; data?: { intafacedCode?: string } }; intafacedCode?: string };
        const code = rec.error?.data?.intafacedCode ?? rec.intafacedCode;
        if (input.settles && (code === undefined || res.status >= 500)) {
          throw new ConvertOutcomeUnknown(`convert execute answered http ${res.status} without a typed refusal`);
        }
        rateUnset(code ?? rec.error?.message ?? `http ${res.status}`);
      }
      return unwrapTrpc<T>(parsed);
    } catch (err) {
      if (err instanceof BankError || err instanceof ConvertOutcomeUnknown) throw err;
      if (input.settles) throw new ConvertOutcomeUnknown(err instanceof Error ? err.message : 'convert execute unreachable');
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

  async function quote(
    userId: string,
    instructionId: string,
    symbol: string,
    side: 'buy' | 'sell',
    qty: Amount,
  ): Promise<ConvertQuoteWire> {
    const q = await call<ConvertQuoteWire>({
      method: 'POST',
      path: '/trpc/standing.quote',
      body: { userId, instructionId, symbol, side, qty: formatAmount(qty) },
      service: true,
    });
    if (
      !q ||
      typeof q.quoteId !== 'string' ||
      typeof q.avgPrice !== 'string' ||
      typeof q.userNotional !== 'string' ||
      typeof q.filledQty !== 'string'
    ) {
      rateUnset('convert quote missing amounts');
    }
    if (q.fullyFilled !== true) rateUnset('trade.convert_insufficient_depth');
    const avg = parseAmount(q.avgPrice);
    if (avg <= 0n) rateUnset('convert quote avgPrice is not a positive rate');
    return q;
  }

  /** Execute the quoted convert. Returns what settled; refuses unless a positive amount came out and no more than `maxSpend` went in. */
  async function execute(
    userId: string,
    instructionId: string,
    quoted: ConvertQuoteWire,
    symbol: string,
    side: 'buy' | 'sell',
    qty: Amount,
    clientConvertId: string,
    maxSpend: Amount,
  ): Promise<{ fillId: string; received: Amount }> {
    const settled = await call<ConvertExecuteWire>({
      method: 'POST',
      path: '/trpc/standing.execute',
      body: {
        userId,
        instructionId,
        quoteId: quoted.quoteId,
        clientConvertId: convertClientId(clientConvertId),
        symbol,
        side,
        qty: formatAmount(qty),
        maxAvgPrice: formatAmount(parseAmount(quoted.avgPrice)),
      },
      service: true,
      settles: true,
    });
    // The settle has already happened: nothing below may read as a refusal.
    const unknown = (detail: string): never => {
      throw new ConvertOutcomeUnknown(detail);
    };
    if (!settled || typeof settled.fillId !== 'string' || settled.fillId === '') return unknown('missing fill');
    let spent: Amount;
    let received: Amount;
    try {
      spent = parseAmount(settled.inAmount);
      received = parseAmount(settled.outAmount);
    } catch {
      return unknown('unreadable settled amounts');
    }
    if (spent > maxSpend) return unknown('settled spend above the authorized amount, reconcile');
    if (received <= 0n) return unknown('settled with nothing received, reconcile');
    return { fillId: settled.fillId, received };
  }

  return {
    async convert(input) {
      const market = await listedSpot(input.fromAsset, input.toAsset);
      const sellingBase = input.fromAsset === market.base && input.toAsset === market.quote;
      const buyingBase = input.fromAsset === market.quote && input.toAsset === market.base;
      if (!sellingBase && !buyingBase) rateUnset('assets do not match listed market');
      const { userId, instructionId } = input;

      if (sellingBase) {
        const q = await quote(userId, instructionId, market.symbol, 'sell', input.fromAmount);
        const order = await execute(
          userId,
          instructionId,
          q,
          market.symbol,
          'sell',
          input.fromAmount,
          input.clientConvertId,
          input.fromAmount,
        );
        return { toAmount: order.received, ledgerTxId: order.fillId };
      }

      // Spend quote, receive base: size the base qty from convert's own avg.
      // The probe quantity is the market's published minimum. Never invent one.
      const probe = await quote(userId, instructionId, market.symbol, 'buy', market.minQty);
      const avg = parseAmount(probe.avgPrice);
      const sized = floorToStep(div(input.fromAmount, avg, 'floor'), market.minQty);
      if (sized <= 0n) rateUnset('spend amount below convert min qty at trade rate');
      const live = await quote(userId, instructionId, market.symbol, 'buy', sized);
      const liveNotional = parseWireAmount(live.userNotional, 'buy convert userNotional');
      if (liveNotional <= 0n) rateUnset('buy convert notional is not positive');
      if (liveNotional > input.fromAmount) rateUnset('buy convert notional exceeds authorized fromAmount');
      const order = await execute(userId, instructionId, live, market.symbol, 'buy', sized, input.clientConvertId, input.fromAmount);
      return { toAmount: order.received, ledgerTxId: order.fillId };
    },
  };
}
