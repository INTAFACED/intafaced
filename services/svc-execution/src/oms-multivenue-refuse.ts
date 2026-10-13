/**
 * Multi-venue hitch (PTX-M22-R02–R07). Adapters and oms-plan.ts SOR are LIVE.
 * Best-ex / SOR claim refuses without owner law. Outage cannot invent a fill.
 * DEX routing names gas / MEV / reorg or refuses. Never invent a venue.
 * Mill oms-plan / venue-adapters / venue-adapter cost-model are not recut.
 * router.ts is not recut.
 */

export type OmsMultivenueRefuseReason = 'best_ex_unset' | 'outage_invented_fill' | 'dex_risk_unset' | 'invented_venue';

export type OmsMultivenueRefusal = {
  readonly ok: false;
  readonly reason: OmsMultivenueRefuseReason;
  readonly detail: string;
};

function refuse(reason: OmsMultivenueRefuseReason, detail: string): OmsMultivenueRefusal {
  return { ok: false, reason, detail };
}

function setText(raw: string | boolean | null | undefined): string | null {
  if (raw === undefined || raw === null || raw === false) return null;
  if (raw === true) return 'named';
  const text = raw.trim();
  return text.length === 0 ? null : text;
}

const BEST_EX_KINDS = new Set(['best-ex', 'best_ex', 'best-execution', 'sor-claim', 'sor']);
const DEX_KINDS = new Set(['external-dex', 'amm']);

/** Best-ex / SOR claim needs owner law. Unset refuses — never invent letter→bps. */
export function refuseUnsetBestExClaim(input: {
  readonly ownerBestExLaw?: string | null;
  readonly bestEx?: boolean;
  readonly kind?: string | null;
}): OmsMultivenueRefusal | null {
  const kind = input.kind?.trim().toLowerCase() ?? '';
  const claiming = input.bestEx === true || BEST_EX_KINDS.has(kind);
  if (!claiming && input.ownerBestExLaw === undefined) return null;
  if (!claiming && input.ownerBestExLaw === null) {
    return refuse('best_ex_unset', 'owner best-ex law is unset — refusing rather than claiming best execution');
  }
  if (!claiming && input.ownerBestExLaw !== undefined) {
    const law = setText(input.ownerBestExLaw);
    if (!law) {
      return refuse('best_ex_unset', 'owner best-ex law is unset — refusing rather than claiming best execution');
    }
    return null;
  }
  const law = setText(input.ownerBestExLaw);
  if (!law) {
    return refuse('best_ex_unset', 'owner best-ex law is unset — refusing rather than claiming best execution');
  }
  const cls = law.toLowerCase();
  if (cls === 'false' || cls === '0' || cls === 'off' || cls === 'unset' || cls === 'invented') {
    return refuse('best_ex_unset', 'owner best-ex law is unset — refusing rather than claiming best execution');
  }
  return null;
}

/** Outage cannot mint a fill. */
export function refuseOutageInventedFill(input: {
  readonly outage?: boolean;
  readonly inventedFill?: boolean;
}): OmsMultivenueRefusal | null {
  if (input.outage === true || input.inventedFill === true) {
    return refuse('outage_invented_fill', 'venue outage cannot invent a fill — refusing rather than minting an execution');
  }
  return null;
}

/** DEX / AMM routing must name gas, MEV, and reorg — or refuse. */
export function refuseDexRouting(input: {
  readonly kind?: string | null;
  readonly gas?: string | boolean | null;
  readonly mev?: string | boolean | null;
  readonly reorg?: string | boolean | null;
  readonly venues?: readonly { readonly kind?: string | null }[];
}): OmsMultivenueRefusal | null {
  const kind = input.kind?.trim().toLowerCase() ?? '';
  const dex = DEX_KINDS.has(kind) || Boolean(input.venues?.some((venue) => DEX_KINDS.has((venue.kind ?? '').trim().toLowerCase())));
  if (!dex) return null;
  if (!setText(input.gas) || !setText(input.mev) || !setText(input.reorg)) {
    return refuse('dex_risk_unset', 'DEX routing must name gas, MEV, and reorg — refusing rather than inventing those terms');
  }
  return null;
}

/** Blank or unlisted venue id is invented — refuse. */
export function refuseInventedVenue(input: {
  readonly venueId?: string | null;
  readonly wiredVenueIds?: readonly string[];
}): OmsMultivenueRefusal | null {
  const id = input.venueId?.trim() ?? '';
  if (!id) {
    return refuse('invented_venue', 'venue id is blank — refusing rather than inventing a venue');
  }
  if (input.wiredVenueIds && !input.wiredVenueIds.includes(id)) {
    return refuse('invented_venue', `venue ${id} is not a wired adapter — refusing rather than inventing a venue`);
  }
  return null;
}

export function refuseLiveOmsMultivenue(input: {
  readonly kind?: string | null;
  readonly bestEx?: boolean;
  readonly ownerBestExLaw?: string | null;
  readonly outage?: boolean;
  readonly inventedFill?: boolean;
  readonly gas?: string | boolean | null;
  readonly mev?: string | boolean | null;
  readonly reorg?: string | boolean | null;
  readonly venueId?: string | null;
  readonly wiredVenueIds?: readonly string[];
  readonly venues?: readonly { readonly id?: string | null; readonly kind?: string | null }[];
}): OmsMultivenueRefusal | null {
  const claim = refuseUnsetBestExClaim(input);
  if (claim) return claim;
  const outage = refuseOutageInventedFill(input);
  if (outage) return outage;
  const dex = refuseDexRouting(input);
  if (dex) return dex;
  // Omitted venueId is not a blank id. withWired copies the allowlist onto a
  // venues-only plan, so check each venues[] id against that list.
  // A blank venues[] id with no allowlist stays unknown_venue in the plan.
  if (input.venueId !== undefined) {
    const venue = refuseInventedVenue({ venueId: input.venueId, wiredVenueIds: input.wiredVenueIds });
    if (venue) return venue;
  }
  if (input.wiredVenueIds && input.venues) {
    for (const venue of input.venues) {
      const invented = refuseInventedVenue({ venueId: venue.id, wiredVenueIds: input.wiredVenueIds });
      if (invented) return invented;
    }
  }
  return null;
}
