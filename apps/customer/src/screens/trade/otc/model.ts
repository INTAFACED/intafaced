/**
 * Quote desk logic with no React in it: where a quote is in its life, what may be done to it right now, how long it
 * is firm, what it really costs, what a status check proves, why the request button is off, and the CSV.
 * Money stays a decimal string (`rooms/math.ts`); an unreadable figure is null, never 0.
 */
import type { RfqQuote } from '../rooms/api';
import { compareDecimals, minus, positive, onStep } from '../rooms/math';

export type Side = 'buy' | 'sell';
/** `unknown` is a lifecycle word this screen does not know; it is shown as it is and nothing can be sent to it. */
export type Lifecycle = 'open' | 'bound' | 'settled' | 'expired' | 'unknown';
export type Action = 'accept' | 'settle' | 'expire' | 'check';
export type Operation = 'request' | 'accept' | 'settle' | 'expire';

/** The platform OTC fee is zero basis points (verified in the service code), so it is stated, not computed. */
export const FEE_BPS = '0';

export function lifecycleOf(quote: Pick<RfqQuote, 'lifecycle' | 'status'>): Lifecycle {
  const word = (quote.lifecycle ?? quote.status).trim().toLowerCase();
  if (word === 'open' || word === 'quoted' || word === 'active') return 'open';
  if (word === 'bound' || word === 'accepted') return 'bound';
  if (word === 'settled') return 'settled';
  if (word === 'expired') return 'expired';
  return 'unknown';
}

/** Epoch ms of a service timestamp, or null when it is not a date. */
export function atOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

export interface Countdown {
  /** `firm` = still inside its time by this device's clock; `past` = its time is up. */
  state: 'firm' | 'past' | 'unreadable';
  msLeft: number;
  /** "4:09" or "0:07"; "—" when unreadable. */
  text: string;
}

export function countdownOf(expiresAt: string, now: number): Countdown {
  const at = atOf(expiresAt);
  if (at === null) return { state: 'unreadable', msLeft: 0, text: '—' };
  const msLeft = at - now;
  if (msLeft <= 0) return { state: 'past', msLeft: 0, text: '0:00' };
  const seconds = Math.ceil(msLeft / 1000);
  return { state: 'firm', msLeft, text: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` };
}

/**
 * The quote as the person should treat it. `open-late` is open by the last answer but past its time by the clock:
 * the service may or may not know yet, so it must be re-read before anything is sent (no accept, no expire).
 */
export type Phase = 'open' | 'open-late' | 'bound' | 'settled' | 'expired' | 'unknown';

export function phaseOf(quote: Pick<RfqQuote, 'lifecycle' | 'status' | 'expiresAt'>, now: number): Phase {
  const life = lifecycleOf(quote);
  if (life !== 'open') return life;
  return countdownOf(quote.expiresAt, now).state === 'firm' ? 'open' : 'open-late';
}

/**
 * What the status chip says. `unconfirmed` = this device holds a note that a request on this very quote got no
 * verified answer, so "Open" would be a guess. `time-up` = open by the last answer but past its time by the clock.
 */
export type Chip = Lifecycle | 'unconfirmed' | 'time-up';

export function chipOf(
  quote: Pick<RfqQuote, 'quoteId' | 'lifecycle' | 'status' | 'expiresAt'>,
  now: number,
  pendingId: string | null,
): Chip {
  if (pendingId !== null && pendingId === quote.quoteId) return 'unconfirmed';
  const phase = phaseOf(quote, now);
  return phase === 'open-late' ? 'time-up' : phase;
}

/** What the buttons may do in each phase. `check` is always allowed: it only reads. */
export function allowedActions(phase: Phase): readonly Action[] {
  switch (phase) {
    case 'open':
      return ['accept', 'expire', 'check'];
    case 'bound':
      return ['settle', 'check'];
    default:
      return ['check'];
  }
}

export interface AllInCost {
  /** Value including the spread: what you pay (buy) or receive (sell), in the quote asset. */
  value: string | null;
  /** The mid-price value of the same size. */
  midValue: string | null;
  /** The spread cost: |value - mid value|, from the two returned values. */
  spreadCost: string | null;
  /** The service's own spread figure, shown beside the difference so any gap is visible. */
  spreadReturned: string | null;
  /** True only when both figures exist and agree exactly. */
  agrees: boolean;
  spreadBps: number;
  feeBps: typeof FEE_BPS;
  /** Buy pays the value; sell receives it. */
  direction: 'pay' | 'receive';
}

/** From the returned numbers only; nothing is estimated. */
export function costOf(quote: Pick<RfqQuote, 'side' | 'userNotional' | 'midNotional' | 'spreadNotional' | 'spreadBps'>): AllInCost {
  const buy = quote.side === 'buy';
  const spreadCost = buy ? minus(quote.userNotional, quote.midNotional) : minus(quote.midNotional, quote.userNotional);
  return {
    value: quote.userNotional,
    midValue: quote.midNotional,
    spreadCost,
    spreadReturned: quote.spreadNotional,
    agrees: spreadCost !== null && compareDecimals(spreadCost, quote.spreadNotional) === 0,
    spreadBps: quote.spreadBps,
    feeBps: FEE_BPS,
    direction: buy ? 'pay' : 'receive',
  };
}

/** The shape the service has to return for the quote we asked about: same id, or it is somebody else's answer. */
export function sameQuote(asked: string, answer: Pick<RfqQuote, 'quoteId'>): boolean {
  return answer.quoteId === asked;
}

export type Verdict = 'done' | 'not-done' | 'unresolved';

/**
 * What a status check proves about a request whose answer was lost. Only `done` and `not-done` release the device
 * note; `unresolved` keeps it locked (the request may still land).
 */
export function verdictOf(operation: Operation, life: Lifecycle): Verdict {
  switch (operation) {
    case 'accept':
      return life === 'bound' || life === 'settled' ? 'done' : life === 'expired' ? 'not-done' : 'unresolved';
    case 'settle':
      return life === 'settled' ? 'done' : 'unresolved';
    case 'expire':
      return life === 'expired' ? 'done' : life === 'bound' || life === 'settled' ? 'not-done' : 'unresolved';
    case 'request':
      return 'unresolved';
  }
}

/** The device note names the operation in its `symbol` field ("accept:BTC/USDT"), the only free text it keeps. */
export const noteSymbol = (operation: Operation, pair: string): string => `${operation}:${pair}`;
export function operationOf(symbol: string): Operation | null {
  const head = symbol.split(':')[0];
  return head === 'request' || head === 'accept' || head === 'settle' || head === 'expire' ? head : null;
}

export type DeskState = 'loading' | 'unreadable' | 'closed' | 'open';
export type RequestBlock =
  'signed-out' | 'desk-loading' | 'desk-unreadable' | 'desk-closed' | 'no-pair' | 'bad-size' | 'off-lot' | 'locked' | 'busy';

export interface RequestDraft {
  signedIn: boolean;
  desk: DeskState;
  pair: string;
  qty: string;
  /** Smallest size step of the pair, when known. */
  lot: string | null;
  /** An earlier request is still unconfirmed on this device. */
  locked: boolean;
  busy: boolean;
}

/** The one reason the Request button is off, or null. Order is the order a person would fix them in. */
export function requestBlock(draft: RequestDraft): RequestBlock | null {
  if (!draft.signedIn) return 'signed-out';
  if (draft.desk === 'loading') return 'desk-loading';
  if (draft.desk === 'unreadable') return 'desk-unreadable';
  if (draft.desk === 'closed') return 'desk-closed';
  if (draft.locked) return 'locked';
  if (!draft.pair) return 'no-pair';
  if (positive(draft.qty) === null) return 'bad-size';
  if (draft.lot && !onStep(draft.qty, draft.lot)) return 'off-lot';
  if (draft.busy) return 'busy';
  return null;
}

export const CSV_COLUMNS = [
  'quoteId',
  'lifecycle',
  'side',
  'baseAsset',
  'quoteAsset',
  'qty',
  'quotedPrice',
  'midPrice',
  'valueIncludingSpread',
  'midValue',
  'spreadBps',
  'counterparty',
  'counterpartyId',
  'createdAt',
  'expiresAt',
  'acceptedAt',
  'fillPrice',
  'readAt',
] as const;

/** A cell that starts with one of these is read as a formula by spreadsheets; a leading apostrophe makes it text. */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | null | undefined, text = false): string {
  if (value === null || value === undefined) return '';
  const safe = text && FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export interface ReadQuote {
  quote: RfqQuote;
  /** Epoch ms of the read that produced it. */
  readAt: number;
}

/** One line per quote this browser has read, header first, CRLF line ends. Amounts are the service's own strings. */
export function buildCsv(rows: readonly ReadQuote[]): string {
  const lines = rows.map(({ quote: q, readAt }) =>
    [
      csvCell(q.quoteId, true),
      lifecycleOf(q),
      q.side,
      csvCell(q.baseAsset, true),
      csvCell(q.quoteAsset, true),
      q.qty,
      q.quotedPrice,
      q.midPrice,
      q.userNotional,
      q.midNotional,
      String(q.spreadBps),
      csvCell(q.counterparty, true),
      csvCell(q.counterpartyId, true),
      csvCell(q.createdAt, true),
      csvCell(q.expiresAt, true),
      csvCell(q.acceptedAt, true),
      csvCell(q.fillPrice),
      new Date(readAt).toISOString(),
    ].join(','),
  );
  return [CSV_COLUMNS.join(','), ...lines].join('\r\n') + '\r\n';
}

export const csvFileName = (at: number): string => `quotes-read-${new Date(at).toISOString().slice(0, 10)}.csv`;
