import type { ActionResult } from '../../../features/trade/venue/VenueKit';
import type { VenueOrder, VenuePosition } from '../../../features/trade/venue-api';

/**
 * Flatten everything (J-derivatives-33): every open order cancelled and every position closed reduce-only from one hold,
 * one leg each, and "All clear" only from the venue's own read of the account afterwards.
 */

/** One leg's state on its line: sent to the venue, then done or failed as the venue answers; unknown is read back. */
export type LegState = 'waiting' | 'sent' | 'done' | 'failed' | 'unknown';

export type FlattenLeg =
  | {
      readonly kind: 'cancel';
      /** The order's own client id at the venue: the cancel names it on every try. */
      readonly id: string;
      readonly symbol: string;
      readonly order: VenueOrder;
      readonly state: LegState;
      readonly reason: string | null;
      /** How many times this cancel was sent: each try is its own action on the same order id. */
      readonly tries: number;
    }
  | {
      readonly kind: 'close';
      readonly id: string;
      readonly symbol: string;
      readonly position: VenuePosition;
      /** The close's client order key: the same on every try of this leg (J-derivatives-33 Money). */
      readonly clientOrderKey: string;
      /** The worst price the close takes: the owner's close tolerance from the mark. */
      readonly worst: string;
      readonly state: LegState;
      readonly reason: string | null;
      /** True when the venue's last answer was a definite refusal: a retry sends the same client order id again. */
      readonly refused: boolean;
    };

/** The cancels first (an order resting against a position never fills into the close), then one close per position. */
export function planLegs(
  orders: readonly VenueOrder[],
  positions: readonly VenuePosition[],
  close: (p: VenuePosition) => { clientOrderKey: string; worst: string },
): FlattenLeg[] {
  const cancels: FlattenLeg[] = orders
    .filter((o): o is VenueOrder & { venueClientOrderId: string } => o.venueClientOrderId !== null)
    .map((o) => ({
      kind: 'cancel',
      id: `cancel:${o.venueClientOrderId}`,
      symbol: o.symbol,
      order: o,
      state: 'waiting',
      reason: null,
      tries: 0,
    }));
  const closes: FlattenLeg[] = positions.map((p) => ({
    kind: 'close',
    id: `close:${p.symbol}:${p.side}`,
    symbol: p.symbol,
    position: p,
    ...close(p),
    state: 'waiting',
    reason: null,
    refused: false,
  }));
  return [...cancels, ...closes];
}

/** A leg's state from the venue's answer, with the venue's reason for a refusal. */
export function legAnswer(
  leg: FlattenLeg,
  result: ActionResult,
  words: { notFilled: (status: string) => string; other: (r: ActionResult) => string },
): { state: LegState; reason: string | null; refused: boolean } {
  if (result.kind === 'unknown') return { state: 'unknown', reason: null, refused: false };
  if (result.kind !== 'outcome') return { state: 'failed', reason: words.other(result), refused: false };
  const o = result.outcome;
  if (!o.accepted) return { state: 'failed', reason: o.refusal.detail, refused: true };
  if (leg.kind === 'cancel') {
    // A cancel signed as one of a batch: the venue answers the cancel itself as its one leg.
    const part = o.legs?.[0];
    if (part && !part.accepted) return { state: 'failed', reason: part.refusal.detail, refused: true };
    return { state: 'done', reason: null, refused: false };
  }
  const status = o.order?.status ?? null;
  if (status === 'filled') return { state: 'done', reason: null, refused: false };
  return { state: 'failed', reason: words.notFilled(status ?? 'not reported'), refused: false };
}

/** What the venue's read of the account says after the legs: clear only with no position and no open order. */
export type FlattenVerdict =
  | { readonly kind: 'running' }
  | { readonly kind: 'clear'; readonly readAt: string }
  | { readonly kind: 'not_clear'; readonly open: readonly string[]; readonly readAt: string | null; readonly readFailed: string | null };

export function verdictOf(
  read: { positions: readonly VenuePosition[]; orders: readonly VenueOrder[]; readAt: string } | { failed: string },
): FlattenVerdict {
  if ('failed' in read) return { kind: 'not_clear', open: [], readAt: null, readFailed: read.failed };
  const open = [...new Set([...read.positions.map((p) => p.symbol), ...read.orders.map((o) => o.symbol)])].sort();
  return open.length === 0 ? { kind: 'clear', readAt: read.readAt } : { kind: 'not_clear', open, readAt: read.readAt, readFailed: null };
}

/** The later of two venue read times (ISO), so "read at" is when the last of them was read. */
export const laterOf = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);
