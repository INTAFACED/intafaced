import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { MarketError } from './vendor-service.js';

/**
 * STAKE-GATED LISTING SLOTS (§8.7, `market.vendors` Stage 2).
 *
 * svc-token owns staking and owns the tier schedule. This service reads ONE
 * NUMBER off it — how many listing slots the caller's current tier entitles them
 * to — and compares it against how many they hold. It never stores that number:
 * a cached entitlement is a gate that keeps admitting somebody after they have
 * unstaked.
 *
 * ── FAILS CLOSED, ON EVERY PATH ─────────────────────────────────────────────
 *
 * Network throw, non-2xx, a payload that is not the shape expected, a
 * `vendorSlots` that is not a non-negative integer — all four refuse with
 * `market.stake_unavailable`. Admitting on an unreadable stake would hand every
 * vendor unlimited slots for the length of an outage, which is precisely the
 * outage during which nobody would be watching the marketplace.
 *
 * Unlike svc-academy's equivalent, there is no half of this service that skips
 * the check: every slot claim is stake-gated, so svc-token being down closes the
 * claim path entirely. That is the correct trade — a slot claimed during an
 * outage is a listing nobody can prove was entitled.
 *
 * ── THE INTERNAL ENDPOINT, NOT THE tRPC PROCEDURE ───────────────────────────
 *
 * `token.stakeOf` / `token.accessOf` are `scopedProcedure('token:read')` and
 * SELF-ONLY: they resolve the caller's own principal, which svc-market does not
 * hold. `GET /internal/stake/:userId` is the only surface that exposes the whole
 * `AccessTier` — and therefore `vendorSlots` — across a service boundary.
 *
 * ── NO AMOUNT CROSSES THIS BOUNDARY, AND THAT IS ON PURPOSE ─────────────────
 *
 * The response also carries `staked` and `tier.minStake` as decimal strings.
 * This service reads NEITHER. It needs a capacity, not a balance, and svc-market
 * has no `@intafaced/ledger-client` dependency precisely so that no code path
 * here can hold or emit an amount (§0.6). Not parsing them is also the safest
 * possible position on the bug PR #1100 fixed: `staked` used to be emitted as
 * `Amount.toString()` — the raw scaled integer — and a consumer that re-scaled
 * it with `parseAmount` would read a stake 10^18 too large and admit everybody.
 * A field that is never read cannot be double-scaled.
 *
 * ── PR #1100 (merged) ───────────────────────────────────────────────────────
 *
 * That fix stopped `/internal/stake/:userId` 500ing on bigint `minStake`. This
 * client still fails closed on any non-2xx or unusable payload — a 500 remains
 * `market.stake_unavailable`, never a guessed free capacity.
 */

export interface SlotEntitlementSource {
  /** How many listing slots this user's current stake tier entitles them to. */
  entitlementOf(userId: string): Promise<VendorEntitlement>;
}

export interface VendorEntitlement {
  /** The tier's name, for display. Read off the response, never computed here. */
  tierName: string;
  /** `AccessTier.vendorSlots` — svc-token's number, restated nowhere. */
  vendorSlots: number;
}

export function createStakeSource(
  baseUrl: string,
  internalSecret: string,
  /** svc-market's own key. With it the call is key-signed for svc-token; `dual` also sends the shared-secret form. */
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): SlotEntitlementSource {
  const url = baseUrl.replace(/\/$/, '');
  const sign = serviceCallSigner({ service: 'svc-market', audience: 'svc-token', legacySecret: internalSecret, s2s });

  return {
    async entitlementOf(userId: string): Promise<VendorEntitlement> {
      let response: Response;
      try {
        const target = `${url}/internal/stake/${encodeURIComponent(userId)}`;
        response = await fetch(target, {
          method: 'GET',
          headers: {
            'content-type': 'application/json',
            ...sign('', { method: 'GET', url: new URL(target), contentType: 'application/json' }),
          },
        });
      } catch (err) {
        throw new MarketError(`Stake gate unavailable: ${(err as Error).message}`, 'market.stake_unavailable');
      }

      if (!response.ok) {
        throw new MarketError(`Stake gate unavailable (${response.status})`, 'market.stake_unavailable');
      }

      const body = (await response.json().catch(() => null)) as { tier?: { name?: unknown; vendorSlots?: unknown } } | null;
      const slots = body?.tier?.vendorSlots;

      /**
       * Checked rather than coerced. `Number(undefined)` is `NaN` and
       * `NaN >= capacity` is false, so a coercion here would turn a missing field
       * into a silent "no slots" — a refusal that looks like a stake decision and
       * is actually an outage. And a non-integer or negative slot count is a
       * schedule this service does not understand; refusing is the only honest
       * reading of it.
       */
      if (typeof slots !== 'number' || !Number.isInteger(slots) || slots < 0) {
        throw new MarketError('Stake gate returned an unusable slot entitlement', 'market.stake_unavailable');
      }

      return { tierName: typeof body?.tier?.name === 'string' ? body.tier.name : 'unknown', vendorSlots: slots };
    },
  };
}

/**
 * A fixed entitlement for every caller. Tests, and a dev stack running without
 * svc-token — never a production fallback, which is why it must be constructed
 * explicitly rather than reached by a catch block.
 */
export class FixedEntitlement implements SlotEntitlementSource {
  constructor(
    private readonly vendorSlots: number,
    private readonly tierName = 'fixed',
  ) {}

  async entitlementOf(): Promise<VendorEntitlement> {
    return { tierName: this.tierName, vendorSlots: this.vendorSlots };
  }
}
