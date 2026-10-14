/**
 * Buy and Sell under the hood (UI-SPEC 5.9, brief): a MARKET order on the coin's USDT market (else USDC), through the
 * same trade client the old desk uses (`features/trade/trade-api.ts`). That client already
 *   - asks the service for a preview (fee, the funds it will reserve, the protection price: the service's slippage cap),
 *   - re-previews right before sending and refuses to send if anything moved (the customer reviews the new numbers),
 *   - checks the answer names the order we sent (client order id), and
 *   - looks an order up by that id after a network failure instead of sending it again.
 * This file wires those to the screen and to the shared device note (`write-lock.ts`). It never sends an order twice.
 */
import { useEffect, useRef, useState } from 'react';
import type { Trade } from '@intafaced/exchange-contract/schemas';
import type { RefusalCopy } from '../../../data/types';
import { draftSchema, refusalCopy, type Draft, type Order, type Preview, type TradeApi } from './deps';
import { isNetworkFailure, plainRefusal, readableCode } from './quote-flow';
import { maxBase } from './order-plan';
import { dec, divDown, floorToStep, str } from './trade-math';
import { clearPending, readPending, runGuarded, type BlockReason, type Pending } from './write-lock';

export interface OrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  /** Coin amount, a whole number of the market's lot. */
  base: string;
}

/** A market order never rests on the book, so it is immediate-or-cancel. */
export function buildDraft(request: OrderRequest, clientOrderId: string): Draft {
  return draftSchema.parse({
    symbol: request.symbol,
    side: request.side,
    type: 'market',
    amount: request.base,
    timeInForce: 'IOC',
    postOnly: false,
    clientOrderId,
  });
}

export const newClientOrderId = () => `buy:${crypto.randomUUID()}`;

export type PreviewOutcome =
  | { kind: 'ok'; preview: Preview }
  | { kind: 'refused'; copy: RefusalCopy; code: string | null }
  /** Network or service failure: nothing was sent, and nothing is claimed. */
  | { kind: 'failed' };

/** Ask the service what this order would do. Safe to repeat: a preview changes nothing. */
export async function previewOrder(
  api: TradeApi,
  draft: Draft,
  context: { asset?: string; available?: string } = {},
): Promise<PreviewOutcome> {
  const result = await api.preview(draft);
  if (!result.ok) {
    if (isNetworkFailure(result) || result.reason === 'uncertain' || result.reason === 'unreachable') return { kind: 'failed' };
    return { kind: 'refused', copy: plainRefusal(result, context), code: result.code ?? null };
  }
  const preview = result.data;
  if (!preview.orderable || preview.refusals.length > 0) {
    const code = preview.refusals[0]?.code ?? null;
    return { kind: 'refused', copy: refusalCopy(readableCode(code), context), code };
  }
  // Same bar the desk sets before it will send: the fee and the reservation must be known.
  if (preview.holdAmount === null || preview.holdAsset === null || preview.estimatedFee === null || preview.feeAsset === null)
    return { kind: 'refused', copy: refusalCopy('', context), code: null };
  return { kind: 'ok', preview };
}

export type Estimate =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; preview: Preview }
  | { state: 'refused'; copy: RefusalCopy; code: string | null }
  | { state: 'error' };

const ESTIMATE_DELAY_MS = 500;

/**
 * The service's own numbers for the size that is typed (fee, protection price), refreshed 500 ms after the last keystroke.
 * Previews are read-only questions; a failed one shows nothing rather than guessing.
 */
export function useEstimate(api: TradeApi, request: OrderRequest | null, context: { asset?: string; available?: string }): Estimate {
  const [estimate, setEstimate] = useState<Estimate>({ state: 'idle' });
  const key = request ? `${request.symbol}|${request.side}|${request.base}` : '';
  const contextRef = useRef(context);
  contextRef.current = context;
  useEffect(() => {
    if (!request) {
      setEstimate({ state: 'idle' });
      return;
    }
    let stale = false;
    setEstimate({ state: 'loading' });
    const timer = setTimeout(() => {
      void (async () => {
        let outcome: PreviewOutcome;
        try {
          outcome = await previewOrder(api, buildDraft(request, `est:${crypto.randomUUID()}`), contextRef.current);
        } catch {
          outcome = { kind: 'failed' };
        }
        if (stale) return;
        setEstimate(
          outcome.kind === 'ok'
            ? { state: 'ready', preview: outcome.preview }
            : outcome.kind === 'refused'
              ? { state: 'refused', copy: outcome.copy, code: outcome.code }
              : { state: 'error' },
        );
      })();
    }, ESTIMATE_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [api, key]);
  return estimate;
}

export type PlaceOutcome =
  | { kind: 'blocked'; reason: BlockReason; pending?: Pending }
  | { kind: 'placed'; order: Order }
  /** The numbers moved since the customer looked: nothing was sent; review these and confirm again. */
  | { kind: 'changed'; preview: Preview }
  | { kind: 'refused'; copy: RefusalCopy; code: string | null }
  /** The outcome is unknown. The note stays, so no other order goes out until this one is looked up. */
  | { kind: 'uncertain'; clientOrderId: string };

/**
 * Send ONE order. `api.place` re-previews first and sends only if the preview still equals the one the customer
 * confirmed. Any unknown outcome keeps the device note; nothing here ever sends the same order again.
 */
export async function placeOrder(
  api: TradeApi,
  userId: string | null,
  draft: Draft,
  reviewed: Preview,
  context: { asset?: string; available?: string },
  stillWanted: () => boolean,
): Promise<PlaceOutcome> {
  const pending: Pending = { kind: 'place', id: draft.clientOrderId, symbol: draft.symbol, startedAt: Date.now() };
  const guarded = await runGuarded(
    userId,
    pending,
    () => api.place(draft, reviewed, () => stillWanted()),
    (result) => !result.ok && result.reason === 'uncertain',
  );
  if (guarded.kind === 'blocked') return { kind: 'blocked', reason: guarded.reason, pending: guarded.pending };
  if (guarded.kind === 'threw') return { kind: 'uncertain', clientOrderId: draft.clientOrderId };
  const result = guarded.value;
  if (result.ok) return { kind: 'placed', order: result.data };
  if (result.reason === 'changed' && 'preview' in result) return { kind: 'changed', preview: result.preview };
  if (result.reason === 'uncertain') return { kind: 'uncertain', clientOrderId: draft.clientOrderId };
  return { kind: 'refused', copy: plainRefusal(result, context), code: result.code ?? null };
}

export type CheckOutcome = { kind: 'found'; order: Order } | { kind: 'notFound' } | { kind: 'failed' };

/**
 * After an unknown outcome: look the order up by the id we sent (a read, never a second order). Only a found order
 * that has finished recovering clears the device note.
 */
export async function checkOrder(api: TradeApi, userId: string | null, pending: Pending): Promise<CheckOutcome> {
  const result = await api.reconcile(pending.id, pending.symbol);
  if (!result.ok) return result.reason === 'uncertain' ? { kind: 'notFound' } : { kind: 'failed' };
  if (userId && !result.data.recoveryRequired) clearPending(userId, pending.id);
  return { kind: 'found', order: result.data };
}

/**
 * The fills of a just-placed order: the ledger's record of what was really paid. They can lag the order by a moment, so
 * this reads (never writes) up to four times, 350 ms apart. The fills are accepted only when they ADD UP to what the
 * order says it filled: the list is newest-first and capped, so a partial view must never pass for the whole.
 * The window starts just before the order, and asks for 500. Otherwise null; the receipt then shows "—" for money.
 */
export async function fetchFills(api: TradeApi, order: Order, pauseMs = 350): Promise<Trade[] | null> {
  const filled = dec(order.filled);
  if (filled === null || filled === 0n) return null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    const result = await api.fills(order.symbol, 500, undefined, order.timestamp - 1000);
    if (result.ok && fillsComplete(order, result.data)) return result.data;
  }
  return null;
}

/** True when this order's fills in `trades` add up exactly to the order's filled amount. */
export function fillsComplete(order: Pick<Order, 'id' | 'filled'>, trades: readonly Trade[]): boolean {
  const filled = dec(order.filled);
  if (filled === null) return false;
  let sum = 0n;
  for (const trade of trades) {
    if (trade.order !== order.id) continue;
    const amount = dec(trade.amount);
    if (amount === null) return false;
    sum += amount;
  }
  return sum === filled;
}

export type MaxOutcome = { kind: 'ok'; base: string } | { kind: 'refused'; copy: RefusalCopy } | { kind: 'none' };

/**
 * "Max": the available balance minus the fee, in whole lots (brief money rules). A buy reserves funds at the
 * protection price, so the size is worked out from the service's own preview and then confirmed with a second one;
 * it never assumes a fee or a price. Up to three read-only previews.
 */
export async function computeMax(
  api: TradeApi,
  input: {
    symbol: string;
    side: 'buy' | 'sell';
    available: string | null;
    /** The price the first guess is sized from: the ask for a buy. Unused for a sell. */
    price: string | null;
    lot: string;
    spendAsset: string;
    /** The smallest size the market accepts (see `smallestOrder`); the first question is never smaller than this. */
    smallest?: string | null;
  },
): Promise<MaxOutcome> {
  const available = dec(input.available);
  const lot = dec(input.lot);
  const price = dec(input.price);
  if (available === null || available <= 0n || lot === null || lot <= 0n) return { kind: 'none' };
  let guess: bigint;
  if (input.side === 'sell') guess = floorToStep(available, lot);
  else {
    if (price === null || price <= 0n) return { kind: 'none' };
    const raw = divDown(available, price);
    guess = raw === null ? 0n : floorToStep(raw, lot);
  }
  if (guess <= 0n) return { kind: 'none' };

  // The first question is about half the size: a full-size guess reserves more than the account holds (the hold is at the
  // protection price, above the ask), and the service would only answer "not enough". Half learns the fee and the price.
  const half = floorToStep(guess / 2n, lot);
  const smallest = dec(input.smallest) ?? 0n;
  // Never below the smallest valid order (a balance near the minimum would otherwise be refused as "too small"), never above the guess.
  const probeSize = half > smallest ? half : smallest <= guess ? (smallest > 0n ? smallest : guess) : guess;
  const probe = await previewOrder(
    api,
    buildDraft({ symbol: input.symbol, side: input.side, base: str(probeSize) }, `max:${crypto.randomUUID()}`),
    {
      asset: input.spendAsset,
      available: input.available ?? undefined,
    },
  );
  if (probe.kind === 'refused') return { kind: 'refused', copy: probe.copy };
  if (probe.kind === 'failed') return { kind: 'none' };

  const feeBps = probe.preview.feeBps;
  const candidate = maxBase({
    side: input.side,
    available: input.available,
    holdPrice: probe.preview.protectionPrice,
    lot: input.lot,
    feeBps,
    feeAsset: probe.preview.feeAsset,
    spendAsset: input.spendAsset,
  });
  if (candidate === null) return { kind: 'none' };
  if (input.side === 'sell') return { kind: 'ok', base: candidate };

  // Confirm with the service that this size's reservation (and fee, if it is taken in the paying asset) fits.
  let size = dec(candidate)!;
  for (let attempt = 0; attempt < 2 && size > 0n; attempt += 1) {
    const check = await previewOrder(
      api,
      buildDraft({ symbol: input.symbol, side: 'buy', base: str(size) }, `max:${crypto.randomUUID()}`),
      {
        asset: input.spendAsset,
      },
    );
    if (check.kind === 'ok') {
      const hold = dec(check.preview.holdAmount) ?? available + 1n;
      const fee = check.preview.feeAsset === input.spendAsset ? (dec(check.preview.estimatedFee) ?? available) : 0n;
      if (hold + fee <= available) return { kind: 'ok', base: str(size) };
    } else if (check.kind === 'failed') return { kind: 'none' };
    // Refused (usually "not enough") or too big by a hair: one lot smaller, then ask again.
    size -= lot;
  }
  return { kind: 'none' };
}

/** The device note for an order or conversion left unresolved, kept in step with other tabs. */
export function usePendingNote(userId: string | null) {
  const [note, setNote] = useState(() => readPending(userId));
  useEffect(() => {
    const refresh = () => setNote(readPending(userId));
    refresh();
    window.addEventListener('storage', refresh);
    window.addEventListener('trade-pending-change', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('trade-pending-change', refresh);
    };
  }, [userId]);
  return note;
}
