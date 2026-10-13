/**
 * Navigator Stage-2 — tier / gating per product law.
 *
 * Spec: docs/ops/trk/agents.navigator.md Stage 2.
 * Product law for the navigator tier matrix is still unsigned (open question).
 * Until a published matrix is supplied by callers, this gate is **refuse-closed** —
 * we do not invent free / staked / premium tool grants.
 */

export type NavigatorTierLaw =
  | { readonly published: false }
  | {
      readonly published: true;
      /** Caller-supplied matrix: userTier → allowed tool names. Never defaulted here. */
      readonly matrix: Readonly<Record<string, readonly string[]>>;
    };

export type TierGateOk = {
  readonly status: 'ok';
  readonly userTier: string;
  readonly allowedTools: readonly string[];
};

export type TierGateRefuse = {
  readonly status: 'refuse';
  readonly reason: 'tier_law_blank' | 'tier_not_granted';
  readonly userMessageKey: 'agents.navigator.tier_closed';
};

export type TierGateResult = TierGateOk | TierGateRefuse;

/**
 * Gate navigator tool use on published product-law matrix.
 * Blank / unpublished / empty matrix → refuse-closed (no invent).
 */
export function navigatorTierGate(input: { law: NavigatorTierLaw | null | undefined; userTier: string }): TierGateResult {
  const tier = input.userTier.trim();
  const law = input.law;

  if (!law || law.published !== true) {
    return {
      status: 'refuse',
      reason: 'tier_law_blank',
      userMessageKey: 'agents.navigator.tier_closed',
    };
  }

  const keys = Object.keys(law.matrix);
  if (keys.length === 0) {
    return {
      status: 'refuse',
      reason: 'tier_law_blank',
      userMessageKey: 'agents.navigator.tier_closed',
    };
  }

  if (!tier) {
    return {
      status: 'refuse',
      reason: 'tier_not_granted',
      userMessageKey: 'agents.navigator.tier_closed',
    };
  }

  if (!Object.hasOwn(law.matrix, tier)) {
    return {
      status: 'refuse',
      reason: 'tier_not_granted',
      userMessageKey: 'agents.navigator.tier_closed',
    };
  }

  const allowed = law.matrix[tier];
  if (!allowed) {
    return {
      status: 'refuse',
      reason: 'tier_not_granted',
      userMessageKey: 'agents.navigator.tier_closed',
    };
  }

  return { status: 'ok', userTier: tier, allowedTools: allowed };
}

/** True when the gate is open. */
export function isNavigatorTierGateOk(result: TierGateResult): result is TierGateOk {
  return result.status === 'ok';
}

/** Board card for ops / tests. */
export function navigatorTierGateBoardCard(result: TierGateResult): {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly toolCount: number;
} {
  if (result.status === 'ok') {
    return { ok: true, reason: null, toolCount: result.allowedTools.length };
  }
  return { ok: false, reason: result.reason, toolCount: 0 };
}

/** Status line. */
export function navigatorTierGateStatusLine(result: TierGateResult): string {
  const c = navigatorTierGateBoardCard(result);
  return `ok=${c.ok ? '1' : '0'} tools=${c.toolCount} reason=${c.reason ?? '-'}`;
}
