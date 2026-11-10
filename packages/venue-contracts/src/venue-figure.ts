import { formatAmount, type Amount } from '@intafaced/ledger-client/money';
import { heldFigure, heldFigureWire, type HeldFigure, type HeldFigureWire } from './held-figure.js';
import type { AsOf, UserVenueBalance, UserVenueDescriptor, UserVenuePosition } from './user-venue.js';

/**
 * THE VENUE SIDE OF THE DISPLAYED-FIGURE CONTRACT (b2 change 6). A person's money on a venue is the venue's: every figure
 * we show of it is one `HeldFigure`, made here from the venue's own read.
 *
 * - `source` is the venue's display name; `amount` is the venue's own figure as a decimal string, never re-rounded.
 * - `asOf` is the venue's own time for the read (`AsOf.reportedAt`). A read the venue sent with no time, or from an
 *   adapter that has not said, is `unknown` (`no_as_of`), never known at our read time.
 * - The staleness limit is the venue's own declaration (`UserVenueDescriptor.figureStaleAfterMs`). A venue that declares
 *   none throws: no limit is ever a silent default.
 */
export function venueFigure(
  venue: Pick<UserVenueDescriptor, 'displayName' | 'figureStaleAfterMs'>,
  amount: Amount,
  read: Pick<AsOf<unknown>, 'reportedAt'>,
  now: Date,
): HeldFigure {
  return heldFigure({
    source: venue.displayName,
    amount: formatAmount(amount),
    asOf: read.reportedAt ?? null,
    staleAfterMs: venue.figureStaleAfterMs ?? Number.NaN,
    now,
  });
}

/** Every figure of one balance the person sees, on the wire. */
export interface VenueBalanceFigures {
  readonly asset: string;
  readonly free: HeldFigureWire;
  readonly locked: HeldFigureWire;
  readonly total: HeldFigureWire;
}

/** Every figure of one position the person sees, on the wire. The liquidation price keeps its own `MaybeKnown`. */
export interface VenuePositionFigures {
  readonly symbol: string;
  readonly side: UserVenuePosition['side'];
  readonly size: HeldFigureWire;
  readonly entryPrice: HeldFigureWire;
  readonly markPrice: HeldFigureWire;
  readonly unrealisedPnl: HeldFigureWire;
  readonly margin: HeldFigureWire;
}

type Venue = Pick<UserVenueDescriptor, 'displayName' | 'figureStaleAfterMs'>;

export function venueBalanceFigures(venue: Venue, read: AsOf<readonly UserVenueBalance[]>, now: Date): VenueBalanceFigures[] {
  const f = (amount: Amount) => heldFigureWire(venueFigure(venue, amount, read, now));
  return read.value.map((b) => ({ asset: b.asset, free: f(b.free), locked: f(b.locked), total: f(b.total) }));
}

export function venuePositionFigures(venue: Venue, read: AsOf<readonly UserVenuePosition[]>, now: Date): VenuePositionFigures[] {
  const f = (amount: Amount) => heldFigureWire(venueFigure(venue, amount, read, now));
  return read.value.map((p) => ({
    symbol: p.symbol,
    side: p.side,
    size: f(p.size),
    entryPrice: f(p.entryPrice),
    markPrice: f(p.markPrice),
    unrealisedPnl: f(p.unrealisedPnl),
    margin: f(p.margin),
  }));
}
