import type { Sql } from 'postgres';

/**
 * Internal settlement (W-withdraw-14, J-wallet-07 #3-#5): a withdrawal to an address that is another account's deposit
 * address on the platform settles inside the book, as one svc-bank send, with no rail and no network fee. Its row in
 * `pay.withdrawals` carries this rail id, so the same client reference always resumes the same internal send.
 */
export const INTERNAL_RAIL = 'internal' as const;

/**
 * Who an address belongs to, read only from svc-pay's own deposit address tables (no other service's table):
 *
 * - `external`: no account on the platform holds it, or it is not a wallet address (`crypto`) at all;
 * - `self`: it is one of the sender's own deposit addresses;
 * - `internal`: exactly one other account holds it, and it can take a deposit now;
 * - `unavailable`: it is frozen, past its expiry, or more than one account holds it. A chain deposit there would be held
 *   or refused, so an internal send there is refused before anything is claimed.
 */
export type PlatformDestination =
  | { readonly kind: 'external' }
  | { readonly kind: 'self' }
  | { readonly kind: 'internal'; readonly toUserId: string }
  /** `toUserId` is the one owner of a frozen or expired address (a resumed send still names them), `null` when ambiguous. */
  | { readonly kind: 'unavailable'; readonly reason: 'frozen' | 'expired' | 'ambiguous'; readonly toUserId: string | null };

export async function resolvePlatformDestination(
  q: Sql,
  userId: string,
  destination: { kind: string; ref: string },
): Promise<PlatformDestination> {
  const ref = destination.ref.trim();
  // An exact match on the address as the deposit table stores it (any chain's format), so no shape is assumed here; the
  // table refuses blanks, spaces and anything over 256 characters, so such a ref can match nothing.
  if (destination.kind !== 'crypto' || ref === '' || ref.length > 256 || /\s/.test(ref)) return { kind: 'external' };
  const owners = await q<Array<{ user_id: string; expired: boolean; frozen: boolean }>>`
    SELECT a.user_id,
           bool_or(a.expires_at IS NOT NULL AND a.expires_at <= now()) AS expired,
           bool_or(EXISTS (
             SELECT 1 FROM pay.custody_deposit_address_freezes f
              WHERE f.network_id = a.network_id AND f.address = lower(a.address) AND f.unfrozen_at IS NULL
           )) AS frozen
      FROM pay.custody_deposit_addresses a
     WHERE lower(a.address) = ${ref.toLowerCase()}
     GROUP BY a.user_id
     LIMIT 2`;
  if (owners.length === 0) return { kind: 'external' };
  // Two accounts on one address is a fault, not a guess (the deposit book refuses to credit it too).
  if (owners.length > 1) return { kind: 'unavailable', reason: 'ambiguous', toUserId: null };
  const owner = owners[0]!;
  if (owner.user_id === userId) return { kind: 'self' };
  if (owner.frozen) return { kind: 'unavailable', reason: 'frozen', toUserId: owner.user_id };
  if (owner.expired) return { kind: 'unavailable', reason: 'expired', toUserId: owner.user_id };
  return { kind: 'internal', toUserId: owner.user_id };
}
