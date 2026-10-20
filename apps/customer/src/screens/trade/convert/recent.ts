/**
 * Recent conversions panel (TRMKT R3). Reads `convert.list`, the service's own record of the customer's convert quotes,
 * so a conversion is never guessed from Activity (where it looks like a zero-fee spot order).
 *
 * The service wants a window and a limit on every read. Both are display choices made here: the last 30 days (the
 * service allows 92 at most) and the newest 10 conversions that were actually taken up.
 */
import type { ConvertHistoryRow } from '../../../features/trade/tool-api';

export const RECENT_WINDOW_DAYS = 30;
/** Quotes fetched per read: most stored quotes are never taken up, so the list asks for more than it shows. */
export const RECENT_FETCH = 100;
export const RECENT_SHOWN = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

export function recentWindow(now: number): { from: string; to: string; limit: number } {
  return { from: new Date(now - RECENT_WINDOW_DAYS * DAY_MS).toISOString(), to: new Date(now).toISOString(), limit: RECENT_FETCH };
}

/**
 * A quote the customer never took up (`quoted`, `expired`) is not a conversion. `refused`, `accepted` and `unknown` stay
 * listed so a conversion that did not finish is never hidden.
 */
export function recentRows(rows: readonly ConvertHistoryRow[]): ConvertHistoryRow[] {
  return rows.filter((row) => row.lifecycle !== 'quoted' && row.lifecycle !== 'expired').slice(0, RECENT_SHOWN);
}

/** The time a row happened: when it settled, else when it was accepted, else when it was quoted. */
export function recentAt(row: Pick<ConvertHistoryRow, 'settledAt' | 'acceptedAt' | 'createdAt'>): string {
  return row.settledAt ?? row.acceptedAt ?? row.createdAt;
}
