import type { TierLaws } from '../tier-laws.js';
import { navigatorTierGate } from '../navigator/tier-gate.js';
import { scannerTierGate } from '../scanner/tier-gate.js';
import { supportTierGate } from '../support-agent/tier-gate.js';

/**
 * Who may use an agent, as its published law says, and whether the signed-in person may (J-agents-01 #2).
 *
 * The one rule svc-agents enforces on who may use an agent is the tier law (`AGENTS_TIER_LAWS`): the scanner,
 * navigator and support doors refuse a person whose plan (`ctx.principal.tier`, the account's verification tier) the
 * law does not grant, and refuse everyone while the law is unpublished (`tier_law_blank`). The verdict here is those
 * doors' own gate run on the same law and the same tier, so the page never shows a reason the service would not apply.
 * An agent with no tier-gated door has no plan, age or region rule in this service, and says so (`rule: 'none'`).
 */
export type Eligibility =
  | { readonly rule: 'none'; readonly eligible: true; readonly reason: null; readonly code: null; readonly yourPlan: string }
  | {
      readonly rule: 'plan';
      /** False while the law is blank: then no plan is granted and the door refuses everyone. */
      readonly published: boolean;
      /** The plans the law grants, in the law's own order; empty when unpublished. */
      readonly plans: string[];
      readonly yourPlan: string;
      readonly eligible: boolean;
      /** The rule that leaves the person out, when it does. */
      readonly reason: 'plan' | null;
      /** The door's own refusal for this person, when it refuses. */
      readonly code: string | null;
    };

type Gate = (laws: TierLaws, userTier: string) => { status: 'ok' } | { status: 'refuse'; reason: string };

/** The agents whose doors gate on the tier law, each with that door's own gate. */
const TIER_GATED: Readonly<Record<string, { entry: keyof TierLaws; gate: Gate }>> = {
  navigator: { entry: 'navigator', gate: (laws, userTier) => navigatorTierGate({ law: laws.navigator, userTier }) },
  support: { entry: 'support', gate: (laws, userTier) => supportTierGate({ law: laws.support, userTier }) },
  scanner: { entry: 'scanner', gate: (laws, userTier) => scannerTierGate({ law: laws.scanner, userTier }) },
};

export function agentEligibility(agentId: string, laws: TierLaws, tier: string): Eligibility {
  const yourPlan = tier.trim();
  const gated = Object.hasOwn(TIER_GATED, agentId) ? TIER_GATED[agentId]! : null;
  if (!gated) return { rule: 'none', eligible: true, reason: null, code: null, yourPlan };
  const law = laws[gated.entry];
  const plans = law && law.published === true ? Object.keys(law.matrix) : [];
  const verdict = gated.gate(laws, yourPlan);
  const eligible = verdict.status === 'ok';
  // The scanner's own refusal when the limits published for this plan are not valid (`depth_invalid`) keeps its code, so
  // the page says the plan's published limits are the reason, not that the plan is missing from the law.
  return {
    rule: 'plan',
    published: plans.length > 0,
    plans,
    yourPlan,
    eligible,
    reason: eligible ? null : 'plan',
    code: verdict.status === 'refuse' ? `agents.${verdict.reason}` : null,
  };
}
