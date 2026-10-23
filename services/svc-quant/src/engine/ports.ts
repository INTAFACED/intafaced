import { parseAmount } from '@intafaced/ledger-client/money';
import { z } from 'zod';
import { QUANT_BACKTEST_HISTORY_RANGE, QUANT_BACKTEST_LAKE_MISSING, QUANT_COST_UNSET, QuantError } from '../errors.js';
import { barSpanMs, type Bar, type BarSize } from './bars.js';

/**
 * The two reads a bar backtest needs, both from svc-trade's public routes (the same ones a chart or a CCXT client
 * reads): closed candles from the exchange's own taker tape (`GET /api/v1/ohlcv/:symbol`) and the published spot fee
 * schedule (`GET /api/v1/fees/published`). Neither carries account data. Unset TRADE_URL leaves both unwired and every
 * backtest refuses by name; nothing is invented in their place.
 */
export interface HistoryPort {
  readonly wired: boolean;
  /** Closed bars that start at or after `fromMs` and end by `toMs`, oldest first. Missing intervals are absent. */
  bars(query: { readonly symbol: string; readonly barSize: BarSize; readonly fromMs: number; readonly toMs: number }): Promise<Bar[]>;
}

export interface FeePort {
  readonly wired: boolean;
  fee(symbol: string): Promise<{ readonly version: string; readonly makerBps: number; readonly takerBps: number }>;
}

/** The ohlcv route answers at most this many bars back from now in one read (svc-trade's published row cap). */
export const HISTORY_BARS_BACK = 720;

const price = z.string().regex(/^\d+(\.\d{1,18})?$/);
const candleRow = z.tuple([z.number().int(), price, price, price, price, z.string()]);
const publishedFees = z.object({
  version: z.string().min(1),
  fees: z.record(z.object({ makerBps: z.number().int().nonnegative(), takerBps: z.number().int().nonnegative() })),
});

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

async function getJson(fetchImpl: Fetch, url: string, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    clearTimeout(timer);
  }
}

function codeOf(body: unknown): string {
  return body && typeof body === 'object' && typeof (body as { intafacedCode?: unknown }).intafacedCode === 'string'
    ? (body as { intafacedCode: string }).intafacedCode
    : 'no code';
}

export function missingHistory(): HistoryPort {
  return {
    wired: false,
    bars: async () => {
      throw new QuantError(QUANT_BACKTEST_LAKE_MISSING, 'the history read is not wired (TRADE_URL is unset); no bar is invented');
    },
  };
}

export function missingFees(): FeePort {
  return {
    wired: false,
    fee: async () => {
      throw new QuantError(QUANT_COST_UNSET, 'fees — the published fee schedule read is not wired (TRADE_URL is unset)');
    },
  };
}

export function tradeHistoryPort(options: {
  readonly tradeUrl: string;
  readonly now: () => number;
  readonly fetch?: Fetch;
  readonly timeoutMs?: number;
}): HistoryPort {
  const base = options.tradeUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as Fetch);
  return {
    wired: true,
    async bars({ symbol, barSize, fromMs, toMs }) {
      const span = barSpanMs(barSize);
      const now = options.now();
      // One bar short of the route's cap, so the route's own count (on its own clock) never lands one over it.
      if (fromMs < now - (HISTORY_BARS_BACK - 1) * span) {
        throw new QuantError(
          QUANT_BACKTEST_HISTORY_RANGE,
          `the window starts more than ${HISTORY_BARS_BACK} bars of ${barSize} before now; the history read reaches back that far`,
        );
      }
      const url = `${base}/api/v1/ohlcv/${encodeURIComponent(symbol)}?timeframe=${barSize}&since=${fromMs}&limit=${HISTORY_BARS_BACK}`;
      let answer: { status: number; body: unknown };
      try {
        answer = await getJson(fetchImpl, url, options.timeoutMs ?? 10_000);
      } catch {
        throw new QuantError(QUANT_BACKTEST_LAKE_MISSING, 'the history read did not answer; no bar is invented');
      }
      if (answer.status !== 200) {
        throw new QuantError(
          QUANT_BACKTEST_LAKE_MISSING,
          `the history read answered ${answer.status} (${codeOf(answer.body)}); no bar is invented`,
        );
      }
      const rows = z.array(candleRow).safeParse(answer.body);
      if (!rows.success) throw new QuantError(QUANT_BACKTEST_LAKE_MISSING, 'the history read answered rows that are not candles');
      const end = Math.min(toMs, now);
      const byOpen = new Map<number, Bar>();
      for (const [openTimeMs, open, high, low, close] of rows.data) {
        // Only whole, closed intervals inside the window: the strategy never sees a bar that has not closed.
        if (openTimeMs < fromMs || openTimeMs + span > end || openTimeMs % span !== 0) continue;
        if (byOpen.has(openTimeMs)) {
          throw new QuantError(QUANT_BACKTEST_LAKE_MISSING, 'the history read answered two candles for one interval');
        }
        byOpen.set(openTimeMs, {
          openTimeMs,
          open: parseAmount(open),
          high: parseAmount(high),
          low: parseAmount(low),
          close: parseAmount(close),
        });
      }
      return [...byOpen.values()].sort((a, b) => a.openTimeMs - b.openTimeMs);
    },
  };
}

export function tradeFeePort(options: { readonly tradeUrl: string; readonly fetch?: Fetch; readonly timeoutMs?: number }): FeePort {
  const base = options.tradeUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as Fetch);
  return {
    wired: true,
    async fee(symbol) {
      let answer: { status: number; body: unknown };
      try {
        answer = await getJson(fetchImpl, `${base}/api/v1/fees/published`, options.timeoutMs ?? 10_000);
      } catch {
        throw new QuantError(QUANT_COST_UNSET, 'fees — the published fee schedule read did not answer');
      }
      if (answer.status !== 200) {
        throw new QuantError(QUANT_COST_UNSET, `fees — the published fee schedule read answered ${answer.status} (${codeOf(answer.body)})`);
      }
      const parsed = publishedFees.safeParse(answer.body);
      if (!parsed.success) throw new QuantError(QUANT_COST_UNSET, 'fees — the published fee schedule read is not a schedule');
      const row = parsed.data.fees[symbol];
      if (!row) throw new QuantError(QUANT_COST_UNSET, `fees — the published schedule has no rate for ${symbol}`);
      return { version: parsed.data.version, makerBps: row.makerBps, takerBps: row.takerBps };
    },
  };
}
