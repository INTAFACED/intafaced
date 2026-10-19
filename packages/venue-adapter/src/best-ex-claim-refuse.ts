/**
 * Q/R — best-ex / “we found the best price” / smart-route claim refuse.
 *
 * Ranking on observed quotes is not a legal best-execution claim. Blank owner
 * law refuses. Never invent owner law, never stamp a route as best-ex.
 * router.ts ranking and cost-model.ts are not recut.
 */

export const BEST_EX_CLAIM_UNSET = 'venue.best_ex_claim_unset' as const;

export type BestExClaimRefuseReason = 'best_ex_unset';

export type BestExClaimRefusal = {
  readonly ok: false;
  readonly reason: BestExClaimRefuseReason;
  readonly code: typeof BEST_EX_CLAIM_UNSET;
  readonly detail: string;
};

export type BestExClaimIdle = {
  readonly ok: true;
  readonly claimed: false;
};

export type BestExClaimSealed = {
  readonly ok: true;
  readonly claimed: true;
  readonly ownerBestExLaw: string;
};

export type BestExClaimVerdict = BestExClaimRefusal | BestExClaimIdle | BestExClaimSealed;

const CLAIM_KINDS = new Set([
  'best-ex',
  'best_ex',
  'best-execution',
  'best_execution',
  'sor-claim',
  'sor',
  'smart-route',
  'smart_route',
  'smart-order-router',
  'best-price',
  'we-found-the-best-price',
]);

const UNSET_LAW = new Set(['false', '0', 'off', 'unset', 'invented']);

function setText(raw: string | boolean | null | undefined): string | null {
  if (raw === undefined || raw === null || raw === false || raw === true) return null;
  const text = raw.trim();
  return text.length === 0 ? null : text;
}

function isHonestNegation(copy: string): boolean {
  const l = copy.toLowerCase();
  if (/\b(?:not|never|no)\b.{0,48}\b(?:best[- ]?execution|best[- ]?ex|smart[- ]?route|best price)\b/.test(l)) {
    return true;
  }
  if (/\b(?:unproven|refusing rather than claiming)\b/.test(l)) return true;
  return false;
}

/** Affirmative user-facing best-ex / smart-route / best-price copy. */
export function copyClaimsBestEx(copy: string): boolean {
  if (isHonestNegation(copy)) return false;
  const l = copy.toLowerCase();
  return (
    /\bbest[- ]?execution\b/.test(l) ||
    /\bwe found the best price\b/.test(l) ||
    /\bfound the best price\b/.test(l) ||
    /\bsmart[- ]?route\b/.test(l) ||
    /\bsmart order router\b/.test(l)
  );
}

function refuseUnset(): BestExClaimRefusal {
  return {
    ok: false,
    reason: 'best_ex_unset',
    code: BEST_EX_CLAIM_UNSET,
    detail: 'owner best-ex law is unset — refusing rather than claiming best execution',
  };
}

/**
 * Best-ex / smart-route / “we found the best price” needs owner law.
 * Ranking a quote is not a claim. Unset law refuses the claim.
 */
export function refuseBestExClaim(
  input: {
    readonly ownerBestExLaw?: string | boolean | null;
    readonly claim?: boolean;
    readonly kind?: string | null;
    readonly copy?: string | null;
  } = {},
): BestExClaimVerdict {
  const kind = input.kind?.trim().toLowerCase() ?? '';
  const copy = input.copy ?? '';
  const claiming = input.claim === true || CLAIM_KINDS.has(kind) || (copy.length > 0 && copyClaimsBestEx(copy));
  if (!claiming) {
    return { ok: true, claimed: false };
  }
  const law = setText(input.ownerBestExLaw);
  if (!law || UNSET_LAW.has(law.toLowerCase())) {
    return refuseUnset();
  }
  return { ok: true, claimed: true, ownerBestExLaw: law };
}

/** Public honesty board — ranking ≠ best-ex. */
export function describeBestExClaimRefuse() {
  return {
    rankingIsNotBestExClaim: true as const,
    smartRouteWithoutOwnerLaw: false as const,
    inventsBestPrice: false as const,
    unsetCode: BEST_EX_CLAIM_UNSET,
  };
}
