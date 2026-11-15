/**
 * The routing view's data (J-derivatives-28 #6): per venue, our users' routed volume and the builder fees the venue
 * charged on those fills in the period, and house exposure "none: routed". Every amount is a decimal string as svc-trade
 * sends it, shown as is. Plain data, safe in server and browser code.
 */

export interface AssetAmount {
  readonly asset: string;
  readonly amount: string;
}

export interface VenueRoutingRow {
  readonly venueId: string;
  readonly displayName: string | null;
  readonly test: boolean;
  readonly state: 'up' | 'down';
  readonly reason: string | null;
  readonly orders: number;
  readonly fills: number;
  readonly volume: readonly AssetAmount[];
  readonly builderFees: readonly AssetAmount[];
  readonly houseExposure: string;
  readonly asOf: string | null;
}

export interface VenueRoutingView {
  readonly from: string;
  readonly to: string;
  readonly venues: readonly VenueRoutingRow[];
  readonly totalsExclude: readonly string[];
  readonly volume: readonly AssetAmount[];
  readonly builderFees: readonly AssetAmount[];
  readonly houseExposure: string;
  readonly truncated: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const DECIMAL = /^-?\d+(\.\d+)?$/;

function amounts(v: unknown): AssetAmount[] | null {
  if (!Array.isArray(v)) return null;
  const out: AssetAmount[] = [];
  for (const x of v) {
    if (!isRecord(x) || typeof x.asset !== 'string' || typeof x.amount !== 'string' || !DECIMAL.test(x.amount)) return null;
    out.push({ asset: x.asset, amount: x.amount });
  }
  return out;
}

function row(v: unknown): VenueRoutingRow | null {
  if (!isRecord(v) || typeof v.venueId !== 'string' || (v.state !== 'up' && v.state !== 'down')) return null;
  const volume = amounts(v.volume);
  const builderFees = amounts(v.builderFees);
  if (!volume || !builderFees || typeof v.orders !== 'number' || typeof v.fills !== 'number' || typeof v.houseExposure !== 'string')
    return null;
  return {
    venueId: v.venueId,
    displayName: typeof v.displayName === 'string' ? v.displayName : null,
    test: v.test === true,
    state: v.state,
    reason: typeof v.reason === 'string' ? v.reason : null,
    orders: v.orders,
    fills: v.fills,
    volume,
    builderFees,
    houseExposure: v.houseExposure,
    asOf: typeof v.asOf === 'string' ? v.asOf : null,
  };
}

/** svc-trade's report, or null when it is not the shape we read (shown as a read problem, never as zeros). */
export function parseVenueRouting(raw: unknown): VenueRoutingView | null {
  if (!isRecord(raw) || !Array.isArray(raw.venues) || typeof raw.from !== 'string' || typeof raw.to !== 'string') return null;
  const venues = raw.venues.map(row);
  if (venues.some((r) => r === null)) return null;
  const volume = amounts(raw.volume);
  const builderFees = amounts(raw.builderFees);
  if (!volume || !builderFees || typeof raw.houseExposure !== 'string' || !Array.isArray(raw.totalsExclude)) return null;
  return {
    from: raw.from,
    to: raw.to,
    venues: venues as VenueRoutingRow[],
    totalsExclude: raw.totalsExclude.filter((x): x is string => typeof x === 'string'),
    volume,
    builderFees,
    houseExposure: raw.houseExposure,
    truncated: raw.truncated === true,
  };
}

const HOUR = 3_600_000;
/** The period picker: from and to as typed (ISO), or the last 24 hours; a malformed value falls back and says so. */
export function routingPeriod(
  q: { from?: string | string[]; to?: string | string[] },
  now = Date.now(),
): { from: string; to: string; fellBack: boolean } {
  const one = (x: string | string[] | undefined) => (Array.isArray(x) ? x[0] : x) ?? '';
  const from = new Date(one(q.from));
  const to = new Date(one(q.to));
  const given = one(q.from) !== '' || one(q.to) !== '';
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    return { from: new Date(now - 24 * HOUR).toISOString(), to: new Date(now + 60_000).toISOString(), fellBack: given };
  }
  return { from: from.toISOString(), to: to.toISOString(), fellBack: false };
}

export const amountsText = (list: readonly AssetAmount[]): string =>
  list.length === 0 ? 'none' : list.map((a) => `${a.amount} ${a.asset}`).join(', ');
