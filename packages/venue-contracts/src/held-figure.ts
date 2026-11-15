/**
 * THE DISPLAYED-FIGURE CONTRACT: one type for every figure we show a person that another holder reports.
 *
 * A person's money sits with someone else: a venue, a partner bank, a card partner. Every figure we show of it is that
 * holder's, read at some time. So every such figure is one `HeldFigure`:
 *
 *   - `amount`: the source's own decimal string, never a `number` and never re-rounded by us.
 *   - `source`: whose figure it is, as the person sees it named (e.g. "TEST partner bank").
 *   - `asOf`: the source's own time for the figure. Never our read time: a figure the source sent without a time is
 *     `unknown` (`no_as_of`), because we cannot say how old it is.
 *   - `state`:
 *       `known`   the source reported it, with its time, no older than the source's declared limit;
 *       `stale`   the source reported it, but longer ago than its limit: shown, and said to be old;
 *       `unknown` with a reason: the source has not reported it (`not_reported`), sent no time (`no_as_of`), is not
 *                 answering and we hold no earlier figure (`source_unavailable`), sent a time further ahead of our clock
 *                 than its own limit (`as_of_ahead`), or sent an amount that is not a decimal (`malformed`).
 *                 Unknown is never zero.
 *   - `staleAfterMs`: each source declares how old its figure may be before it is stale. A source that declares none
 *     is a programming error and throws, so no limit is ever a silent default.
 *
 * `heldFigure` is the only way to make one, so the rules above hold for every source.
 */

export const FIGURE_STATES = ['known', 'stale', 'unknown'] as const;
export type FigureState = (typeof FIGURE_STATES)[number];

export const UNKNOWN_FIGURE_REASONS = ['not_reported', 'no_as_of', 'source_unavailable', 'as_of_ahead', 'malformed'] as const;
export type UnknownFigureReason = (typeof UNKNOWN_FIGURE_REASONS)[number];

export type HeldFigure =
  | {
      readonly state: 'known' | 'stale';
      readonly source: string;
      readonly amount: string;
      readonly asOf: Date;
      readonly staleAfterMs: number;
    }
  | {
      readonly state: 'unknown';
      readonly source: string;
      readonly amount: null;
      /** The source's time when it sent one; null when it sent none. */
      readonly asOf: Date | null;
      readonly staleAfterMs: number;
      readonly reason: UnknownFigureReason;
    };

/** A figure on the wire: the same fields, with `asOf` as an ISO string. */
export type HeldFigureWire =
  | {
      readonly state: 'known' | 'stale';
      readonly source: string;
      readonly amount: string;
      readonly asOf: string;
      readonly staleAfterMs: number;
      readonly reason: null;
    }
  | {
      readonly state: 'unknown';
      readonly source: string;
      readonly amount: null;
      readonly asOf: string | null;
      readonly staleAfterMs: number;
      readonly reason: UnknownFigureReason;
    };

/** A signed decimal, at most 18 places: the same rule as the venue wire (`decimal.ts`). */
const DECIMAL = /^-?\d+(\.\d{1,18})?$/;

export interface HeldFigureRead {
  readonly source: string;
  /** The source's own decimal string, or null when it has not reported one. */
  readonly amount: string | null;
  /** The source's own time for the figure, or null when it sent none. */
  readonly asOf: Date | null;
  /** The source's declared limit, in milliseconds: a positive whole number. */
  readonly staleAfterMs: number;
  /** Our clock when we read it. */
  readonly now: Date;
  /** True when the source is not answering: with no amount, the figure is `source_unavailable`. */
  readonly unavailable?: boolean;
}

export function heldFigure(read: HeldFigureRead): HeldFigure {
  const { source, amount, asOf, staleAfterMs, now } = read;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) {
    throw new TypeError(`${source} declares no staleness limit (staleAfterMs ${String(staleAfterMs)}): every source must declare one`);
  }
  if (asOf !== null && Number.isNaN(asOf.getTime())) {
    throw new TypeError(`${source} sent an as-of time that is not a time`);
  }
  const unknown = (reason: UnknownFigureReason): HeldFigure =>
    Object.freeze({ state: 'unknown', source, amount: null, asOf, staleAfterMs, reason });
  if (amount === null) return unknown(read.unavailable ? 'source_unavailable' : 'not_reported');
  if (!DECIMAL.test(amount)) return unknown('malformed');
  if (asOf === null) return unknown('no_as_of');
  const age = now.getTime() - asOf.getTime();
  if (age < -staleAfterMs) return unknown('as_of_ahead');
  return Object.freeze({ state: age > staleAfterMs ? 'stale' : 'known', source, amount, asOf, staleAfterMs });
}

/** A figure the source reported with its time: known or stale. */
export type ReportedFigure = Extract<HeldFigure, { readonly state: 'known' | 'stale' }>;
export type ReportedFigureWire = Extract<HeldFigureWire, { readonly state: 'known' | 'stale' }>;

export function heldFigureWire(figure: ReportedFigure): ReportedFigureWire;
export function heldFigureWire(figure: HeldFigure): HeldFigureWire;
export function heldFigureWire(figure: HeldFigure): HeldFigureWire {
  if (figure.state === 'unknown') {
    return {
      state: 'unknown',
      source: figure.source,
      amount: null,
      asOf: figure.asOf ? figure.asOf.toISOString() : null,
      staleAfterMs: figure.staleAfterMs,
      reason: figure.reason,
    };
  }
  return {
    state: figure.state,
    source: figure.source,
    amount: figure.amount,
    asOf: figure.asOf.toISOString(),
    staleAfterMs: figure.staleAfterMs,
    reason: null,
  };
}
