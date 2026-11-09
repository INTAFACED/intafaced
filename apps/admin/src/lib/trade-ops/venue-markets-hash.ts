import { createHash } from 'node:crypto';

/**
 * The approvals the venue markets desk needs (J-cex-spot-16), each bound to a hash of exactly what svc-trade will write.
 * svc-trade recomputes it when the change is applied (`admin.venueMarkets.*`, services/svc-trade/src/admin/venue-markets.ts)
 * and refuses an approval bound to anything else, so this is byte for byte the same canonical form: keys sorted, no
 * spaces, times as ISO in UTC with milliseconds, decimals with no trailing fraction zeros, and the version trimmed.
 *
 * The listing, routing and delisting share one version line per market (`venue-listing:<venueId>:<symbol>`); the
 * routed-order limits have their own (`venue-limits:<venueId>:<symbol>`). The expected version is the one the desk read
 * (`0` when there is none yet). The venue id is the one `admin.venueMarkets.list` names.
 */
export const VENUE_LISTING_SET_ACTION = 'trade.venue_listing_set';
export const VENUE_ROUTING_SET_ACTION = 'trade.venue_routing_set';
export const VENUE_LIMITS_SET_ACTION = 'trade.venue_limits_set';
export const VENUE_DELISTING_SCHEDULE_ACTION = 'trade.venue_delisting_schedule';
export const VENUE_MARKETS_TARGET_SERVICE = 'svc-trade';

export const venueListingTarget = (venueId: string, symbol: string) => `venue-listing:${venueId}:${symbol}`;
export const venueLimitsTarget = (venueId: string, symbol: string) => `venue-limits:${venueId}:${symbol}`;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}
const hash = (body: unknown) => `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}`;

/** A decimal in the one spelling svc-trade binds: `5.50` → `5.5`, `5.000` → `5`. */
export function canonicalVenueDecimal(value: string): string {
  const [whole, frac = ''] = value.trim().split('.');
  const f = frac.replace(/0+$/, '');
  return f === '' ? whole! : `${whole}.${f}`;
}

/** A time in the one form svc-trade binds (ISO, UTC, milliseconds). */
export const canonicalVenueTime = (value: string): string => new Date(value.trim()).toISOString();

interface Base {
  venueId: string;
  symbol: string;
  expectedVersion: string;
  reason: string;
}
const base = (b: Base) => ({ venueId: b.venueId, symbol: b.symbol, expectedVersion: b.expectedVersion.trim(), reason: b.reason.trim() });

export function venueListingPayloadHash(b: Base & { opensAt: string }): string {
  return hash({ actionType: VENUE_LISTING_SET_ACTION, ...base(b), opensAt: canonicalVenueTime(b.opensAt) });
}
export function venueRoutingPayloadHash(b: Base & { routing: 'show' | 'close_only' | 'stop' }): string {
  return hash({ actionType: VENUE_ROUTING_SET_ACTION, ...base(b), routing: b.routing });
}
export function venueLimitsPayloadHash(b: Base & { maxOrderQty: string; maxOrderNotional: string }): string {
  return hash({
    actionType: VENUE_LIMITS_SET_ACTION,
    ...base(b),
    maxOrderQty: canonicalVenueDecimal(b.maxOrderQty),
    maxOrderNotional: canonicalVenueDecimal(b.maxOrderNotional),
  });
}
export function venueDelistingPayloadHash(b: Base & { delistsAt: string }): string {
  return hash({ actionType: VENUE_DELISTING_SCHEDULE_ACTION, ...base(b), delistsAt: canonicalVenueTime(b.delistsAt) });
}
