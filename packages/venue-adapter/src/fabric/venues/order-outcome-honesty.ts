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
export function throwVenueTransportFailure(venueId: string, method: string, path: string, error: unknown, sent = false): never {
  if (isTimeoutOrAbort(error)) {
    throw new VenueUnavailableError(venueId, 'unreachable', `${method} ${path} timed out — outcome unknown, not a fill`, sent);
  }
  throw new VenueUnavailableError(venueId, 'unreachable', `${method} ${path} failed: ${String(error)}`, sent);
}

/** Retag a failure with whether the place POST had already been dispatched. */
export function rethrowWithSent(error: unknown, sent: boolean): never {
  if (error instanceof VenueUnavailableError) {
    throw new VenueUnavailableError(error.venueId, error.reason, error.message, sent);
  }
  throw error;
}

export function assertKnownOrderStatus<S extends VenueOrder['status']>(
  venueId: string,
  status: S | undefined,
  raw: string,
  label: string,
  sent = false,
): asserts status is S {
  if (!status) {
    throw new VenueUnavailableError(venueId, 'malformed', `${label} ${raw || '(empty)'} is unknown — outcome unknown, not a fill`, sent);
  }
}

/**
 * A venue saying "filled" without executed size + average price is missing the
 * fill report. Partial with zero size is the same hole.
 */
export function assertFillReportMatchesStatus(
  venueId: string,
  status: VenueOrder['status'],
  filled: bigint,
  averagePrice: VenueOrder['averagePrice'],
  sent = false,
): void {
  if (status === 'partially_filled' && (filled <= 0n || averagePrice === null || averagePrice <= 0n)) {
    throw new VenueUnavailableError(venueId, 'malformed', 'partially_filled without a fill report — outcome unknown, not a fill', sent);
  }
  if (status === 'filled' && (filled <= 0n || averagePrice === null || averagePrice <= 0n)) {
    throw new VenueUnavailableError(venueId, 'malformed', 'filled status without a fill report — outcome unknown, not a fill', sent);
  }
}
