import type { FraudRuleId } from '../fraud/evaluate.js';
import { describeFraudPolicy, FRAUD_RULE_IDS } from '../fraud/fraud-policy.js';

/**
 * M-disp-05 (spec group merchant-disp-bill-rep): the default risk rules in
 * plain words, READ ONLY, built from `describeFraudPolicy` (fraud-policy.ts).
 *
 * No threshold or score cut-off is invented. `fraud.evaluate` takes every
 * threshold from its caller and none is published in this service, so each
 * rule's threshold reads `not_set`. Nothing here enforces anything: the
 * merchant-facing status is "recorded, not enforced" until the lead decides
 * what a block does.
 *
 * The `satisfies` maps make the build fail if a rule id or a policy guarantee
 * is added to fraud-policy.ts without its words here.
 */

type PolicyGuarantee = Exclude<keyof ReturnType<typeof describeFraudPolicy>, 'ruleIds'>;

const RULE_WORDS = {
  velocity_count: {
    title: 'Many payments in a short time',
    words: 'Flags a payment when too many payments arrive for you within one time window.',
  },
  velocity_volume: {
    title: 'High total in a short time',
    words: 'Flags a payment when the total paid to you within one time window is too high.',
  },
  amount_anomaly: {
    title: 'Unusually large payment',
    words: 'Flags a payment that is many times larger than your typical payment.',
  },
  blocklist_ip: {
    title: 'Blocked network address',
    words: 'Flags a payment from a network address on a block list.',
  },
  blocklist_device: {
    title: 'Blocked device',
    words: 'Flags a payment from a device on a block list.',
  },
} as const satisfies Record<FraudRuleId, { title: string; words: string }>;

const GUARANTEE_WORDS = {
  inventsRiskScores: 'We never make up a risk score.',
  inventsBlocklistContent: 'We never fill a block list with made-up entries.',
  chargebackLedgerRefuseClosed: 'A risk check never moves money on its own.',
  sanctionsSeparateFromFraud: 'Sanctions screening is a separate check, not part of these rules.',
  silentAllowForbidden: 'A rule that cannot run is never treated as a pass.',
  explainableDecisions: 'Every review or block names the rule that caused it.',
} as const satisfies Record<PolicyGuarantee, string>;

export function merchantRiskPolicy() {
  const policy = describeFraudPolicy();
  return {
    enforcement: 'recorded_not_enforced' as const,
    rules: FRAUD_RULE_IDS.map((ruleId) => ({
      ruleId,
      title: RULE_WORDS[ruleId].title,
      words: RULE_WORDS[ruleId].words,
      /** No value is published for any rule. Shown as "not set", never a number. */
      threshold: { state: 'not_set' as const },
    })),
    guarantees: (Object.keys(GUARANTEE_WORDS) as PolicyGuarantee[]).map((key) => ({
      key,
      holds: policy[key] === (key === 'inventsRiskScores' || key === 'inventsBlocklistContent' ? false : true),
      words: GUARANTEE_WORDS[key],
    })),
  };
}
