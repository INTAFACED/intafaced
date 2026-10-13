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

/**
 * One rule for scope names and flag names. Case folds, and `_`, `-` and spaces
 * fold away, so `universal_transfer`, `Universal-Transfer` and `internal transfer`
 * each normalise to a single token. A name moves funds when the normalised form
 * contains withdraw, transfer, send or fundout (also covers `funds_out`,
 * `can_transfer`, `AccountTransfer`, `wallet:transactions:send`), or equals
 * `wallet:readwrite` (Deribit's read-write wallet scope, which can send).
 *
 * Mirrors `scopeMovesFunds` in packages/venue-contracts/src/adapter.ts, which
 * svc-protocol does not depend on. Change the two together.
 */
function normalisedName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function nameMovesFunds(name: string): boolean {
  const folded = normalisedName(name);
  return (
    folded.includes('withdraw') ||
    folded.includes('transfer') ||
    folded.includes('send') ||
    folded.includes('fundout') ||
    folded.includes('fundsout') ||
    folded === 'wallet:readwrite'
  );
}

export class WithdrawalPermissionRefusedError extends Error {
  readonly code = 'venue_vault.withdrawal_permission_refused' as const;
  constructor(detail: string) {
    super(`venue vault refused a key with withdrawal permission (${detail})`);
    this.name = 'WithdrawalPermissionRefusedError';
  }
}

export function withdrawalPermissionHits(permissions: VenueKeyPermissions): string[] {
  // A string is iterable. Refuse it before for...of yields characters. An empty
  // list shows nothing about what the key cannot do, so it is refused too.
  if (
    !permissions ||
    !Array.isArray(permissions.scopes) ||
    permissions.scopes.length === 0 ||
    permissions.scopes.some((scope) => typeof scope !== 'string' || normalisedName(scope) === '')
  ) {
    throw new WithdrawalPermissionRefusedError('scopes');
  }
  const rawFlags: unknown = permissions.flags;
  if (rawFlags !== undefined) {
    const plain =
      typeof rawFlags === 'object' && rawFlags !== null && !Array.isArray(rawFlags) && Object.getPrototypeOf(rawFlags) === Object.prototype;
    const primitives =
      plain && Object.values(rawFlags as Record<string, unknown>).every((v) => ['boolean', 'string', 'number'].includes(typeof v));
    if (!plain || !primitives) throw new WithdrawalPermissionRefusedError('flags');
  }
  const hits: string[] = [];
  for (const scope of permissions.scopes) {
    if (nameMovesFunds(scope)) hits.push(`scope:${scope}`);
  }
  for (const [key, value] of Object.entries(permissions.flags ?? {})) {
    const disabled = value === false || value === 0 || (typeof value === 'string' && ['false', '0'].includes(value.toLowerCase()));
    if (!disabled && nameMovesFunds(key)) hits.push(`flag:${key}`);
    if (typeof value === 'string' && nameMovesFunds(value)) hits.push(`flag:${key}=${value}`);
  }
  return hits;
}

/** Throw if this material could move funds off the venue. Call BEFORE encrypt. */
export function assertTradeOnly(permissions: VenueKeyPermissions): void {
  const hits = withdrawalPermissionHits(permissions);
  if (hits.length > 0) throw new WithdrawalPermissionRefusedError(hits.join(','));
}
