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
  isHiddenPath,
  refusalCopy,
  type ApiResult,
  type RefusalContext,
  type ToolApi,
} from '../buy/deps';
import { isNetworkFailure, plainRefusal } from '../buy/quote-flow';
import { refinedQty, steppedDownQty } from './convert-model';
import { dec, str } from '../buy/trade-math';
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
  /** The most the quote may cost (From asset): what was typed, and never more than the available balance. */
  cap: string;
  /**
   * Set only for a buy where the customer typed the spend (the From side): the exact decimal to send as `quoteQty`, so the
   * service sizes the order and never charges more. Null for a sell, which keeps `qty`.
   */
  spend: string | null;
  lot: string;
  /** Pair for the "Use Spot" link when instant buys are paused. */
  pair: string;
}

export type QuoteState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; quote: Quote; heldUntil: number }
  /** A typed refusal: words and a way forward from the data layer's copy. */
  | { status: 'refused'; copy: RefusalCopy; kind: ReturnType<typeof classifyRefusal>; code: string | null }
  /** The book cannot fill that much right now. */
  | { status: 'depth' }
  /** Even the smallest whole lot, with our price on top, costs more than the budget. */
  | { status: 'overCost' }
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

/**
 * An older trade service does not know `quoteQty`: it drops the unknown key and refuses the call for the missing `qty`
 * (a plain BAD_REQUEST), or answers `trade.convert_invalid_qty`. Those, and only those, mean "ask the old way".
 * A depth or minimum refusal is a real answer and never falls back.
 */
export function refusesQuoteQty(failure: Extract<ApiResult<unknown>, { ok: false }>): boolean {
  if (/depth|minimum/i.test(failure.message)) return false;
  return failure.code === 'trade.convert_invalid_qty' || failure.code === 'BAD_REQUEST' || failure.code === 'trade.missing_qty';
}

/** Trade services seen to refuse `quoteQty` in this page's life, so the old way is not tried second every time. */
const oldServers = new WeakSet<ToolApi>();

/** Ask for a quote sized by the spend. Whatever comes back must be a buy that costs no more than the spend. */
async function askSpend(tools: ToolApi, request: QuoteRequest, spend: string): Promise<ApiResult<Quote>> {
  const result = await tools.convertQuote({ symbol: request.symbol, side: 'buy', quoteQty: spend });
  if (!result.ok) return result;
  const paid = dec(result.data.inAmount);
  const cap = dec(spend);
  if (result.data.symbol !== request.symbol || result.data.side !== 'buy' || paid === null || cap === null)
    return { ok: false, reason: 'invalid_response', message: 'The quote does not match the request.' };
  if (paid > cap) return overCost();
  return result;
}

async function askOnce(tools: ToolApi, request: QuoteRequest, qty: string): Promise<ApiResult<Quote>> {
  const result = await tools.convertQuote({ symbol: request.symbol, side: request.side, qty });
  if (result.ok && !matches(result.data, request, qty))
    return { ok: false, reason: 'invalid_response', message: 'The quote does not match the request.' };
  return result;
}

/** The failure `fetchQuote` returns when no quote fits the budget; mapped to the `overCost` state. */
export const OVER_COST_CODE = 'screen.convert_over_cost';
const overCost = (): ApiResult<Quote> => ({ ok: false, reason: 'error', message: 'No quote fits the budget.', code: OVER_COST_CODE });

/**
 * One quote that costs NO MORE than `cap` (what was typed and never more than the balance) when paying with the quote
 * asset. Our spread is added on top of the book price, so the first quote can overshoot (Max always does): it is stepped
 * DOWN and asked again, at most twice, and an over-cost quote is never returned. A first quote that falls a lot short is
 * tightened UP once (see `refinedQty`), kept only if it still fits. Reads only: safe to repeat.
 */
export async function fetchQuote(tools: ToolApi, request: QuoteRequest): Promise<ApiResult<Quote>> {
  // Typing the spend: the service finds the biggest whole-lot order that fits it, spread included. One read, exact.
  if (request.side === 'buy' && request.spend !== null && !oldServers.has(tools)) {
    const cap = dec(request.cap);
    const exact = cap !== null && cap > 0n ? str(cap) : null;
    if (exact !== null) {
      const answer = await askSpend(tools, request, exact);
      if (answer.ok || !refusesQuoteQty(answer)) return answer;
      if (answer.code === 'BAD_REQUEST') oldServers.add(tools);
    }
  }
  return fetchQuoteByLots(tools, request);
}

/** The older way (and the one sells use): ask by coin amount and walk it down or up to fit the budget. */
async function fetchQuoteByLots(tools: ToolApi, request: QuoteRequest): Promise<ApiResult<Quote>> {
  const first = await askOnce(tools, request, request.qty);
  if (!first.ok || request.side !== 'buy' || !first.data.fullyFilled) return first;
  const cap = dec(request.cap);
  if (cap === null) return overCost();
  let current = first.data;
  let qty = request.qty;
  for (let step = 0; step < 2 && (dec(current.inAmount) ?? cap + 1n) > cap; step += 1) {
    const next = steppedDownQty({ qty, spent: current.inAmount, cap: request.cap, lot: request.lot });
    if (next === null) return overCost();
    const result = await askOnce(tools, request, next);
    if (!result.ok || !result.data.fullyFilled) return result.ok ? overCost() : result;
    current = result.data;
    qty = next;
  }
  if ((dec(current.inAmount) ?? cap + 1n) > cap) return overCost();
  if (current !== first.data) return { ok: true, data: current };
  const up = refinedQty({ qty, spent: current.inAmount, typed: request.cap, lot: request.lot });
  if (up === null) return first;
  const second = await askOnce(tools, request, up);
  if (!second.ok || !second.data.fullyFilled) return first;
  const spent = dec(second.data.inAmount);
  return spent !== null && spent <= cap ? second : first;
}

function toState(result: ApiResult<Quote>, request: QuoteRequest, receivedAt: number): QuoteState {
  if (result.ok) {
    const hold = holdMs(result.data);
    // Without a readable expiry the quote cannot be trusted for any time at all.
    if (!result.data.fullyFilled) return { status: 'depth' };
    return hold < MIN_HOLD_MS ? { status: 'error' } : { status: 'ready', quote: result.data, heldUntil: receivedAt + hold };
  }
  if (result.code === OVER_COST_CODE) return { status: 'overCost' };
  if (result.code === 'trade.convert_insufficient_depth' || /insufficient book depth/i.test(result.message)) return { status: 'depth' };
  if (isNetworkFailure(result) || result.reason === 'unreachable' || result.reason === 'uncertain') return { status: 'error' };
  return {
    status: 'refused',
    copy: convertRefusal(result, { pair: request.pair.replace('/', '-') }),
    kind: classifyRefusal(result.code ?? ''),
    code: result.code ?? null,
  };
}

/**
 * The live quote for the current input: asked 400 ms after the last change, asked again the moment it expires (and the
 * moment the tab is visible again), and dropped the moment the input changes so a number for another amount is never shown.
 */
export function useQuote(tools: ToolApi, request: QuoteRequest | null) {
  const [held, setHeld] = useState<{ key: string; state: QuoteState }>({ key: '', state: { status: 'idle' } });
  const [now, setNow] = useState(() => Date.now());
  const [refreshKey, setRefreshKey] = useState(0);
  const key = request ? `${request.symbol}|${request.side}|${request.qty}|${request.typed}|${request.cap}|${request.spend ?? ''}` : '';
  const requestRef = useRef(request);
  requestRef.current = request;
  // A quote belongs to the input it was asked for: for any other input there is nothing to show.
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
export interface AcceptRef {
  quoteId: string;
  symbol: string;
  /** What the customer saw, to check the answer against; null when rebuilt from the device note after a reload. */
  inAsset: string | null;
  outAsset: string | null;
  /** What the quote costs the customer, in `inAsset`; null when unknown. */
  cost: string | null;
}

export const refOf = (quote: Quote): AcceptRef => ({
  quoteId: quote.quoteId,
  symbol: quote.symbol,
  inAsset: quote.inAsset,
  outAsset: quote.outAsset,
  cost: quote.inAmount,
});

export async function acceptQuote(
  tools: ToolApi,
  userId: string | null,
  quote: AcceptRef,
  clientConvertId: string,
  context: { asset?: string; available?: string; availableRaw?: string | null },
  options: { recheck?: boolean } = {},
): Promise<AcceptOutcome> {
  // The quote id travels in the shared device note (`orderId`), so a reload or another tab can still check this request.
  const pending: Pending = { kind: 'convert', id: clientConvertId, symbol: quote.symbol, orderId: quote.quoteId, startedAt: Date.now() };
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
  const cost = dec(quote.cost);
  const have = dec(context.availableRaw);
  const customerShort = cost !== null && have !== null && cost > have;
  return { kind: 'refused', copy: convertRefusal(result, context, customerShort), code: result.code ?? null };
}

/**
 * A conversion is settled against our inventory AND the customer's balance, and both legs fail with the same
 * "insufficient funds" code, so the code cannot say whose shortage it was. Compare the quote's cost with what the customer
 * holds: if it costs more, say "Not enough <asset>" (retrying cannot help); if not, the shortage is ours (the local stack
 * hit this: the house held no ETH) and it reads as the plain "can't be done right now", with Help when Help is live.
 */
export function convertRefusal(
  failure: Extract<ApiResult<unknown>, { ok: false }>,
  context: RefusalContext = {},
  customerShort = false,
): RefusalCopy {
  if (classifyRefusal(failure.code ?? '') !== 'insufficient') return plainRefusal(failure, context);
  if (customerShort) return refusalCopy('ledger.insufficient_funds', context);
  return refusalCopy('', { helpHref: isHiddenPath('/help') ? undefined : '/help' });
}

/** The answer names the quote we accepted and the assets we showed; anything else is not a receipt for this conversion. The amounts on the receipt are always the service's own. */
export function sameConversion(fill: Fill, quote: AcceptRef): boolean {
  return (
    fill.quoteId === quote.quoteId &&
    fill.symbol === quote.symbol &&
    (quote.inAsset === null || fill.inAsset === quote.inAsset) &&
    (quote.outAsset === null || fill.outAsset === quote.outAsset)
  );
}

export { refusalCopy };
