import type { Sql } from 'postgres';
import {
  OWN_AGENT_POLICY_ACTIONS,
  type OwnAgentPolicy,
  type OwnAgentPolicyAction,
  type OwnAgentPolicyDecision,
  type OwnAgentPolicyEffect,
  type OwnAgentPolicyRule,
  type OwnAgentPolicyScope,
} from '@intafaced/contracts/agents-own';
import { OwnAgentRefusal } from './catalog.js';

/**
 * WHAT A PERSON'S OWN AGENT MAY DO, BY ACTION AND ACCOUNT (AG-spend-02, J-agents-08 #1).
 *
 * The person writes allow and deny rules, each for one action at one scope. For an action on an account:
 * 1. a deny whose scope covers the account refuses it `agents.policy_denied`, whatever order the rules were written in
 *    and whatever allows also match (ENGINE AD-3: a deny at any scope wins);
 * 2. otherwise an allow whose scope covers the account allows it;
 * 3. otherwise, on an agent that requires rules, it is refused `agents.policy_no_match`; on one that does not, no rule
 *    touches it and the agent's other gates decide.
 * Rules only narrow: they never grant a tool the agent does not carry and never move value. Only the person writes
 * them (the routes take the user from the signed principal and refuse an agent's token).
 */

export type PolicyAccount = 'main';

const covers = (scope: OwnAgentPolicyScope, account: PolicyAccount): boolean => scope === 'all' || scope === account;

/** The rules' decision for one action on one account. Pure: the order of `rules` never changes the answer. */
export function decide(
  rules: readonly Pick<OwnAgentPolicyRule, 'id' | 'effect' | 'action' | 'scope'>[],
  rulesRequired: boolean,
  action: OwnAgentPolicyAction,
  account: PolicyAccount,
): OwnAgentPolicyDecision {
  const matching = rules.filter((rule) => rule.action === action && covers(rule.scope, account));
  // The deciding rule is picked by id among its kind, so the answer and the rule named never depend on write order.
  const first = (effect: OwnAgentPolicyEffect) =>
    matching
      .filter((rule) => rule.effect === effect)
      .map((rule) => rule.id)
      .sort()[0] ?? null;
  const deny = first('deny');
  if (deny) return { action, account, outcome: 'denied', ruleId: deny };
  const allow = first('allow');
  if (allow) return { action, account, outcome: 'allowed', ruleId: allow };
  return { action, account, outcome: rulesRequired ? 'no_match_refused' : 'no_rule', ruleId: null };
}

/** Throws the refusal the decision carries; an allowed or untouched action returns. */
export function assertDecisionAllows(decision: OwnAgentPolicyDecision): void {
  if (decision.outcome === 'denied')
    throw new OwnAgentRefusal('agents.policy_denied', { action: decision.action, account: decision.account });
  if (decision.outcome === 'no_match_refused')
    throw new OwnAgentRefusal('agents.policy_no_match', { action: decision.action, account: decision.account });
}

interface RuleRow {
  id: string;
  effect: OwnAgentPolicyEffect;
  action: OwnAgentPolicyAction;
  scope: OwnAgentPolicyScope;
  created_at: Date;
}
const ruleView = (row: RuleRow): OwnAgentPolicyRule => ({
  id: row.id,
  effect: row.effect,
  action: row.action,
  scope: row.scope,
  createdAt: row.created_at.toISOString(),
});

export const policyRuleKey = (agentId: string, effect: OwnAgentPolicyEffect, action: OwnAgentPolicyAction, scope: OwnAgentPolicyScope) =>
  `agents:policy:${agentId}:${effect}:${action}:${scope}`;

/** The person's policy rules and settings for one agent. Every read and write is the owner's own rows only. */
export class OwnPolicyStore {
  constructor(private readonly sql: Sql) {}

  /** Adding a rule that is already live returns the stored row: a retry never makes a second one. */
  async add(
    ownerId: string,
    agentId: string,
    rule: { effect: OwnAgentPolicyEffect; action: OwnAgentPolicyAction; scope: OwnAgentPolicyScope },
  ): Promise<OwnAgentPolicyRule> {
    const key = policyRuleKey(agentId, rule.effect, rule.action, rule.scope);
    const inserted = await this.sql<RuleRow[]>`
      INSERT INTO agents.own_agent_policy_rules (agent_id, owner_id, effect, action, scope, rule_key)
      VALUES (${agentId}, ${ownerId}, ${rule.effect}, ${rule.action}, ${rule.scope}, ${key})
      ON CONFLICT (owner_id, rule_key) WHERE removed_at IS NULL DO NOTHING
      RETURNING id, effect, action, scope, created_at
    `;
    if (inserted[0]) return ruleView(inserted[0]);
    const stored = await this.sql<RuleRow[]>`
      SELECT id, effect, action, scope, created_at FROM agents.own_agent_policy_rules
       WHERE owner_id = ${ownerId} AND rule_key = ${key} AND removed_at IS NULL
    `;
    if (stored[0]) return ruleView(stored[0]);
    // The live row was removed between the insert and this read: the add is the person's newer word, so it is made again.
    return this.add(ownerId, agentId, rule);
  }

  /** Removes a live rule; a repeated remove of the same rule answers the same. One not the person's is not found. */
  async remove(ownerId: string, agentId: string, ruleId: string): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE agents.own_agent_policy_rules SET removed_at = COALESCE(removed_at, now())
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId} AND id = ${ruleId}
      RETURNING id
    `;
    if (!rows[0]) throw new OwnAgentRefusal('agents.policy_rule_not_found', { rule: ruleId });
  }

  /** The caller has already read the agent as the person's own (`agent_id` is the key, so one row per agent). */
  async setRulesRequired(ownerId: string, agentId: string, rulesRequired: boolean): Promise<void> {
    await this.sql`
      INSERT INTO agents.own_agent_policy_settings (agent_id, owner_id, rules_required)
      VALUES (${agentId}, ${ownerId}, ${rulesRequired})
      ON CONFLICT (agent_id) DO UPDATE
        SET rules_required = EXCLUDED.rules_required,
            updated_at = CASE WHEN own_agent_policy_settings.rules_required = EXCLUDED.rules_required
                              THEN own_agent_policy_settings.updated_at ELSE now() END
    `;
  }

  /** The live rules, whether rules are required, and the decision for every action on the main account. */
  async read(ownerId: string, agentId: string): Promise<OwnAgentPolicy> {
    // One read-only transaction, so the rules and the flag come from one snapshot.
    const [rows, settings] = await this.sql.begin(
      'isolation level repeatable read read only',
      (tx) =>
        [
          tx<RuleRow[]>`
            SELECT id, effect, action, scope, created_at FROM agents.own_agent_policy_rules
             WHERE owner_id = ${ownerId} AND agent_id = ${agentId} AND removed_at IS NULL
             ORDER BY created_at, id
          `,
          tx<{ rules_required: boolean }[]>`
            SELECT rules_required FROM agents.own_agent_policy_settings WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
          `,
        ] as const,
    );
    const rules = rows.map(ruleView);
    const rulesRequired = settings[0]?.rules_required ?? false;
    return {
      rulesRequired,
      rules,
      decisions: OWN_AGENT_POLICY_ACTIONS.map((action) => decide(rules, rulesRequired, action, 'main')),
    };
  }

  /**
   * The gate an agent action passes before anything is prepared or sent: the stored rules' decision for it, refused
   * with its code when they refuse. The order path (J-agents-08 #5, #6) calls this first.
   */
  async assertAllows(
    ownerId: string,
    agentId: string,
    action: OwnAgentPolicyAction,
    account: PolicyAccount,
  ): Promise<OwnAgentPolicyDecision> {
    const policy = await this.read(ownerId, agentId);
    const decision = decide(policy.rules, policy.rulesRequired, action, account);
    assertDecisionAllows(decision);
    return decision;
  }
}
