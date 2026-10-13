import { VenueUnavailableError, type VenueCredentials } from '@intafaced/venue-contracts';

/** Refuse wiring a valid key into the wrong venue adapter before any signed call can leave the process. */
export function assertCredentialVenue(expectedVenueId: string, credentials: VenueCredentials): void {
  if (credentials.venueId.trim().toLowerCase() !== expectedVenueId) {
    throw new VenueUnavailableError(
      expectedVenueId,
      'malformed',
      `credential venue ${credentials.venueId || '(empty)'} does not match ${expectedVenueId}`,
    );
  }
}
