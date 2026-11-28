import type { DexDoorHonesty } from '@intafaced/contracts/dex-procedures';
import { refuseBestExClaim, type BestExClaimVerdict } from '@intafaced/venue-adapter';

/**
 * Q-dex leftover — the internal book is ledger-settled.
 *
 * `custody-scan` proves this process never posts. That is not the same as
 * "a quote from `internal-book` is non-custodial" or "this is an on-chain AMM".
 * A fill on our engine settles through the ledger. AMM is not a venue until
 * an indexer projects reserves; this payload never claims one is wired here.
 *
 * Ranking + degraded/singleVenue is not a certified best-execution claim.
 * Hitch: `refuseBestExClaim` from venue-adapter. Unset owner law → claimed
 * false; copy/claim true without law refuses `venue.best_ex_claim_unset`.
 *
 * Empty `DEX_EXTERNAL_VENUES` is not a live external venue. This payload names
 * `externalVenueWired: false` rather than inventing a row.
 *
 * Its wire shape is svc-dex's records' (`@intafaced/contracts/dex-procedures`, `dexDoorHonestySchema`).
 */

export type DexBestExHonestyInput = {
  readonly ownerBestExLaw?: string | boolean | null;
  readonly claim?: boolean;
  readonly kind?: string | null;
  readonly copy?: string | null;
};

/** Public quote/health never pass `claim: true`. Ranking is idle, not certified. */
export function dexBestExHonesty(input: DexBestExHonestyInput = {}): BestExClaimVerdict {
  return refuseBestExClaim(input);
}

export type DexDoorHonestyInput = {
  readonly internalBookEnabled: boolean;
  readonly ammVenueWired?: boolean;
  readonly externalVenueWired?: boolean;
  readonly internalBookPriced?: boolean;
  readonly ownerBestExLaw?: string | boolean | null;
  readonly bestExClaim?: boolean;
  readonly bestExKind?: string | null;
  readonly bestExCopy?: string | null;
};

export function dexDoorHonesty(opts: DexDoorHonestyInput): DexDoorHonesty {
  const ammVenueWired = opts.ammVenueWired ?? false;
  const externalVenueWired = opts.externalVenueWired ?? false;
  const bestEx = dexBestExHonesty({
    ownerBestExLaw: opts.ownerBestExLaw,
    claim: opts.bestExClaim,
    kind: opts.bestExKind,
    copy: opts.bestExCopy,
  });
  if (!opts.internalBookEnabled) {
    return {
      serviceHoldsBalances: false,
      internalBook: { enabled: false, amm: false },
      ammVenueWired,
      externalVenueWired,
      bestEx,
    };
  }
  return {
    serviceHoldsBalances: false,
    internalBook: {
      enabled: true,
      ...(opts.internalBookPriced === undefined ? {} : { priced: opts.internalBookPriced }),
      custodial: true,
      plane: 'fiat',
      venueKind: 'internal',
      amm: false,
    },
    ammVenueWired,
    externalVenueWired,
    bestEx,
  };
}

export function dexReadyHonesty(opts: DexDoorHonestyInput) {
  return { ready: true as const, ...dexDoorHonesty(opts) };
}

export function dexHealthHonesty(opts: DexDoorHonestyInput) {
  return { ok: true as const, service: 'svc-dex' as const, ...dexDoorHonesty(opts) };
}
