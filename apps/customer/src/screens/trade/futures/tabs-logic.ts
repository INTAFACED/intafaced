/**
 * Pure logic for the five bottom tabs of the Futures desk: the history export, the funding countdown, the row picks.
 * No React and no clock reads: `now` is passed in.
 */
import type { Position } from '@intafaced/exchange-contract/schemas';
import { dec } from '../../../data/decimal';
import { fmtAmount } from '../../../data/format';
import { stateOf } from './model';

/** Columns of the history export, in the order they are drawn on screen. */
export const HISTORY_CSV_HEADER = ['Contract', 'Side', 'Size', 'Entry', 'Exit', 'Realised PnL', 'Fees', 'Status', 'Opened at'] as const;

/**
 * One CSV cell. A cell a spreadsheet would read as a formula (starts with = + - @, or a tab or carriage return) gets a
 * leading apostrophe so it opens as text (CSV injection). Cells with a comma, quote or line break are quoted.
 */
export function csvCell(value: string | null | undefined): string {
  let text = value ?? '';
  // A plain signed decimal (a PnL of -30) is a number, not a formula; everything else that starts like one is text.
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(cells: readonly (string | null | undefined)[]): string {
  return cells.map(csvCell).join(',');
}

/** The rows exactly as shown: exact decimal strings from the service, an empty cell where a figure is unknown. */
export function historyCsv(rows: readonly Position[]): string {
  const lines = rows.map((p) =>
    csvLine([p.symbol, p.side, p.contracts, p.entryPrice, p.markPrice, p.realizedPnl, p.fees, stateOf(p), p.datetime]),
  );
  return [csvLine(HISTORY_CSV_HEADER), ...lines].join('\r\n') + '\r\n';
}

/** Closed and liquidated positions, newest close first. Live rows never belong in history. */
export function historyRows(positions: readonly Position[]): Position[] {
  return positions
    .filter((p) => {
      const state = stateOf(p);
      return state === 'closed' || state === 'liquidated';
    })
    .sort((a, b) => b.timestamp - a.timestamp || (a.id ?? '').localeCompare(b.id ?? ''));
}

export function liquidatedRows(positions: readonly Position[]): Position[] {
  return historyRows(positions).filter((p) => stateOf(p) === 'liquidated');
}

/** "1h 02m 05s", "4m 09s", "12s"; null when the time is unknown, "now" once it has passed. */
export function countdownText(nextAt: number | null | undefined, now: number): string | null {
  if (nextAt === null || nextAt === undefined || !Number.isFinite(nextAt)) return null;
  const left = Math.max(0, Math.floor((nextAt - now) / 1000));
  if (left === 0) return 'now';
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  if (h > 0) return `${h}h ${two(m)}m ${two(s)}s`;
  if (m > 0) return `${m}m ${two(s)}s`;
  return `${s}s`;
}

/** Next funding time as epoch ms: the funding read wins, the ticker strip's ISO text is the fallback. */
export function nextFundingAt(fundingNext: number | null | undefined, stripNext: string | null | undefined): number | null {
  if (fundingNext !== null && fundingNext !== undefined) return fundingNext;
  if (!stripNext) return null;
  const parsed = Date.parse(stripNext);
  return Number.isFinite(parsed) ? parsed : null;
}

/** True when the margin-call read covers fewer live positions than the trader has (past the cap). */
export function pastCallCap(liveCount: number, cap: number): boolean {
  return liveCount > cap;
}

/** An amount with an explicit plus for gains ("+15", "−30"); "—" when unknown. Zero carries no sign. */
export function signedAmount(value: string | null | undefined, places = 4): string {
  const text = fmtAmount(value, { places });
  const n = dec(value);
  return n !== null && n > 0n ? `+${text}` : text;
}

/** "BTC/USDT:USDT", "BTC-USDT" and "btcusdt" name one contract when the letters and digits agree. */
export function sameContract(a: string | null | undefined, b: string | null | undefined): boolean {
  const key = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return key(a) !== '' && key(a) === key(b);
}

/** Whole bps as a percent string, by place value: 500 -> "5.00", 5 -> "0.05". */
export function percentOfBps(bps: number): string {
  const digits = String(bps).padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
