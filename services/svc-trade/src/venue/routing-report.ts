import { add, mul, ZERO, type Amount } from '@intafaced/ledger-client/money';
import { VenueRefusalError, isTestVenue } from '@intafaced/venue-contracts';
import type { PreparedActionStore } from './prepared-action-store.js';
import type { UserVenueDoor } from './user-venue-door.js';

/**
 * THE OPERATOR'S ROUTING VIEW (J-derivatives-28 #6; spec D-venue-05): our users' routed volume and builder fees by venue,
 * and house exposure "none: routed".
 *
 * What we routed is our own record (the door's signed order actions). Every figure of what came of it is the venue's:
 * the fills the venue reports for those orders' client ids in the period, their notional at the fill price and the
 * builder fee the venue charged on each. We hold no position, so house exposure is the literal `none: routed`, never a
 * figure computed from a book of our own. A venue that can't be read is a down row with its reason, and the totals say
 * they leave it out. Nothing here posts or moves money.
 */

export const HOUSE_EXPOSURE_ROUTED = 'none: routed' as const;
/** The most routed orders one report reads (newest first); a report that reached it says so. */
export const ROUTED_ORDERS_LIMIT = 5_000;

export interface AssetTotal {
  readonly asset: string;
  readonly amount: Amount;
}

export interface VenueRoutingRow {
  readonly venueId: string;
  readonly displayName: string | null;
  readonly test: boolean;
  readonly state: 'up' | 'down';
  readonly reason: string | null;
  /** Orders we routed to this venue that filled in the period (by the venue's fills). */
  readonly orders: number;
  readonly fills: number;
  /** Fill notional by quote asset (price × amount, as the venue reports each fill). */
  readonly volume: readonly AssetTotal[];
  /** Our builder fee the venue charged on those fills, by fee asset. */
  readonly builderFees: readonly AssetTotal[];
  readonly houseExposure: typeof HOUSE_EXPOSURE_ROUTED;
  readonly asOf: Date | null;
}

export interface VenueRoutingReport {
  readonly from: Date;
  readonly to: Date;
  readonly venues: readonly VenueRoutingRow[];
  /** Venue ids left out of the totals because they could not be read. */
  readonly totalsExclude: readonly string[];
  readonly volume: readonly AssetTotal[];
  readonly builderFees: readonly AssetTotal[];
  readonly houseExposure: typeof HOUSE_EXPOSURE_ROUTED;
  /** True when the routed-order read reached its limit, so older orders' fills may be missing. */
  readonly truncated: boolean;
}

export class VenueRoutingReportError extends Error {
  constructor(
    message: string,
    readonly code: 'trade.venue_routing_period_invalid' | 'trade.user_venue_off',
  ) {
    super(message);
    this.name = 'VenueRoutingReportError';
  }
}

function addTo(map: Map<string, Amount>, asset: string, amount: Amount): void {
  map.set(asset, add(map.get(asset) ?? ZERO, amount));
}
const totals = (map: Map<string, Amount>): AssetTotal[] =>
  [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([asset, amount]) => ({ asset, amount }));

export interface RoutingReportDeps {
  readonly doors: readonly UserVenueDoor[];
  readonly store: PreparedActionStore;
}

export async function routingReport(deps: RoutingReportDeps, from: Date, to: Date): Promise<VenueRoutingReport> {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw new VenueRoutingReportError('the period needs a from before its to', 'trade.venue_routing_period_invalid');
  }
  if (deps.doors.length === 0) throw new VenueRoutingReportError('the user-venue door is off on this deployment', 'trade.user_venue_off');
  const routed = await deps.store.routedOrders(to, ROUTED_ORDERS_LIMIT);
  const byVenue = new Map<string, Map<string, { owner: string; subAccount: string | null; ids: Set<string> }>>();
  for (const o of routed) {
    const accounts = byVenue.get(o.venueId) ?? new Map();
    byVenue.set(o.venueId, accounts);
    const k = `${o.owner}/${o.subAccount ?? ''}`;
    const a = accounts.get(k) ?? { owner: o.owner, subAccount: o.subAccount, ids: new Set<string>() };
    a.ids.add(o.venueClientOrderId);
    accounts.set(k, a);
  }

  const rows: VenueRoutingRow[] = [];
  const allVolume = new Map<string, Amount>();
  const allFees = new Map<string, Amount>();
  const totalsExclude: string[] = [];
  for (const door of deps.doors) {
    let venue;
    try {
      venue = await door.venue();
    } catch (err) {
      const id = door.connectedVenueId ?? 'unreachable';
      totalsExclude.push(id);
      rows.push(down(id, null, err));
      continue;
    }
    const id = venue.venue.id;
    try {
      const quoteOf = new Map((await venue.markets(null)).value.map((m) => [m.symbol, m.quoteAsset] as const));
      const volume = new Map<string, Amount>();
      const fees = new Map<string, Amount>();
      const filledOrders = new Set<string>();
      let fills = 0;
      let asOf: Date | null = null;
      for (const acct of byVenue.get(id)?.values() ?? []) {
        const read = await venue.fills({ venueId: id, owner: acct.owner, subAccount: acct.subAccount }, from);
        asOf = read.asOf;
        for (const f of read.value) {
          if (!f.venueClientOrderId || !acct.ids.has(f.venueClientOrderId) || f.filledAt < from || f.filledAt >= to) continue;
          fills += 1;
          filledOrders.add(f.venueClientOrderId);
          addTo(volume, quoteOf.get(f.symbol) ?? f.feeAsset, mul(f.price, f.amount));
          if (f.builderFee > ZERO) addTo(fees, f.feeAsset, f.builderFee);
        }
      }
      for (const [k, v] of volume) addTo(allVolume, k, v);
      for (const [k, v] of fees) addTo(allFees, k, v);
      rows.push({
        venueId: id,
        displayName: venue.venue.displayName,
        test: isTestVenue(venue.venue),
        state: 'up',
        reason: null,
        orders: filledOrders.size,
        fills,
        volume: totals(volume),
        builderFees: totals(fees),
        houseExposure: HOUSE_EXPOSURE_ROUTED,
        asOf,
      });
    } catch (err) {
      if (!(err instanceof VenueRefusalError && err.refusal.code === 'venue_down')) throw err;
      totalsExclude.push(id);
      rows.push(down(id, venue.venue.displayName, err, isTestVenue(venue.venue)));
    }
  }
  return {
    from,
    to,
    venues: rows,
    totalsExclude,
    volume: totals(allVolume),
    builderFees: totals(allFees),
    houseExposure: HOUSE_EXPOSURE_ROUTED,
    truncated: routed.length >= ROUTED_ORDERS_LIMIT,
  };
}

function down(venueId: string, displayName: string | null, err: unknown, test = true): VenueRoutingRow {
  return {
    venueId,
    displayName,
    test,
    state: 'down',
    reason: err instanceof VenueRefusalError ? err.refusal.detail : (err as Error).message,
    orders: 0,
    fills: 0,
    volume: [],
    builderFees: [],
    houseExposure: HOUSE_EXPOSURE_ROUTED,
    asOf: null,
  };
}
