/**
 * Account bind on API keys (M01 / M05-R06).
 *
 * A key is bound to one sub-account so it cannot act as another.
 * Empty account id refuses — never invent primary. Unbound (null) cannot
 * satisfy a named-account call.
 */
export class ApiKeyAccountError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'auth.account_required'
      | 'auth.account_mismatch'
      | 'auth.account_denied'
      | 'auth.account_revoked'
      | 'auth.not_found'
      | 'identity.portfolio_key_cap_unset'
      | 'identity.portfolio_key_cap_reached',
  ) {
    super(message);
    this.name = 'ApiKeyAccountError';
  }
}

export function requireAccountId(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    throw new ApiKeyAccountError('accountId is required', 'auth.account_required');
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiKeyAccountError('accountId is required', 'auth.account_required');
  }
  return value.trim();
}

/** Bound key + presented account must be the same non-empty id. */
export function apiKeyAccountAllowed(boundAccountId: string | null | undefined, presentedAccountId: string | null | undefined): boolean {
  const bound = typeof boundAccountId === 'string' ? boundAccountId.trim() : '';
  const presented = typeof presentedAccountId === 'string' ? presentedAccountId.trim() : '';
  if (!bound || !presented) return false;
  return bound === presented;
}
