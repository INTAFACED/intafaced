/**
 * The shape of svc-trade's builder-fee recon (services/svc-trade/src/venue/builder-fee-recon.ts), read strictly: a field
 * of the wrong type makes the whole answer invalid, never a guessed zero. Amounts stay decimal strings.
 */
export type BuilderFeeLineStatus = 'matched' | 'not_in_ledger' | 'not_reported_by_venue' | 'amounts_differ' | 'ledger_refused';

export interface BuilderFeeReconLine {
  readonly fillId: string;
  readonly userId: string | null;
  readonly assetId: string;
  readonly venueAmount: string | null;
  readonly ledgerAmount: string | null;
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

export type BuilderFeeReconVenue =
  | {
      readonly state: 'read';
      readonly venueId: string;
      readonly displayName: string;
      readonly test: boolean;
      readonly asOf: string;
      readonly matched: boolean;
      readonly totals: readonly BuilderFeeReconTotal[];
      readonly lines: readonly BuilderFeeReconLine[];
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
const STATUSES: readonly BuilderFeeLineStatus[] = ['matched', 'not_in_ledger', 'not_reported_by_venue', 'amounts_differ', 'ledger_refused'];
const rec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const dec = (v: unknown): v is string => typeof v === 'string' && DEC.test(v);
const decOrNull = (v: unknown): v is string | null => v === null || dec(v);
const strOrNull = (v: unknown): v is string | null => v === null || str(v);

function line(raw: unknown): BuilderFeeReconLine | null {
  if (!rec(raw) || !str(raw.fillId) || !strOrNull(raw.userId) || !str(raw.assetId) || !str(raw.filledAt)) return null;
  if (!decOrNull(raw.venueAmount) || !decOrNull(raw.ledgerAmount) || !strOrNull(raw.refusalCode)) return null;
  if (!STATUSES.includes(raw.status as BuilderFeeLineStatus)) return null;
  return {
    fillId: raw.fillId,
    userId: raw.userId,
    assetId: raw.assetId,
    venueAmount: raw.venueAmount,
    ledgerAmount: raw.ledgerAmount,
    filledAt: raw.filledAt,
    status: raw.status as BuilderFeeLineStatus,
    refusalCode: raw.refusalCode,
  };
}

function total(raw: unknown): BuilderFeeReconTotal | null {
  if (!rec(raw) || !str(raw.assetId) || !dec(raw.venueTotal) || !dec(raw.ledgerTotal) || typeof raw.matched !== 'boolean') return null;
  return { assetId: raw.assetId, venueTotal: raw.venueTotal, ledgerTotal: raw.ledgerTotal, matched: raw.matched };
}

function venue(raw: unknown): BuilderFeeReconVenue | null {
  if (!rec(raw)) return null;
  if (raw.state === 'unknown') {
    if (!strOrNull(raw.venueId) || !strOrNull(raw.displayName) || !str(raw.code) || typeof raw.message !== 'string') return null;
    return { state: 'unknown', venueId: raw.venueId, displayName: raw.displayName, code: raw.code, message: raw.message };
  }
  if (raw.state !== 'read' || !str(raw.venueId) || !str(raw.displayName) || typeof raw.test !== 'boolean' || !str(raw.asOf)) return null;
  if (typeof raw.matched !== 'boolean' || !Array.isArray(raw.totals) || !Array.isArray(raw.lines)) return null;
  const totals = raw.totals.map(total);
  const lines = raw.lines.map(line);
  if (totals.some((t) => t === null) || lines.some((l) => l === null)) return null;
  return {
    state: 'read',
    venueId: raw.venueId,
    displayName: raw.displayName,
    test: raw.test,
    asOf: raw.asOf,
    matched: raw.matched,
    totals: totals as BuilderFeeReconTotal[],
    lines: lines as BuilderFeeReconLine[],
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
  amounts_differ: 'Break: the venue and the ledger differ',
  ledger_refused: 'Break: the ledger refused this fee',
};

/** The period a page opens on: `from` and `to` as given when both are ISO times, else the last 7 days up to now. */
export function reconPeriod(from: unknown, to: unknown, now: Date): { from: string; to: string } {
  const ok = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /T/.test(v);
  if (ok(from) && ok(to)) return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  return { from: new Date(now.getTime() - 7 * 86_400_000).toISOString(), to: now.toISOString() };
}
