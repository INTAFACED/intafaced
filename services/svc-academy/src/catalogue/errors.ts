/**
 * AC-catalogue-01 refusal codes.
 *
 * These stay beside the catalogue door. `errors.ts` and the router switch that
 * maps `AcademyError` are already changed by the open AC-videos-01 pull
 * request, so this slice does not edit them. The cause on the tRPC error is
 * still this class, and `cause.code` is the stable string.
 */
export const CATALOGUE_ERROR_CODES = [
  'academy.search_query_invalid',
  'academy.search_list_limit_unset',
  'academy.public_read_rate_unset',
  'academy.public_read_address_unset',
  'academy.public_read_rate_limited',
] as const;

export type CatalogueErrorCode = (typeof CATALOGUE_ERROR_CODES)[number];

export class CatalogueError extends Error {
  constructor(
    message: string,
    readonly code: CatalogueErrorCode,
  ) {
    super(message);
    this.name = 'CatalogueError';
  }
}
