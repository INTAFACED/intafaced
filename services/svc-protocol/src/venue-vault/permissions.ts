/**
 * S-L6 / §27 — connect keys must be trade-only.
 *
 * Withdrawal permission is refused at REGISTRATION, not filtered when a caller
 * later asks to trade. A key that can drain a user's external venue never
 * enters the vault.
 */

export type VenueKeyPermissions = {
  readonly scopes: readonly string[];
  /** Venue-native flags (Binance enableWithdraw, OKX perm.withdraw, …). */
  readonly flags?: Readonly<Record<string, boolean | string | number>>;
};

// `_` and `-` sit inside the token (`universal_transfer`, `funds_out`), same as the contiguous form.
const WITHDRAW_TOKEN =
  /withdraw|enablewithdraw|universal[-_]?transfer|internal[-_]?transfer|funds?.?out|wallet_withdraw|perm\.withdraw|canwithdraw/i;

export class WithdrawalPermissionRefusedError extends Error {
  readonly code = 'venue_vault.withdrawal_permission_refused' as const;
  constructor(detail: string) {
    super(`venue vault refused a key with withdrawal permission (${detail})`);
    this.name = 'WithdrawalPermissionRefusedError';
  }
}

export function withdrawalPermissionHits(permissions: VenueKeyPermissions): string[] {
  // A string is iterable. Refuse it before for...of yields characters.
  if (!Array.isArray(permissions.scopes)) {
    throw new WithdrawalPermissionRefusedError('scopes');
  }
  const hits: string[] = [];
  for (const scope of permissions.scopes) {
    if (WITHDRAW_TOKEN.test(scope)) hits.push(`scope:${scope}`);
  }
  for (const [key, value] of Object.entries(permissions.flags ?? {})) {
    const enabled =
      value === true ||
      (typeof value === 'number' && value !== 0) ||
      (typeof value === 'string' && value.toLowerCase() === 'true');
    if (enabled && WITHDRAW_TOKEN.test(key)) hits.push(`flag:${key}`);
    if (typeof value === 'string' && WITHDRAW_TOKEN.test(value)) hits.push(`flag:${key}=${value}`);
  }
  return hits;
}

/** Throw if this material could move funds off the venue. Call BEFORE encrypt. */
export function assertTradeOnly(permissions: VenueKeyPermissions): void {
  const hits = withdrawalPermissionHits(permissions);
  if (hits.length > 0) throw new WithdrawalPermissionRefusedError(hits.join(','));
}
