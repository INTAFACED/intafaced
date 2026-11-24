import { useMemo } from 'react';
import { useResource } from '../../../shared/resource';
import type { VenueOrder } from '../../../features/trade/venue-api';
import { useVenueApi } from '../../../features/trade/venue/VenueKit';

// The venue spot desk's read-backs of orders that left the venue's open orders, by client id (J-cex-spot-01 #8).

/**
 * The orders behind the venue's fills, and those this page placed, that have left the venue's open orders and not been
 * cancelled here, read back by client id: the ones the venue reads as filled stay listed, Filled (J-cex-spot-01 #8). The
 * latest 20 are read.
 */
export function useFilledOrders(
  owner: string | null,
  placed: string[],
  open: VenueOrder[] | null,
  cancelled: Array<{ key: string; clientOrderId: string }>,
): VenueOrder[] {
  const venue = useVenueApi();
  const gone = open
    ? placed.filter((id) => !open.some((o) => o.venueClientOrderId === id) && !cancelled.some((c) => c.clientOrderId === id)).slice(-20)
    : [];
  const ids = gone.join(',');
  const read = useResource(async (signal) => {
    if (!owner || gone.length === 0) return { ok: true as const, data: [] as VenueOrder[] };
    const rows: VenueOrder[] = [];
    for (const id of gone) {
      const r = await venue.orderByClientId(owner, id, signal);
      if (r.ok && r.data.value?.status === 'filled') rows.push(r.data.value);
    }
    return { ok: true as const, data: rows };
  }, `filled:${owner}:${ids}`);
  return useMemo(() => (read.resource.status === 'ready' ? read.resource.data : []), [read.resource]);
}

/** The orders this page cancelled, read back from the venue by their client ids, so they stay listed with their status. */
export function useCancelledOrders(owner: string | null, cancelled: Array<{ key: string; clientOrderId: string }>): VenueOrder[] {
  const venue = useVenueApi();
  const ids = cancelled.map((c) => c.clientOrderId).join(',');
  const read = useResource(async (signal) => {
    if (!owner || cancelled.length === 0) return { ok: true as const, data: [] as VenueOrder[] };
    const rows: VenueOrder[] = [];
    for (const c of cancelled) {
      const r = await venue.orderByClientId(owner, c.clientOrderId, signal);
      if (r.ok && r.data.value) rows.push(r.data.value);
    }
    return { ok: true as const, data: rows };
  }, `cancelled:${owner}:${ids}`);
  return useMemo(() => (read.resource.status === 'ready' ? read.resource.data : []), [read.resource]);
}
