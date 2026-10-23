import { compare, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { PolicyRule } from './schemas.js';

/**
 * The custody transaction policy engine (W-custody-ops-07). Pure: no database, no clock, no I/O except the
 * `usedInWindow` callback a caller supplies for cumulative rules.
 *
 * ORDER. Rules are read top to bottom. Every rule whose match holds is collected; if any of them is `block`, the
 * first such block decides (a reject beats an accept wherever it sits). Otherwise the FIRST matching rule decides.
 * A transaction no rule matches is `no_match`, which callers treat as a refusal: the policy is a default-deny list.
 *
 * BLANK IS INVALID. An empty list, a blank or non-positive amount, a non-positive window, an approval group without
 * members or with a threshold it cannot reach, all make the rule invalid and the draft unpublishable. A missing match
 * field means "any"; an empty one is a mistake and is refused, never read as "any" or "none".
 *
 * UNITS. Amounts are in the asset's own units (`native`), as scaled bigint. A rule priced in USD or EUR needs a price
 * source, and none is wired here, so such a rule does not validate rather than being compared against a guessed price.
 * A native amount means nothing across assets, so an amount rule must name exactly one asset.
 */

export type PolicyOutcome = PolicyRule['action'] | 'no_match';

export interface PolicyTx {
  readonly initiator: string;
  readonly assetId: string;
  readonly amount: Amount;
  readonly network: string;
  readonly destinationKind: string;
  readonly destinationRef: string;
  readonly txType: NonNullable<PolicyRule['match']['txTypes']>[number];
}

/** What the initiator already moved of `assetId` in the last `windowSeconds`, excluding this transaction. */
export type UsedInWindow = (q: { initiator: string; assetId: string; windowSeconds: number }) => Promise<Amount>;

export interface PolicyDecision {
  readonly outcome: PolicyOutcome;
  readonly ruleId: string | null;
  readonly matchedRuleIds: readonly string[];
  readonly approval: PolicyRule['approval'] | null;
}

export interface PolicyProblem {
  readonly ruleId: string | null;
  readonly problem: string;
}

const LIST_FIELDS = ['assets', 'networks', 'destinationKinds', 'destinationsIn', 'destinationsNotIn', 'txTypes', 'initiators'] as const;

function positiveAmount(raw: string): Amount | null {
  try {
    const a = parseAmount(raw.trim());
    return a > 0n ? a : null;
  } catch {
    return null;
  }
}

/** Every problem in a rule set; an empty array means it may be saved and published. */
export function validateRules(rules: readonly PolicyRule[]): PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  if (rules.length === 0) problems.push({ ruleId: null, problem: 'a policy needs at least one rule' });
  const seen = new Set<string>();
  for (const rule of rules) {
    const id = rule.id.trim();
    const add = (problem: string) => problems.push({ ruleId: id === '' ? null : id, problem });
    if (id === '') add('rule id is blank');
    else if (seen.has(id)) add('rule id is used twice');
    seen.add(id);
    for (const field of LIST_FIELDS) {
      const values = rule.match[field] as readonly string[] | undefined;
      if (values === undefined) continue;
      if (values.length === 0) add(`${field} is empty; leave it out to match any`);
      else if (values.some((v) => v.trim() === '')) add(`${field} has a blank entry`);
    }
    const amounts = [rule.match.amountOver, rule.match.cumulativeOver].filter((a) => a !== undefined);
    for (const a of amounts) {
      if (positiveAmount(a.amount) === null) add('amount must be a positive decimal string');
      if (a.unit !== 'native') add(`amounts in ${a.unit} need a price source, which this build does not have`);
    }
    if (amounts.length > 0 && rule.match.assets?.length !== 1) add('an amount rule must name exactly one asset');
    const window = rule.match.cumulativeOver?.windowSeconds;
    if (window !== undefined && window <= 0) add('windowSeconds must be positive');
    const needsGroup = rule.action === 'approve' || rule.action === 'additional_signers';
    if (needsGroup && !rule.approval) add(`action ${rule.action} needs an approval group`);
    if (!needsGroup && rule.approval) add(`action ${rule.action} takes no approval group`);
    if (rule.approval) {
      const members = rule.approval.members;
      if (members.length === 0 || members.some((m) => m.trim() === '')) add('approval group needs named members');
      if (new Set(members).size !== members.length) add('approval group lists a member twice');
      if (rule.approval.threshold < 1 || rule.approval.threshold > members.length)
        add('approval threshold must be between 1 and the number of members');
    }
  }
  return problems;
}

async function matches(rule: PolicyRule, tx: PolicyTx, used: UsedInWindow): Promise<boolean> {
  const m = rule.match;
  if (m.assets && !m.assets.includes(tx.assetId)) return false;
  if (m.networks && !m.networks.includes(tx.network)) return false;
  if (m.destinationKinds && !m.destinationKinds.includes(tx.destinationKind)) return false;
  if (m.destinationsIn && !m.destinationsIn.includes(tx.destinationRef)) return false;
  if (m.destinationsNotIn && m.destinationsNotIn.includes(tx.destinationRef)) return false;
  if (m.txTypes && !m.txTypes.includes(tx.txType)) return false;
  if (m.initiators && !m.initiators.includes(tx.initiator)) return false;
  if (m.amountOver && compare(tx.amount, parseAmount(m.amountOver.amount)) <= 0) return false;
  if (m.cumulativeOver) {
    const prior = await used({ initiator: tx.initiator, assetId: tx.assetId, windowSeconds: m.cumulativeOver.windowSeconds });
    if (compare(prior + tx.amount, parseAmount(m.cumulativeOver.amount)) <= 0) return false;
  }
  return true;
}

/**
 * Decide one transaction. The rules must have passed `validateRules`; an invalid set throws rather than being read
 * leniently, because a published version was validated and anything else is a bug.
 */
export async function evaluatePolicy(rules: readonly PolicyRule[], tx: PolicyTx, used: UsedInWindow): Promise<PolicyDecision> {
  const problems = validateRules(rules);
  if (problems.length > 0) throw new Error(`custody policy is invalid: ${problems.map((p) => p.problem).join('; ')}`);
  const hit: PolicyRule[] = [];
  for (const rule of rules) if (await matches(rule, tx, used)) hit.push(rule);
  const matchedRuleIds = hit.map((r) => r.id);
  const decider = hit.find((r) => r.action === 'block') ?? hit[0];
  if (!decider) return { outcome: 'no_match', ruleId: null, matchedRuleIds, approval: null };
  return { outcome: decider.action, ruleId: decider.id, matchedRuleIds, approval: decider.approval ?? null };
}
