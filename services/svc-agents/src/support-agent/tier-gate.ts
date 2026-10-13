/**
 * Support agent Stage-2 — tier / gating per product law.
 *
 * Spec: docs/ops/trk/agents.support.md Stage 2.
 *
 * The support tier matrix — which plan may use the assist layer, and with which
 * desk tools — is product law nobody has published yet. Until a caller supplies
 * a published matrix this gate is **refuse-closed**: it does not invent a free /
 * staked / premium grant, and it does not fall back to "everyone gets the reads".
 * Same posture as the navigator gate, for the same reason (DIRECTION §8: product
 * numbers are Nitro's, never the agent's).
 */

export type SupportTierLaw =
  | { readonly published: false }
  | {
      readonly published: true;
      /** Caller-supplied matrix: userTier → allowed tool names. Never defaulted here. */
      readonly matrix: Readonly<Record<string, readonly string[]>>;
    };

export type SupportTierGateOk = {
  readonly status: 'ok';
  readonly userTier: string;
  readonly allowedTools: readonly string[];
};

export type SupportTierGateRefuse = {
  readonly status: 'refuse';
  readonly reason: 'tier_law_blank' | 'tier_not_granted';
  readonly userMessageKey: 'agents.support.tier_closed';
};

export type SupportTierGateResult = SupportTierGateOk | SupportTierGateRefuse;

/**
 * Gate support desk tool use on published product-law matrix.
 * Blank / unpublished / empty matrix → refuse-closed (no invent).
 */
export function supportTierGate(input: { law: SupportTierLaw | null | undefined; userTier: string }): SupportTierGateResult {
  const tier = input.userTier.trim();
  const law = input.law;

  if (!law || law.published !== true) {
    return { status: 'refuse', reason: 'tier_law_blank', userMessageKey: 'agents.support.tier_closed' };
  }

  if (Object.keys(law.matrix).length === 0) {
    return { status: 'refuse', reason: 'tier_law_blank', userMessageKey: 'agents.support.tier_closed' };
  }

  if (!tier) {
    return { status: 'refuse', reason: 'tier_not_granted', userMessageKey: 'agents.support.tier_closed' };
  }

  if (!Object.hasOwn(law.matrix, tier)) {
    return { status: 'refuse', reason: 'tier_not_granted', userMessageKey: 'agents.support.tier_closed' };
  }

  const allowed = law.matrix[tier];
  if (!allowed) {
    return { status: 'refuse', reason: 'tier_not_granted', userMessageKey: 'agents.support.tier_closed' };
  }

  return { status: 'ok', userTier: tier, allowedTools: allowed };
}

/** True when the gate is open. */
export function isSupportTierGateOk(result: SupportTierGateResult): result is SupportTierGateOk {
  return result.status === 'ok';
}

/** Board card for ops / tests. */
export function supportTierGateBoardCard(result: SupportTierGateResult): {
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
export function supportTierGateStatusLine(result: SupportTierGateResult): string {
  const c = supportTierGateBoardCard(result);
  return `ok=${c.ok ? '1' : '0'} tools=${c.toolCount} reason=${c.reason ?? '-'}`;
}
