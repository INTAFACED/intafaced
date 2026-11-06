import type { Sql } from 'postgres';
import { OWN_AGENT_DATA_CLASSES, OWN_AGENT_RULE_CHOICES, type OwnAgentApprovalStatus } from '@intafaced/contracts/agents-own';
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
export const RULE_CHOICES = OWN_AGENT_RULE_CHOICES;
export type RuleChoice = (typeof RULE_CHOICES)[number];
export const DATA_CLASSES = OWN_AGENT_DATA_CLASSES;

const looseness = (choice: RuleChoice): number => RULE_CHOICES.indexOf(choice);
/** The stricter of two standing choices. */
export const stricter = (a: RuleChoice, b: RuleChoice): RuleChoice => (looseness(a) <= looseness(b) ? a : b);

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

export type OwnApprovalStatus = OwnAgentApprovalStatus;
export type OwnApprovalRefusal =
  'agents.approval.rejected' | 'agents.approval.expired' | 'agents.approval.replaced' | 'agents.approval.failed';

export type OwnApprovalRequestView = {
  readonly id: string;
  readonly sessionId: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, string>>;
  readonly status: OwnApprovalStatus;
  readonly refusalCode: OwnApprovalRefusal | null;
  readonly failureCode: string | null;
  readonly ruleId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  /** Who approved or rejected it: the person, or the automatic reviewer's proceed (AG-approvals-02). */
  readonly decidedBy: 'person' | 'reviewer' | null;
  readonly replacedBy: string | null;
  readonly result: unknown;
  readonly ranAt: string | null;
};

interface RequestRow {
  id: string;
  session_id: string;
  tool: string;
  input_json: Record<string, string>;
  /** As read: a waiting request past its expiry reads `expired` (`STATUS` below). */
  status: OwnApprovalStatus;
  rule_id: string | null;
  created_at: Date;
  expires_at: Date;
  decided_at: Date | null;
  decided_by: 'person' | 'reviewer' | null;
  replaced_by: string | null;
  result_json: unknown;
  ran_at: Date | null;
  failure_code: string | null;
}

/** The typed refusal each closed state answers the agent's call with. */
const REFUSAL_OF: Readonly<Partial<Record<OwnApprovalStatus, OwnApprovalRefusal>>> = {
  rejected: 'agents.approval.rejected',
  expired: 'agents.approval.expired',
  replaced: 'agents.approval.replaced',
  failed: 'agents.approval.failed',
};

/** Why a decision on a request in this state is refused: a closed state's own code, or already decided. */
const refusalFor = (status: OwnApprovalStatus) =>
  status === 'approved' ? ('agents.approval.decided' as const) : (REFUSAL_OF[status] ?? ('agents.approval.not_found' as const));

/** The stored call is this one: the same tool and exactly the same input. */
function sameInput(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const sorted = (args: Readonly<Record<string, string>>) => JSON.stringify(Object.entries(args).sort(([x], [y]) => x.localeCompare(y)));
  return sorted(a) === sorted(b);
}
const sameCall = (row: RequestRow, tool: string, args: Readonly<Record<string, string>>): boolean =>
  row.tool === tool && sameInput(row.input_json, args);

const requestView = (row: RequestRow): OwnApprovalRequestView => ({
  id: row.id,
  sessionId: row.session_id,
  tool: row.tool,
  input: row.input_json,
  status: row.status,
  refusalCode: REFUSAL_OF[row.status] ?? null,
  failureCode: row.failure_code,
  ruleId: row.rule_id,
  createdAt: row.created_at.toISOString(),
  expiresAt: row.expires_at.toISOString(),
  decidedAt: row.decided_at?.toISOString() ?? null,
  decidedBy: row.decided_by,
  replacedBy: row.replaced_by,
  result: row.result_json ?? null,
  ranAt: row.ran_at?.toISOString() ?? null,
});

/**
 * How long a held request waits for the person, in whole seconds (`AGENTS_APPROVAL_TTL_SECONDS`, an owner value).
 * Blank refuses holding any call with `agents.approval.ttl_unset`: nothing is stored and the tool does not run.
 */
export function approvalTtl(seconds: number | null | undefined): number {
  if (!seconds) throw new OwnAgentRefusal('agents.approval.ttl_unset');
  return seconds;
}

/** A tool call the person approved: what it runs, once. `requestId` is the key its door dedupes on. */
export type ApprovedCall = { readonly request: OwnApprovalRequestView; readonly dataClass: OwnDataClass };

/**
 * Tool calls a rule held for the person, and the person's decisions on them (AG-approvals-01). One request per
 * `agents:approve:<session>:<request id>`, so a retried call is the same request, never a second one. A request waits
 * until its expiry and then reads expired; a decision on a request that is not waiting refuses with its state's code,
 * so nothing decided is decided again, and an expired request can never be approved (it fails closed).
 */
export class OwnApprovalRequestStore {
  constructor(private readonly sql: Sql) {}

  /** Every column as read, with a waiting request past its expiry read as `expired`. */
  private readonly columns = () => this.sql`
    id, session_id::text AS session_id, tool, input_json,
    CASE WHEN status = 'waiting' AND expires_at <= now() THEN 'expired' ELSE status END AS status,
    rule_id::text AS rule_id, created_at, expires_at, decided_at, decided_by, replaced_by::text AS replaced_by, result_json, ran_at, failure_code
  `;

  async hold(input: {
    ownerId: string;
    agentId: string;
    sessionId: string;
    requestId: string;
    tool: string;
    args: Readonly<Record<string, string>>;
    ruleId: string | null;
    ttlSeconds: number;
    /**
     * False when the automatic reviewer decides the request (AG-approvals-02): it is stored as already announced, so no
     * notice tells the person about a call that is not theirs to decide.
     */
    notifyPerson?: boolean;
  }): Promise<OwnApprovalRequestView> {
    const key = `agents:approve:${input.sessionId}:${input.requestId}`;
    const publishedAt = input.notifyPerson === false ? this.sql`now()` : this.sql`NULL`;
    const inserted = await this.sql<RequestRow[]>`
      INSERT INTO agents.own_agent_approval_requests
        (agent_id, owner_id, session_id, tool, input_json, rule_id, request_key, expires_at, published_at)
      VALUES (${input.agentId}, ${input.ownerId}, ${input.sessionId}, ${input.tool}, ${this.sql.json({ ...input.args })},
              ${input.ruleId}, ${key}, now() + make_interval(secs => ${input.ttlSeconds}), ${publishedAt})
      ON CONFLICT (owner_id, request_key) DO NOTHING
      RETURNING ${this.columns()}
    `;
    if (inserted[0]) return requestView(inserted[0]);
    const row = await this.byKey(input.ownerId, key);
    // The same key for another tool or other input is not a retry of this call.
    if (!row || !sameCall(row, input.tool, input.args)) throw new OwnAgentRefusal('agents.request_id_replay');
    return requestView(row);
  }

  private async byKey(ownerId: string, key: string): Promise<RequestRow | null> {
    const rows = await this.sql<RequestRow[]>`
      SELECT ${this.columns()} FROM agents.own_agent_approval_requests WHERE owner_id = ${ownerId} AND request_key = ${key}
    `;
    return rows[0] ?? null;
  }

  /** One request of the person's, as it reads now; another person's, or none, refuses as not found. */
  async get(ownerId: string, id: string): Promise<OwnApprovalRequestView & { agentId: string }> {
    const rows = await this.sql<Array<RequestRow & { agent_id: string }>>`
      SELECT ${this.columns()}, agent_id::text AS agent_id FROM agents.own_agent_approval_requests
       WHERE owner_id = ${ownerId} AND id = ${id}
    `;
    if (!rows[0]) throw new OwnAgentRefusal('agents.approval.not_found');
    return { ...requestView(rows[0]), agentId: rows[0].agent_id };
  }

  /**
   * The request a call's key already holds, or null. The same key for another tool or other input refuses
   * `agents.request_id_replay`, so a reused id never stands in for a different call.
   */
  async find(
    ownerId: string,
    sessionId: string,
    requestId: string,
    tool: string,
    args: Readonly<Record<string, string>>,
  ): Promise<{ request: OwnApprovalRequestView; dataClass: OwnDataClass } | null> {
    const row = await this.byKey(ownerId, `agents:approve:${sessionId}:${requestId}`);
    if (!row) return null;
    if (!sameCall(row, tool, args)) throw new OwnAgentRefusal('agents.request_id_replay');
    return { request: requestView(row), dataClass: dataClassOf(row.tool) };
  }

  /**
   * Approves a waiting request: it becomes the one call that may run. A request already approved is returned as it is
   * (its first result, or none yet if its run did not finish, so the caller runs it again on the same key). One that
   * is rejected, expired or replaced refuses with that state's code and is never approved.
   */
  async approve(
    ownerId: string,
    id: string,
    by: 'person' | 'reviewer' = 'person',
  ): Promise<{ call: ApprovedCall; alreadyApproved: boolean }> {
    const claimed = await this.sql<RequestRow[]>`
      UPDATE agents.own_agent_approval_requests SET status = 'approved', decided_at = now(), decided_by = ${by}, updated_at = now()
       WHERE owner_id = ${ownerId} AND id = ${id} AND status = 'waiting' AND expires_at > now()
      RETURNING ${this.columns()}
    `;
    if (claimed[0]) return { call: { request: requestView(claimed[0]), dataClass: dataClassOf(claimed[0].tool) }, alreadyApproved: false };
    const stored = await this.settle(ownerId, id);
    if (stored.status !== 'approved') throw new OwnAgentRefusal(refusalFor(stored.status));
    return { call: { request: stored, dataClass: dataClassOf(stored.tool) }, alreadyApproved: true };
  }

  /**
   * Claims the one run of an approved request that has no result yet: true for exactly one caller at a time. A claim
   * left by a run that crashed lapses after two minutes, and the next approve runs it again on the same door key.
   */
  async claimRun(ownerId: string, id: string): Promise<boolean> {
    const rows = await this.sql`
      UPDATE agents.own_agent_approval_requests SET running_since = now(), updated_at = now()
       WHERE owner_id = ${ownerId} AND id = ${id} AND status = 'approved' AND result_json IS NULL
         AND (running_since IS NULL OR running_since < now() - interval '2 minutes')
      RETURNING id
    `;
    return rows.length === 1;
  }

  /** Lets the run be claimed again at once: the door could not be reached, so approving again retries it. */
  async releaseRun(ownerId: string, id: string): Promise<void> {
    await this.sql`
      UPDATE agents.own_agent_approval_requests SET running_since = NULL, updated_at = now()
       WHERE owner_id = ${ownerId} AND id = ${id} AND status = 'approved' AND result_json IS NULL
    `;
  }

  /** Keeps an approved request's first result; a later result for the same request never replaces it. */
  async recordResult(ownerId: string, id: string, result: unknown): Promise<OwnApprovalRequestView> {
    await this.sql`
      UPDATE agents.own_agent_approval_requests
         SET result_json = ${this.sql.json(result as never)}, ran_at = now(), running_since = NULL, updated_at = now()
       WHERE owner_id = ${ownerId} AND id = ${id} AND status = 'approved' AND result_json IS NULL
    `;
    return this.get(ownerId, id);
  }

  /**
   * Ends an approved request whose door refused it for good (a missing or closed request at the desk): it reads failed
   * with the door's code, so the agent's call reads that refusal and nothing is retried.
   */
  async fail(ownerId: string, id: string, code: string): Promise<OwnApprovalRequestView> {
    await this.sql`
      UPDATE agents.own_agent_approval_requests
         SET status = 'failed', failure_code = ${code}, running_since = NULL, updated_at = now()
       WHERE owner_id = ${ownerId} AND id = ${id} AND status = 'approved' AND result_json IS NULL
    `;
    return this.get(ownerId, id);
  }

  /**
   * The request as the agent's call reads it: a request the person replaced by an edit is followed to its replacement,
   * so the agent reads the outcome of what the person decided (waiting, ran, or its refusal).
   */
  async latest(ownerId: string, request: OwnApprovalRequestView): Promise<OwnApprovalRequestView> {
    let current = request;
    for (let hops = 0; current.status === 'replaced' && current.replacedBy && hops < 20; hops += 1) {
      current = await this.get(ownerId, current.replacedBy);
    }
    return current;
  }

  /** Rejects a waiting request; rejecting it again returns it. Any other state refuses with its code. */
  async reject(ownerId: string, id: string): Promise<OwnApprovalRequestView> {
    const rejected = await this.sql<RequestRow[]>`
      UPDATE agents.own_agent_approval_requests SET status = 'rejected', decided_at = now(), decided_by = 'person', updated_at = now()
       WHERE owner_id = ${ownerId} AND id = ${id} AND status = 'waiting' AND expires_at > now()
      RETURNING ${this.columns()}
    `;
    if (rejected[0]) return requestView(rejected[0]);
    const stored = await this.settle(ownerId, id);
    if (stored.status === 'rejected') return stored;
    throw new OwnAgentRefusal(refusalFor(stored.status));
  }

  /**
   * Replaces a waiting request with a new one for the edited input, in one transaction: the old one reads replaced and
   * can never be approved, and the new one waits for its own approval, with its own expiry. Editing the same request
   * again with the same input returns the same new request; with other input it refuses as already replaced.
   */
  async edit(
    ownerId: string,
    id: string,
    args: Readonly<Record<string, string>>,
    ttlSeconds: number,
  ): Promise<{ replaced: OwnApprovalRequestView; request: OwnApprovalRequestView }> {
    return this.sql.begin(async (tx) => {
      const store = new OwnApprovalRequestStore(tx as unknown as Sql);
      const locked = await tx<Array<RequestRow & { agent_id: string; owner_id: string }>>`
        SELECT ${store.columns()}, agent_id::text AS agent_id FROM agents.own_agent_approval_requests
         WHERE owner_id = ${ownerId} AND id = ${id} FOR UPDATE
      `;
      const old = locked[0];
      if (!old) throw new OwnAgentRefusal('agents.approval.not_found');
      if (old.status === 'replaced' && old.replaced_by) {
        const next = await store.get(ownerId, old.replaced_by);
        if (sameInput(next.input, args)) return { replaced: requestView(old), request: next };
      }
      if (old.status !== 'waiting') throw new OwnAgentRefusal(refusalFor(old.status));
      const fresh = await tx<RequestRow[]>`
        INSERT INTO agents.own_agent_approval_requests
          (agent_id, owner_id, session_id, tool, input_json, rule_id, request_key, expires_at)
        VALUES (${old.agent_id}, ${ownerId}, ${old.session_id}, ${old.tool}, ${tx.json({ ...args })}, ${old.rule_id},
                ${`agents:approve-edit:${old.id}`}, now() + make_interval(secs => ${ttlSeconds}))
        RETURNING ${store.columns()}
      `;
      const request = fresh[0]!;
      const replaced = await tx<RequestRow[]>`
        UPDATE agents.own_agent_approval_requests
           SET status = 'replaced', replaced_by = ${request.id}, decided_at = now(), updated_at = now()
         WHERE owner_id = ${ownerId} AND id = ${id}
        RETURNING ${store.columns()}
      `;
      return { replaced: requestView(replaced[0]!), request: requestView(request) };
    });
  }

  /** A request as it reads now; one past its expiry is stored as expired, so it reads the same however it is read. */
  private async settle(ownerId: string, id: string): Promise<OwnApprovalRequestView> {
    await this.sql`
      UPDATE agents.own_agent_approval_requests SET status = 'expired', decided_at = expires_at, updated_at = now()
       WHERE owner_id = ${ownerId} AND id = ${id} AND status = 'waiting' AND expires_at <= now()
    `;
    return this.get(ownerId, id);
  }

  /**
   * The Approvals inbox (AG-approvals-01): every request a rule held for the person, across all their own agents, with
   * the agent each belongs to and its state: the ones still waiting first, so a page never pushes one off, then newest. Only the person's own rows: the owner is in every
   * condition.
   */
  async inbox(ownerId: string, limit: number): Promise<Array<OwnApprovalRequestView & { agentId: string; agentName: string }>> {
    const rows = await this.sql<Array<RequestRow & { agent_id: string; agent_name: string }>>`
      SELECT r.*, a.name AS agent_name
        FROM (SELECT ${this.columns()}, agent_id FROM agents.own_agent_approval_requests WHERE owner_id = ${ownerId}) r
        JOIN agents.own_agents a ON a.id = r.agent_id AND a.owner_id = ${ownerId}
       ORDER BY (r.status = 'waiting') DESC, r.created_at DESC, r.id
       LIMIT ${limit}
    `;
    return rows.map((row) => ({ ...requestView(row), agentId: String(row.agent_id), agentName: row.agent_name }));
  }

  /** The requests of one agent still waiting for the person (not expired), newest first: the held calls its Live runs list. */
  async waiting(ownerId: string, agentId: string, limit: number): Promise<OwnApprovalRequestView[]> {
    const rows = await this.sql<RequestRow[]>`
      SELECT ${this.columns()} FROM agents.own_agent_approval_requests
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId} AND status = 'waiting' AND expires_at > now()
       ORDER BY created_at DESC, id
       LIMIT ${limit}
    `;
    return rows.map(requestView);
  }

  async list(ownerId: string, agentId: string, limit: number): Promise<OwnApprovalRequestView[]> {
    const rows = await this.sql<RequestRow[]>`
      SELECT ${this.columns()} FROM agents.own_agent_approval_requests
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
       ORDER BY created_at DESC, id
       LIMIT ${limit}
    `;
    return rows.map(requestView);
  }
}

function dataClassOf(tool: string): OwnDataClass {
  const dataClass = OWN_TOOLS.find((entry) => entry.name === tool)?.dataClass;
  if (!dataClass) throw new OwnAgentRefusal('agents.tool_not_declared', { tool });
  return dataClass;
}
