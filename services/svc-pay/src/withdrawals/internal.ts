import type { Sql } from 'postgres';

/**
 * Internal settlement (W-withdraw-14, J-wallet-07 #3-#5): a withdrawal to an address that is another account's deposit
 * address on the platform settles inside the book, as one svc-bank send, with no rail and no network fee. Its row in
 * `pay.withdrawals` carries this rail id, so the same client reference always resumes the same internal send.
 */
export const INTERNAL_RAIL = 'internal' as const;

/** What the caller is told about an address that cannot take a transfer: `frozen` and `ambiguous` read as plain `unavailable`, so a
 * compliance freeze is never disclosed to whoever types the address. */
export type PublicUnavailableReason = 'expired' | 'unavailable';
export const publicUnavailableReason = (reason: 'frozen' | 'expired' | 'ambiguous'): PublicUnavailableReason =>
  reason === 'expired' ? 'expired' : 'unavailable';

/** An EVM address: its letters' case is only a checksum, so it matches whatever case the deposit table stored. */
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Who an address belongs to, read only from svc-pay's own deposit address tables (no other service's table):
 *
 * - `external`: no account on the platform holds it, or it is not a wallet address (`crypto`) at all;
 * - `self`: it is one of the sender's own deposit addresses;
 * - `internal`: exactly one other account holds it, and it can take a deposit now;
 * - `unavailable`: it is frozen, past its expiry on every row that holds it, or more than one account holds it. A chain
 *   deposit there would be held or refused, so an internal send there is refused before anything is claimed.
 *
 * The match is exact, as the address was stored, except that an EVM address (`0x` and 40 hex digits) matches in any case.
 * Other chains' addresses (base58, bech32 and the like) are case-sensitive, so a differently cased address is someone else's.
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
  // The table refuses blanks, spaces and anything over 256 characters, so such a ref can match nothing.
  if (destination.kind !== 'crypto' || ref === '' || ref.length > 256 || /\s/.test(ref)) return { kind: 'external' };
  const anyCase = HEX_ADDRESS.test(ref);
  const owners = await q<Array<{ user_id: string; expired: boolean; frozen: boolean }>>`
    SELECT a.user_id,
           bool_and(a.expires_at IS NOT NULL AND a.expires_at <= now()) AS expired,
           bool_or(EXISTS (
             SELECT 1 FROM pay.custody_deposit_address_freezes f
              WHERE f.network_id = a.network_id AND f.address = lower(a.address) AND f.unfrozen_at IS NULL
           )) AS frozen
      FROM pay.custody_deposit_addresses a
     WHERE lower(a.address) = ${ref.toLowerCase()} AND (${anyCase}::boolean OR a.address = ${ref})
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
