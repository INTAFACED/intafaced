/**
 * Convert's quote and accept calls (UI-SPEC 5.8), through the same tool client the old Convert page uses
 * (`convert.quote`, `convert.accept`). A quote is firm for 15 seconds; this refreshes it on expiry, never accepts a
 * quote the customer has not seen, and never sends an accept twice by itself.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefusalCopy } from '../../../data/types';
import {
  classifyRefusal,
  convertQuoteSchema,
  convertTradeSchema,
  refusalCopy,
  type ApiResult,
  type RefusalContext,
  type ToolApi,
} from '../buy/deps';
import { isNetworkFailure, plainRefusal } from '../buy/quote-flow';
import { refinedQty } from './convert-model';
import { dec } from '../buy/trade-math';
import { runGuarded, type BlockReason, type Pending } from '../buy/write-lock';
import type { z } from 'zod';

export type Quote = z.infer<typeof convertQuoteSchema>;
export type Fill = z.infer<typeof convertTradeSchema>;

export interface QuoteRequest {
  symbol: string;
  side: 'buy' | 'sell';
  /** Base-coin quantity, a whole number of the lot. */
  qty: string;
  /** What the customer typed in the From asset; only used to tighten the first quote (buying with the quote asset). */
  typed: string;
  lot: string;
  /** Pair for the "Use Spot" link when instant buys are paused. */
  pair: string;
}

export type QuoteState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; quote: Quote; heldUntil: number }
  /** A typed refusal: words and a way forward from the data layer's copy. */
  | { status: 'refused'; copy: RefusalCopy; kind: ReturnType<typeof classifyRefusal> }
  /** The book cannot fill that much right now. */
  | { status: 'depth' }
  | { status: 'error' };

const DEBOUNCE_MS = 400;
const MIN_HOLD_MS = 1_000;
const MAX_HOLD_MS = 60_000;

/** How long a quote is firm, measured from the moment it ARRIVED (so a wrong computer clock cannot stretch it). */
export function holdMs(quote: Pick<Quote, 'expiresAt' | 'source'>): number {
  const end = Date.parse(quote.expiresAt);
  const start = Date.parse(quote.source.asOf);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return 0;
  return Math.min(MAX_HOLD_MS, Math.max(0, end - start));
}

function matches(quote: Quote, request: QuoteRequest, qty: string): boolean {
  const asked = dec(qty);
  const got = dec(quote.requestedQty);
  return quote.symbol === request.symbol && quote.side === request.side && asked !== null && got !== null && asked === got;
}

async function askOnce(tools: ToolApi, request: QuoteRequest, qty: string): Promise<ApiResult<Quote>> {
  const result = await tools.convertQuote({ symbol: request.symbol, side: request.side, qty });
  if (result.ok && !matches(result.data, request, qty))
    return { ok: false, reason: 'invalid_response', message: 'The quote does not match the request.' };
  return result;
}

/** One quote, tightened once when paying with the quote asset (see `refinedQty`). Reads only: safe to repeat. */
export async function fetchQuote(tools: ToolApi, request: QuoteRequest): Promise<ApiResult<Quote>> {
  const first = await askOnce(tools, request, request.qty);
  if (!first.ok || request.side !== 'buy' || !first.data.fullyFilled) return first;
  const next = refinedQty({ qty: request.qty, spent: first.data.inAmount, typed: request.typed, lot: request.lot });
  if (next === null) return first;
  const second = await askOnce(tools, request, next);
  if (!second.ok || !second.data.fullyFilled) return first;
  const spent = dec(second.data.inAmount);
  const typed = dec(request.typed);
  return spent !== null && typed !== null && spent <= typed ? second : first;
}

function toState(result: ApiResult<Quote>, request: QuoteRequest, receivedAt: number): QuoteState {
  if (result.ok) {
    const hold = holdMs(result.data);
    // Without a readable expiry the quote cannot be trusted for any time at all.
    if (!result.data.fullyFilled) return { status: 'depth' };
    return hold < MIN_HOLD_MS ? { status: 'error' } : { status: 'ready', quote: result.data, heldUntil: receivedAt + hold };
  }
  if (result.code === 'trade.convert_insufficient_depth' || /insufficient book depth/i.test(result.message)) return { status: 'depth' };
  if (isNetworkFailure(result) || result.reason === 'unreachable' || result.reason === 'uncertain') return { status: 'error' };
  return {
    status: 'refused',
    copy: convertRefusal(result, { pair: request.pair.replace('/', '-') }),
    kind: classifyRefusal(result.code ?? ''),
  };
}

/**
 * The live quote for the current input: asked 400 ms after the last change, asked again the moment it expires (and as
 * soon as the tab is visible again), and dropped the moment the input changes so a number for another amount is never shown.
 */
export function useQuote(tools: ToolApi, request: QuoteRequest | null) {
  const [held, setHeld] = useState<{ key: string; state: QuoteState }>({ key: '', state: { status: 'idle' } });
  const [now, setNow] = useState(() => Date.now());
  const [refreshKey, setRefreshKey] = useState(0);
  const key = request ? `${request.symbol}|${request.side}|${request.qty}|${request.typed}` : '';
  const requestRef = useRef(request);
  requestRef.current = request;
  // A quote belongs to the input it was asked for: for any other input there is nothing to show yet.
  const state: QuoteState = !request ? { status: 'idle' } : held.key === key ? held.state : { status: 'loading' };

  useEffect(() => {
    const current = requestRef.current;
    if (!current) return;
    let stale = false;
    // An expiring quote stays on screen (marked expired) until its replacement arrives; anything else shows loading.
    setHeld((previous) =>
      previous.key === key && previous.state.status === 'ready' && refreshKey > 0 ? previous : { key, state: { status: 'loading' } },
    );
    const timer = setTimeout(
      () => {
        void (async () => {
          let result: ApiResult<Quote>;
          try {
            result = await fetchQuote(tools, current);
          } catch {
            result = { ok: false, reason: 'unreachable', message: 'No answer.' };
          }
          if (!stale) setHeld({ key, state: toState(result, current, Date.now()) });
        })();
      },
      refreshKey > 0 ? 0 : DEBOUNCE_MS,
    );
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [tools, key, refreshKey]);

  // A clock ticks while a quote is held; it also drives the refresh on expiry.
  const heldUntil = state.status === 'ready' ? state.heldUntil : null;
  useEffect(() => {
    if (heldUntil === null) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, [heldUntil]);

  const expired = heldUntil !== null && now >= heldUntil;
  useEffect(() => {
    if (!expired) return;
    const refresh = () => {
      if (document.visibilityState === 'visible') setRefreshKey((value) => value + 1);
    };
    refresh();
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, [expired]);

  const secondsLeft = heldUntil === null ? null : Math.max(0, Math.ceil((heldUntil - now) / 1000));
  const retry = useCallback(() => setRefreshKey((value) => value + 1), []);
  return { state, secondsLeft, expired, retry };
}

export type AcceptOutcome =
  | { kind: 'blocked'; reason: BlockReason; pending?: Pending }
  | { kind: 'done'; fill: Fill }
  | { kind: 'refused'; copy: RefusalCopy; code: string | null }
  /** Outcome unknown: the note stays and Activity is the place to look. */
  | { kind: 'uncertain'; clientConvertId: string };

export const newClientConvertId = () => `convert:${crypto.randomUUID()}`;

/**
 * Accept ONE quote, once. The service treats the quote id as the idempotency fence: accepting the same quote again
 * returns the original conversion and cannot make a second one. Even so, nothing here repeats the call on its own;
 * `recheck` is for a button the customer presses after an unknown outcome, with the SAME quote id and request id.
 */
export async function acceptQuote(
  tools: ToolApi,
  userId: string | null,
  quote: Quote,
  clientConvertId: string,
  context: { asset?: string; available?: string },
  options: { recheck?: boolean } = {},
): Promise<AcceptOutcome> {
  const pending: Pending = { kind: 'convert', id: clientConvertId, symbol: quote.symbol, startedAt: Date.now() };
  const guarded = await runGuarded(
    userId,
    pending,
    () => tools.convertAccept(quote.quoteId, clientConvertId),
    (result) => (!result.ok && result.reason === 'uncertain') || (result.ok && !sameConversion(result.data, quote)),
    options,
  );
  if (guarded.kind === 'blocked') return { kind: 'blocked', reason: guarded.reason, pending: guarded.pending };
  if (guarded.kind === 'threw') return { kind: 'uncertain', clientConvertId };
  const result = guarded.value;
  if (result.ok) return sameConversion(result.data, quote) ? { kind: 'done', fill: result.data } : { kind: 'uncertain', clientConvertId };
  if (result.reason === 'uncertain') return { kind: 'uncertain', clientConvertId };
  return { kind: 'refused', copy: convertRefusal(result, context), code: result.code ?? null };
}

/**
 * A conversion is settled against OUR inventory, not the customer's balance alone. The customer's own balance is checked
 * before a quote is even asked for, so an "insufficient funds" answer at accept names a shortage on our side. Saying
 * "Not enough USDT" would blame the customer for it (the local stack hit this: the house held no ETH), so it reads as
 * the plain "can't be done right now" instead.
 */
export function convertRefusal(failure: Extract<ApiResult<unknown>, { ok: false }>, context: RefusalContext = {}): RefusalCopy {
  return classifyRefusal(failure.code ?? '') === 'insufficient' ? refusalCopy('', {}) : plainRefusal(failure, context);
}

/** The answer names the quote we accepted and the assets we showed; anything else is not a receipt for this conversion. The amounts on the receipt are always the service's own. */
export function sameConversion(fill: Fill, quote: Quote): boolean {
  return (
    fill.quoteId === quote.quoteId && fill.symbol === quote.symbol && fill.inAsset === quote.inAsset && fill.outAsset === quote.outAsset
  );
}

export { refusalCopy };
