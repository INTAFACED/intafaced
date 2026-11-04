import type { Sql } from 'postgres';
import { OWN_TOOLS, OwnAgentRefusal, type OwnDataClass } from './catalog.js';

/**
 * WHAT A PERSON'S OWN AGENT MAY DO WITH ITS TOOLS (AG-guardrails-01, AG-guardrails-02).
 *
 * Three gates stand between the agent's guardrail and a tool running, in this order:
 * 1. Consent. The first time the agent uses a class of tools (own data, market data, draft write, live write) the
 *    person is asked; until they allow it the call is refused `agents.consent_required`, and revoking withdraws it.
 * 2. The managed baseline. The owner's requirement per class: the loosest standing choice any lower scope may take.
 *    A blank class refuses the call, and any rule that would rely on it, with `agents.baseline_value_unset`.
 * 3. The person's standing rule for that tool, if any. Rules only narrow: a rule never grants a tool, and the stricter
 *    of the rule and the baseline decides. "Ask before acting" turns the call into an approval request; "hand it off"
 *    stops the agent and leaves the step to the person.
 *
 * At save a rule that lets a live-write tool act without asking is refused `agents.rule_invalid` (built-in law, ENGINE
 * AP-7), and a rule looser than the baseline's requirement is refused `agents.baseline_loosen_refused`.
 * Nothing here moves value.
 */

/** Strictest first. A choice later in the list is looser than one earlier. */
export const RULE_CHOICES = ['hand_off', 'ask_before', 'act_on_request', 'act_without_asking'] as const;
export type RuleChoice = (typeof RULE_CHOICES)[number];
export const DATA_CLASSES = ['own_data', 'market_data', 'draft_write', 'live_write'] as const satisfies readonly OwnDataClass[];

const looseness = (choice: RuleChoice): number => RULE_CHOICES.indexOf(choice);
const stricter = (a: RuleChoice, b: RuleChoice): RuleChoice => (looseness(a) <= looseness(b) ? a : b);

/** The owner's baseline: per class, the loosest choice allowed. A class missing from it is blank. */
export type PolicyBaseline = Readonly<Partial<Record<OwnDataClass, RuleChoice>>>;

/**
 * `AGENTS_POLICY_BASELINE`, a JSON object of class to choice. Unset is blank everywhere (every tool call and every
 * rule that loosens refuses); a malformed value stops the service at boot, never at a call.
 */
export function parsePolicyBaseline(value: string | undefined): PolicyBaseline {
  const text = value?.trim() ?? '';
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('AGENTS_POLICY_BASELINE is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AGENTS_POLICY_BASELINE must be an object');
  const baseline: Partial<Record<OwnDataClass, RuleChoice>> = {};
  for (const [key, choice] of Object.entries(parsed)) {
    if (!(DATA_CLASSES as readonly string[]).includes(key)) throw new Error(`AGENTS_POLICY_BASELINE names an unknown class: ${key}`);
    if (!(RULE_CHOICES as readonly unknown[]).includes(choice)) throw new Error(`AGENTS_POLICY_BASELINE has an unknown choice for ${key}`);
    baseline[key as OwnDataClass] = choice as RuleChoice;
  }
  return baseline;
}

/** A tool the agent carries, with its class; one it does not carry refuses as not declared. */
export function classOf(agentTools: readonly string[], tool: string): OwnDataClass {
  const entry = OWN_TOOLS.find((t) => t.name === tool);
  if (!entry || !agentTools.includes(tool) || entry.dataClass === null) throw new OwnAgentRefusal('agents.tool_not_declared', { tool });
  return entry.dataClass;
}

/** Checks a rule before it is stored: the built-in law first, then the baseline. Refuses the first thing wrong. */
export function checkRule(baseline: PolicyBaseline, agentTools: readonly string[], tool: string, choice: RuleChoice): void {
  const dataClass = classOf(agentTools, tool);
  if (dataClass === 'live_write' && choice === 'act_without_asking') throw new OwnAgentRefusal('agents.rule_invalid', { tool });
  // Asking first or handing off can only narrow; anything looser is checked against the owner's requirement.
  if (looseness(choice) <= looseness('ask_before')) return;
  const required = baseline[dataClass];
  if (!required) throw new OwnAgentRefusal('agents.baseline_value_unset', { dataClass });
  if (looseness(choice) > looseness(required)) throw new OwnAgentRefusal('agents.baseline_loosen_refused', { dataClass, required });
}

/** What a tool call of the person's own agent comes to, before it runs. */
export type Gate =
  | { readonly kind: 'run'; readonly dataClass: OwnDataClass }
  | { readonly kind: 'ask'; readonly dataClass: OwnDataClass; readonly ruleId: string | null };

/**
 * Consent, then baseline, then the person's rule. A refusal throws its code; an "ask" is the caller's to store as an
 * approval request; "run" lets the call go on to the session's own guardrail.
 */
export async function gateToolCall(
  sql: Sql,
  baseline: PolicyBaseline,
  input: { ownerId: string; agentId: string; agentTools: readonly string[]; tool: string },
): Promise<Gate> {
  const dataClass = classOf(input.agentTools, input.tool);
  const consents = new OwnConsentStore(sql);
  if (!(await consents.granted(input.ownerId, input.agentId, dataClass))) {
    throw new OwnAgentRefusal('agents.consent_required', { dataClass });
  }
  const required = baseline[dataClass];
  if (!required) throw new OwnAgentRefusal('agents.baseline_value_unset', { dataClass });
  const rule = await new OwnRuleStore(sql).forTool(input.ownerId, input.agentId, input.tool);
  const choice = rule ? stricter(rule.choice, required) : required;
  if (choice === 'hand_off') throw new OwnAgentRefusal('agents.rule_hand_off', { tool: input.tool });
  if (choice === 'ask_before') return { kind: 'ask', dataClass, ruleId: rule && rule.choice === choice ? rule.id : null };
  return { kind: 'run', dataClass };
}

export type OwnRuleView = { readonly id: string; readonly tool: string; readonly choice: RuleChoice; readonly updatedAt: string };

interface RuleRow {
  id: string;
  tool: string;
  choice: RuleChoice;
  updated_at: Date;
}
const ruleView = (row: RuleRow): OwnRuleView => ({
  id: row.id,
  tool: row.tool,
  choice: row.choice,
  updatedAt: row.updated_at.toISOString(),
});

/** The person's standing rules for one agent: one per tool, keyed `agents:rule:<agent>:own:<tool>`. */
export class OwnRuleStore {
  constructor(private readonly sql: Sql) {}

  /** Saving the same rule again is the same row; a new choice for the tool replaces the old one. */
  async save(ownerId: string, agentId: string, tool: string, choice: RuleChoice): Promise<OwnRuleView> {
    const rows = await this.sql<RuleRow[]>`
      INSERT INTO agents.own_agent_rules (agent_id, owner_id, tool, choice, rule_key)
      VALUES (${agentId}, ${ownerId}, ${tool}, ${choice}, ${`agents:rule:${agentId}:own:${tool}`})
      ON CONFLICT (owner_id, rule_key) DO UPDATE
        SET choice = EXCLUDED.choice,
            updated_at = CASE WHEN own_agent_rules.choice = EXCLUDED.choice THEN own_agent_rules.updated_at ELSE now() END
      RETURNING id, tool, choice, updated_at
    `;
    return ruleView(rows[0]!);
  }

  async list(ownerId: string, agentId: string): Promise<OwnRuleView[]> {
    const rows = await this.sql<RuleRow[]>`
      SELECT id, tool, choice, updated_at FROM agents.own_agent_rules
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
       ORDER BY created_at, id
    `;
    return rows.map(ruleView);
  }

  async forTool(ownerId: string, agentId: string, tool: string): Promise<OwnRuleView | null> {
    const rows = await this.sql<RuleRow[]>`
      SELECT id, tool, choice, updated_at FROM agents.own_agent_rules
       WHERE owner_id = ${ownerId} AND rule_key = ${`agents:rule:${agentId}:own:${tool}`}
    `;
    return rows[0] ? ruleView(rows[0]) : null;
  }
}

export type OwnConsentView = {
  readonly dataClass: OwnDataClass;
  readonly state: 'granted' | 'withdrawn';
  readonly grantedAt: string;
  readonly revokedAt: string | null;
};

interface ConsentRow {
  data_class: OwnDataClass;
  granted_at: Date;
  revoked_at: Date | null;
}
const consentView = (row: ConsentRow): OwnConsentView => ({
  dataClass: row.data_class,
  state: row.revoked_at === null ? 'granted' : 'withdrawn',
  grantedAt: row.granted_at.toISOString(),
  revokedAt: row.revoked_at?.toISOString() ?? null,
});

/** The person's consents for one agent, one row per class, keyed `agents:consent:<user>:<agent>:<class>`. */
export class OwnConsentStore {
  constructor(private readonly sql: Sql) {}

  /** A repeated grant returns the stored row; a grant after a revoke grants again from now. */
  async grant(ownerId: string, agentId: string, dataClass: OwnDataClass): Promise<OwnConsentView> {
    const rows = await this.sql<ConsentRow[]>`
      INSERT INTO agents.own_agent_consents (agent_id, owner_id, data_class, consent_key)
      VALUES (${agentId}, ${ownerId}, ${dataClass}, ${`agents:consent:${ownerId}:${agentId}:${dataClass}`})
      ON CONFLICT (owner_id, agent_id, data_class) DO UPDATE
        SET granted_at = CASE WHEN own_agent_consents.revoked_at IS NULL THEN own_agent_consents.granted_at ELSE now() END,
            revoked_at = NULL,
            updated_at = CASE WHEN own_agent_consents.revoked_at IS NULL THEN own_agent_consents.updated_at ELSE now() END
      RETURNING data_class, granted_at, revoked_at
    `;
    return consentView(rows[0]!);
  }

  /** Withdraws a class; one never granted is not one to withdraw. A repeated revoke returns the stored row. */
  async revoke(ownerId: string, agentId: string, dataClass: OwnDataClass): Promise<OwnConsentView> {
    const rows = await this.sql<ConsentRow[]>`
      UPDATE agents.own_agent_consents
         SET revoked_at = COALESCE(revoked_at, now()),
             updated_at = CASE WHEN revoked_at IS NULL THEN now() ELSE updated_at END
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId} AND data_class = ${dataClass}
      RETURNING data_class, granted_at, revoked_at
    `;
    if (!rows[0]) throw new OwnAgentRefusal('agents.consent_not_granted', { dataClass });
    return consentView(rows[0]);
  }

  async list(ownerId: string, agentId: string): Promise<OwnConsentView[]> {
    const rows = await this.sql<ConsentRow[]>`
      SELECT data_class, granted_at, revoked_at FROM agents.own_agent_consents
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
       ORDER BY data_class
    `;
    return rows.map(consentView);
  }

  async granted(ownerId: string, agentId: string, dataClass: OwnDataClass): Promise<boolean> {
    const rows = await this.sql<{ ok: boolean }[]>`
      SELECT true AS ok FROM agents.own_agent_consents
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId} AND data_class = ${dataClass} AND revoked_at IS NULL
    `;
    return rows.length > 0;
  }
}

export type OwnApprovalRequestView = {
  readonly id: string;
  readonly sessionId: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, string>>;
  readonly status: 'waiting';
  readonly ruleId: string | null;
  readonly createdAt: string;
};

interface RequestRow {
  id: string;
  session_id: string;
  tool: string;
  input_json: Record<string, string>;
  status: 'waiting';
  rule_id: string | null;
  created_at: Date;
}
const requestView = (row: RequestRow): OwnApprovalRequestView => ({
  id: row.id,
  sessionId: row.session_id,
  tool: row.tool,
  input: row.input_json,
  status: row.status,
  ruleId: row.rule_id,
  createdAt: row.created_at.toISOString(),
});

/**
 * Tool calls a rule held for the person: the tool has not run. One per `agents:approve:<session>:<request id>`, so a
 * retried call is the same request, never a second one.
 */
export class OwnApprovalRequestStore {
  constructor(private readonly sql: Sql) {}

  async hold(input: {
    ownerId: string;
    agentId: string;
    sessionId: string;
    requestId: string;
    tool: string;
    args: Readonly<Record<string, string>>;
    ruleId: string | null;
  }): Promise<OwnApprovalRequestView> {
    const key = `agents:approve:${input.sessionId}:${input.requestId}`;
    const inserted = await this.sql<RequestRow[]>`
      INSERT INTO agents.own_agent_approval_requests (agent_id, owner_id, session_id, tool, input_json, rule_id, request_key)
      VALUES (${input.agentId}, ${input.ownerId}, ${input.sessionId}, ${input.tool}, ${this.sql.json({ ...input.args })},
              ${input.ruleId}, ${key})
      ON CONFLICT (owner_id, request_key) DO NOTHING
      RETURNING id, session_id::text, tool, input_json, status, rule_id::text, created_at
    `;
    if (inserted[0]) return requestView(inserted[0]);
    const stored = await this.sql<RequestRow[]>`
      SELECT id, session_id::text, tool, input_json, status, rule_id::text, created_at
        FROM agents.own_agent_approval_requests WHERE owner_id = ${input.ownerId} AND request_key = ${key}
    `;
    const row = stored[0]!;
    // The same key for another tool or agent is not a retry of this call.
    if (row.tool !== input.tool) throw new OwnAgentRefusal('agents.request_id_replay');
    return requestView(row);
  }

  async list(ownerId: string, agentId: string, limit: number): Promise<OwnApprovalRequestView[]> {
    const rows = await this.sql<RequestRow[]>`
      SELECT id, session_id::text, tool, input_json, status, rule_id::text, created_at
        FROM agents.own_agent_approval_requests
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
       ORDER BY created_at DESC, id
       LIMIT ${limit}
    `;
    return rows.map(requestView);
  }
}
