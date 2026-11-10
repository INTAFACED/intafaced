import { buildCsv } from '../merchants/csv';

/**
 * The shape of svc-trade's builder-fee recon (services/svc-trade/src/builder-fee/builder-fee-recon.ts), read strictly: a field
 * of the wrong type makes the whole answer invalid, never a guessed zero. Amounts stay decimal strings.
 */
export type BuilderFeeLineStatus =
  'matched' | 'not_in_ledger' | 'not_reported_by_venue' | 'amounts_differ' | 'ledger_refused' | 'ledger_missing' | 'not_our_order';

export interface BuilderFeeReconLine {
  readonly fillId: string;
  /** The venue account of the fill, as the ledger key names it: one fill id can be two of our accounts' sides. */
  readonly venueAccount: string;
  readonly userId: string | null;
  readonly assetId: string;
  readonly venueAmount: string | null;
  readonly ledgerAmount: string | null;
  readonly ledgerAssetId: string | null;
  readonly filledAt: string;
  readonly status: BuilderFeeLineStatus;
  readonly refusalCode: string | null;
}

export interface BuilderFeeReconTotal {
  readonly assetId: string;
  readonly venueTotal: string;
  readonly ledgerTotal: string;
  readonly matched: boolean;
}

export interface BuilderFeeOwed {
  readonly assetId: string;
  readonly amount: string;
  readonly state: 'owed' | 'overpaid';
}

export interface BuilderFeeVolumeRow {
  readonly assetId: string;
  readonly quoteAsset: string;
  readonly fills: number;
  readonly volume: string;
  readonly expectedFee: string;
  readonly chargedFee: string;
  readonly gap: string;
  readonly matched: boolean;
}

export type BuilderFeeVolumeGapReason = 'fee_differs' | 'not_a_routed_order' | 'fee_asset_unknown' | 'market_unknown';
const GAP_REASONS: readonly BuilderFeeVolumeGapReason[] = ['fee_differs', 'not_a_routed_order', 'fee_asset_unknown', 'market_unknown'];

export interface BuilderFeeVolumeGap {
  readonly fillId: string;
  readonly symbol: string;
  readonly assetId: string;
  readonly volume: string;
  readonly feeBps: string | null;
  readonly expectedFee: string | null;
  readonly chargedFee: string;
  readonly gap: string | null;
  readonly reason: BuilderFeeVolumeGapReason;
}

export interface BuilderFeeLedgerRecord {
  readonly ledgerTxId: string;
  readonly idempotencyKey: string;
  readonly fillId: string;
  readonly venueAccount: string;
  readonly userId: string | null;
  readonly assetId: string;
  readonly amount: string;
  readonly postedAt: string;
}

/** Where the builder-fee poster stopped: the venue, and the account and fill when it had reached one. */
export interface BuilderFeePosterStop {
  readonly venueId: string;
  readonly venueAccount: string | null;
  readonly fillId: string | null;
  readonly code: string;
  readonly message: string;
}

/** The builder-fee poster's runs on the venue (OWNER 288 change 1c). */
export interface BuilderFeePosterState {
  readonly lastCompleteAt: string | null;
  readonly lastStopAt: string | null;
  readonly lastStop: BuilderFeePosterStop | null;
}

export type BuilderFeeReconVenue =
  | {
      readonly state: 'read';
      readonly venueId: string;
      readonly displayName: string;
      readonly test: boolean;
      readonly asOf: string;
      /** No fill on either side is `nothing_to_compare`: never green (OWNER 288). */
      readonly result: 'matched' | 'break' | 'nothing_to_compare';
      readonly compared: number;
      readonly matched: boolean;
      readonly totals: readonly BuilderFeeReconTotal[];
      readonly lines: readonly BuilderFeeReconLine[];
      readonly owed: readonly BuilderFeeOwed[];
      readonly volume: readonly BuilderFeeVolumeRow[];
      readonly volumeGaps: readonly BuilderFeeVolumeGap[];
      readonly ledgerRecords: readonly BuilderFeeLedgerRecord[];
      readonly poster: BuilderFeePosterState;
    }
  | {
      readonly state: 'unknown';
      readonly venueId: string | null;
      readonly displayName: string | null;
      readonly code: string;
      readonly message: string;
    };

export interface BuilderFeeRecon {
  readonly from: string;
  readonly to: string;
  readonly periodOpen: boolean;
  readonly venues: readonly BuilderFeeReconVenue[];
}

const DEC = /^-?\d+(\.\d+)?$/;
const STATUSES: readonly BuilderFeeLineStatus[] = [
  'matched',
  'not_in_ledger',
  'not_reported_by_venue',
  'amounts_differ',
  'ledger_refused',
  'ledger_missing',
  'not_our_order',
];
const rec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const dec = (v: unknown): v is string => typeof v === 'string' && DEC.test(v);
const decOrNull = (v: unknown): v is string | null => v === null || dec(v);
const strOrNull = (v: unknown): v is string | null => v === null || str(v);

function line(raw: unknown): BuilderFeeReconLine | null {
  if (!rec(raw) || !str(raw.fillId) || !str(raw.venueAccount) || !strOrNull(raw.userId) || !str(raw.assetId) || !str(raw.filledAt))
    return null;
  if (!decOrNull(raw.venueAmount) || !decOrNull(raw.ledgerAmount) || !strOrNull(raw.ledgerAssetId) || !strOrNull(raw.refusalCode))
    return null;
  if (!STATUSES.includes(raw.status as BuilderFeeLineStatus)) return null;
  return {
    fillId: raw.fillId,
    venueAccount: raw.venueAccount,
    userId: raw.userId,
    assetId: raw.assetId,
    venueAmount: raw.venueAmount,
    ledgerAmount: raw.ledgerAmount,
    ledgerAssetId: raw.ledgerAssetId,
    filledAt: raw.filledAt,
    status: raw.status as BuilderFeeLineStatus,
    refusalCode: raw.refusalCode,
  };
}

function total(raw: unknown): BuilderFeeReconTotal | null {
  if (!rec(raw) || !str(raw.assetId) || !dec(raw.venueTotal) || !dec(raw.ledgerTotal) || typeof raw.matched !== 'boolean') return null;
  return { assetId: raw.assetId, venueTotal: raw.venueTotal, ledgerTotal: raw.ledgerTotal, matched: raw.matched };
}

function owed(raw: unknown): BuilderFeeOwed | null {
  if (!rec(raw) || !str(raw.assetId) || !dec(raw.amount) || (raw.state !== 'owed' && raw.state !== 'overpaid')) return null;
  return { assetId: raw.assetId, amount: raw.amount, state: raw.state };
}

function volumeRow(raw: unknown): BuilderFeeVolumeRow | null {
  if (!rec(raw) || !str(raw.assetId) || !str(raw.quoteAsset) || !Number.isSafeInteger(raw.fills) || (raw.fills as number) < 0) return null;
  if (!dec(raw.volume) || !dec(raw.expectedFee) || !dec(raw.chargedFee) || !dec(raw.gap) || typeof raw.matched !== 'boolean') return null;
  return {
    assetId: raw.assetId,
    quoteAsset: raw.quoteAsset,
    fills: raw.fills as number,
    volume: raw.volume,
    expectedFee: raw.expectedFee,
    chargedFee: raw.chargedFee,
    gap: raw.gap,
    matched: raw.matched,
  };
}

function volumeGap(raw: unknown): BuilderFeeVolumeGap | null {
  if (!rec(raw) || !str(raw.fillId) || !str(raw.symbol) || !str(raw.assetId) || !dec(raw.volume) || !decOrNull(raw.feeBps)) return null;
  if (!decOrNull(raw.expectedFee) || !dec(raw.chargedFee) || !decOrNull(raw.gap)) return null;
  if (!GAP_REASONS.includes(raw.reason as BuilderFeeVolumeGapReason)) return null;
  return {
    fillId: raw.fillId,
    symbol: raw.symbol,
    assetId: raw.assetId,
    volume: raw.volume,
    feeBps: raw.feeBps,
    expectedFee: raw.expectedFee,
    chargedFee: raw.chargedFee,
    gap: raw.gap,
    reason: raw.reason as BuilderFeeVolumeGapReason,
  };
}

function ledgerRecord(raw: unknown): BuilderFeeLedgerRecord | null {
  if (!rec(raw) || !str(raw.ledgerTxId) || !str(raw.idempotencyKey) || !str(raw.fillId) || !str(raw.venueAccount)) return null;
  if (!strOrNull(raw.userId)) return null;
  if (!str(raw.assetId) || !dec(raw.amount) || !str(raw.postedAt)) return null;
  return {
    ledgerTxId: raw.ledgerTxId,
    idempotencyKey: raw.idempotencyKey,
    fillId: raw.fillId,
    venueAccount: raw.venueAccount,
    userId: raw.userId,
    assetId: raw.assetId,
    amount: raw.amount,
    postedAt: raw.postedAt,
  };
}

const time = (v: unknown): v is string => str(v) && !Number.isNaN(Date.parse(v));
const timeOrNull = (v: unknown): v is string | null => v === null || time(v);

function posterStop(raw: unknown): BuilderFeePosterStop | null {
  if (!rec(raw) || !str(raw.venueId) || !strOrNull(raw.venueAccount) || !strOrNull(raw.fillId) || !str(raw.code)) return null;
  if (typeof raw.message !== 'string') return null;
  return { venueId: raw.venueId, venueAccount: raw.venueAccount, fillId: raw.fillId, code: raw.code, message: raw.message };
}

function posterState(raw: unknown): BuilderFeePosterState | null {
  if (!rec(raw) || !timeOrNull(raw.lastCompleteAt) || !timeOrNull(raw.lastStopAt)) return null;
  const lastStop = raw.lastStop === null ? null : posterStop(raw.lastStop);
  if (raw.lastStop !== null && lastStop === null) return null;
  return { lastCompleteAt: raw.lastCompleteAt, lastStopAt: raw.lastStopAt, lastStop };
}

/** Every item parsed, or null when any one is invalid. */
function all<T>(raw: unknown, parse: (v: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw)) return null;
  const out = raw.map(parse);
  return out.some((v) => v === null) ? null : (out as T[]);
}

function venue(raw: unknown): BuilderFeeReconVenue | null {
  if (!rec(raw)) return null;
  if (raw.state === 'unknown') {
    if (!strOrNull(raw.venueId) || !strOrNull(raw.displayName) || !str(raw.code) || typeof raw.message !== 'string') return null;
    return { state: 'unknown', venueId: raw.venueId, displayName: raw.displayName, code: raw.code, message: raw.message };
  }
  if (raw.state !== 'read' || !str(raw.venueId) || !str(raw.displayName) || typeof raw.test !== 'boolean' || !str(raw.asOf)) return null;
  if (typeof raw.matched !== 'boolean' || !Array.isArray(raw.totals) || !Array.isArray(raw.lines)) return null;
  if (raw.result !== 'matched' && raw.result !== 'break' && raw.result !== 'nothing_to_compare') return null;
  if (typeof raw.compared !== 'number' || !Number.isInteger(raw.compared) || raw.compared < 0) return null;
  // The three words must agree: a green that compared nothing, or a matched flag beside a break, is not shown.
  if (raw.matched !== (raw.result === 'matched') || (raw.result === 'nothing_to_compare') !== (raw.compared === 0)) return null;
  const totals = raw.totals.map(total);
  const lines = raw.lines.map(line);
  if (totals.some((t) => t === null) || lines.some((l) => l === null)) return null;
  const owedRows = all(raw.owed, owed);
  const volume = all(raw.volume, volumeRow);
  const volumeGaps = all(raw.volumeGaps, volumeGap);
  const ledgerRecords = all(raw.ledgerRecords, ledgerRecord);
  const poster = posterState(raw.poster);
  if (!owedRows || !volume || !volumeGaps || !ledgerRecords || !poster) return null;
  return {
    state: 'read',
    venueId: raw.venueId,
    displayName: raw.displayName,
    test: raw.test,
    asOf: raw.asOf,
    result: raw.result,
    compared: raw.compared,
    matched: raw.matched,
    totals: totals as BuilderFeeReconTotal[],
    lines: lines as BuilderFeeReconLine[],
    owed: owedRows,
    volume,
    volumeGaps,
    ledgerRecords,
    poster,
  };
}

export function parseBuilderFeeRecon(raw: unknown): BuilderFeeRecon | null {
  if (!rec(raw) || !str(raw.from) || !str(raw.to) || typeof raw.periodOpen !== 'boolean' || !Array.isArray(raw.venues)) return null;
  const venues = raw.venues.map(venue);
  if (venues.some((v) => v === null)) return null;
  return { from: raw.from, to: raw.to, periodOpen: raw.periodOpen, venues: venues as BuilderFeeReconVenue[] };
}

/** The words a finance operator reads for each line. */
export const LINE_WORDS: Readonly<Record<BuilderFeeLineStatus, string>> = {
  matched: 'Matched',
  not_in_ledger: 'Break: the venue reports this fee, the ledger has none',
  not_reported_by_venue: 'Break: the ledger has this fee, the venue does not report it',
  amounts_differ: 'Break: the venue and the ledger differ in amount or asset',
  ledger_refused: 'Break: the ledger refused this fee',
  ledger_missing: 'Break: recorded as posted, but the ledger has no such transaction',
  not_our_order: 'Not ours: the fill is of an order we did not send, so its builder fee is not posted',
};

/** How long ago `iso` was, from `now`, in whole minutes, hours or days: "4 minutes", "2 hours", "3 days". */
export function agoText(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000));
  const [n, unit] =
    minutes < 120 ? [minutes, 'minute'] : minutes < 48 * 60 ? [Math.floor(minutes / 60), 'hour'] : [Math.floor(minutes / 1440), 'day'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * The operations desk's line on the builder-fee poster (OWNER 288 change 1c): the time since its last complete run, and
 * a stop newer than that run with the venue, the account and the fill it stopped at.
 */
export function posterWords(poster: BuilderFeePosterState, now: Date): { readonly complete: string; readonly stop: string | null } {
  const complete =
    poster.lastCompleteAt === null
      ? 'The builder-fee poster has no complete run recorded.'
      : `The builder-fee poster last completed a run ${agoText(poster.lastCompleteAt, now)} ago, at ${poster.lastCompleteAt.slice(0, 10)} ${poster.lastCompleteAt.slice(11, 19)} UTC.`;
  const stopped =
    poster.lastStop !== null &&
    poster.lastStopAt !== null &&
    (poster.lastCompleteAt === null || Date.parse(poster.lastStopAt) > Date.parse(poster.lastCompleteAt));
  const s = poster.lastStop;
  const stop =
    stopped && s
      ? `Stopped ${agoText(poster.lastStopAt!, now)} ago (${s.code})` +
        (s.venueAccount ? ` at account ${s.venueAccount}` : '') +
        (s.fillId ? `, fill ${s.fillId}` : '') +
        '. Fees after it wait until a run completes.'
      : null;
  return { complete, stop };
}

/** The period a page opens on: `from` and `to` as given when both are ISO times, else the last 7 days up to now. */
export function reconPeriod(from: unknown, to: unknown, now: Date): { from: string; to: string } {
  const ok = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /T/.test(v);
  if (ok(from) && ok(to)) return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  return { from: new Date(now.getTime() - 7 * 86_400_000).toISOString(), to: now.toISOString() };
}

/** The words a finance operator reads for each routed-volume gap. */
export const GAP_WORDS: Readonly<Record<BuilderFeeVolumeGapReason, string>> = {
  fee_differs: 'Gap: the venue charged a builder fee other than the order rate on this volume',
  not_a_routed_order: 'Gap: the venue charged our builder fee on a fill of no order we routed',
  fee_asset_unknown: 'Gap: the venue charged the fee in an asset that is neither side of the market, so it cannot be checked',
  market_unknown: 'Gap: the venue does not list this market, so the fee cannot be checked',
};

const CSV_HEADER = ['ledger_tx_id', 'idempotency_key', 'venue_id', 'fill_id', 'user_id', 'asset', 'amount', 'posted_at'];

/**
 * The export for one venue and period (J-derivatives-17 #5): one row per ledger builder-fee transaction, as the ledger
 * holds it, with the generated-at and as-of lines every console export carries, and no cell a spreadsheet would run.
 */
export function builderFeeCsv(
  venueId: string,
  records: readonly BuilderFeeLedgerRecord[],
  generatedAt: string,
  asOf: string,
  period: { from: string; to: string },
): string {
  return buildCsv({
    header: CSV_HEADER,
    rows: records.map((r) => [r.ledgerTxId, r.idempotencyKey, venueId, r.fillId, r.userId ?? '', r.assetId, r.amount, r.postedAt]),
    generatedAt,
    asOf,
    note: `Builder fees the ledger records as earned on ${venueId}, fills from ${period.from} to ${period.to}`,
  });
}
