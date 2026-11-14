/**
 * Listing fee refusal codes (J-dex-protocol-24 #7, D-launch-listing-03) and their one plain sentence each.
 * No price is written here: the price is the owner's, and blank refuses.
 */
export const LISTING_REFUSAL_COPY = {
  'listing.price_unset': 'Listing price not set. Nothing was charged.',
  'listing.price_invalid': 'That listing price is not valid.',
  'listing.price_stale': 'The listing price changed since you read it. Read it again.',
  'listing.token_invalid': 'That is not a token address.',
  'listing.request_missing': 'Your request could not be read back. Press again to settle it; you are never charged twice.',
} as const;

export type ListingErrorCode = keyof typeof LISTING_REFUSAL_COPY;

export class ListingError extends Error {
  constructor(
    message: string,
    readonly code: ListingErrorCode,
  ) {
    super(message);
    this.name = 'ListingError';
  }
}

export function listingCopy(code: ListingErrorCode): string {
  return LISTING_REFUSAL_COPY[code];
}
