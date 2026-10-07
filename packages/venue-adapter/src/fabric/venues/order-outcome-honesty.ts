import { VenueUnavailableError, type VenueOrder } from '@intafaced/venue-contracts';

/**
 * PTX-M22-R01 / R07 — timeout, unknown status, and missing fill reports stay
 * unknown. They must never normalize into a filled order.
 */

export function isTimeoutOrAbort(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  const name = typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : '';
  const message = error instanceof Error ? error.message : String(error);
  return name === 'TimeoutError' || name === 'AbortError' || /timed?\s*out|aborted/i.test(message);
}

/** Transport failure after dispatch is outcome-unknown — never a fill or a reject. */
export function throwVenueTransportFailure(venueId: string, method: string, path: string, error: unknown): never {
  if (isTimeoutOrAbort(error)) {
    throw new VenueUnavailableError(venueId, 'unreachable', `${method} ${path} timed out — outcome unknown, not a fill`);
  }
  throw new VenueUnavailableError(venueId, 'unreachable', `${method} ${path} failed: ${String(error)}`);
}

export function assertKnownOrderStatus<S extends VenueOrder['status']>(
  venueId: string,
  status: S | undefined,
  raw: string,
  label: string,
): asserts status is S {
  if (!status) {
    throw new VenueUnavailableError(venueId, 'malformed', `${label} ${raw || '(empty)'} is unknown — outcome unknown, not a fill`);
  }
}

/** Null, or a non-positive scaled amount. Zero is not an execution price. */
function blankAveragePrice(averagePrice: VenueOrder['averagePrice']): boolean {
  return averagePrice === null || averagePrice <= 0n;
}

/**
 * A venue saying "filled" without executed size and an average price is missing
 * the fill report. A partial with zero size is the same hole, and so is a sized
 * partial whose average price is null or zero. Never invent a price, including 0.
 */
export function assertFillReportMatchesStatus(
  venueId: string,
  status: VenueOrder['status'],
  filled: bigint,
  averagePrice: VenueOrder['averagePrice'],
): void {
  if (status === 'partially_filled' && (filled <= 0n || blankAveragePrice(averagePrice))) {
    throw new VenueUnavailableError(venueId, 'malformed', 'partially_filled without a fill report — outcome unknown, not a fill');
  }
  if (status === 'filled' && (filled <= 0n || blankAveragePrice(averagePrice))) {
    throw new VenueUnavailableError(venueId, 'malformed', 'filled status without a fill report — outcome unknown, not a fill');
  }
}
