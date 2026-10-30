import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { AgentsTeamHeldAction, AgentsTeamUsage } from '@intafaced/contracts';
import { evaluateToolCall, EMPTY_SESSION_STATE, type Guardrail } from '../fleet/guardrails.js';
import { windowCost, type UsageGroup } from '../metering/pricing.js';
import { readOwnCaps } from '../own/limits.js';
import { OwnAgentRefusal } from '../own/catalog.js';
import { ownGuardrail, OWN_RUN_TASK } from '../own/routes.js';
import { OwnAgentStore, type OwnAgentView } from '../own/store.js';
import type { AgentRuntime } from '../runtime.js';
import { TeamError } from './errors.js';
import { TEAM_RUN_KEY_PREFIX } from './hold.js';
import type { TeamMembershipPort } from './membership.js';
import { lockBusiness, MANAGERS, readTeam, requireRole, effectiveRoles, TeamStore, type Team } from './store.js';

/**
 * A business team's runs, held actions and usage (AG-governance-01, AG-usage-03). Each call reads the team from
 * svc-bank first, so a member removed from the business is refused at their next call, and checks the team role the
 * call needs as it stands now (deny wins). A run is a run of the member's own agent: metered per usage window and
 * charged to the member's own account on that window's key; the business pool only limits it (team/hold.ts).
 */

interface HeldRow {
  id: string;
  own_agent_id: string;
  creator_user_id: string;
  tool: string;
  status: 'held' | 'approved';
  approved_by: string | null;
}

const heldView = (row: HeldRow): AgentsTeamHeldAction => ({
  id: row.id,
  agentId: row.own_agent_id,
  creatorUserId: row.creator_user_id,
  tool: row.tool,
  heldBy: 'agents.approval_required',
  status: row.status,
  approvedBy: row.approved_by,
});

export class TeamRuns {
  constructor(
    private readonly sql: Sql,
    private readonly membership: TeamMembershipPort,
    private readonly runtime: AgentRuntime,
    private readonly feeAssetId: string,
  ) {}

  private team(userId: string, businessId: string): Promise<Team> {
    return readTeam(this.membership, userId, businessId);
  }

  /** The member's own agent; any other is one answer, so no oracle for others' agents. */
  private async ownAgent(userId: string, agentId: string): Promise<OwnAgentView> {
    try {
      return await new OwnAgentStore(this.sql).get(userId, agentId);
    } catch (err) {
      if (err instanceof OwnAgentRefusal) throw new TeamError('No such agent of yours', 'agents.team_agent_not_found');
      throw err;
    }
  }

  /** The member's team session on this business, or refused `agents.team_session_not_found`. */
  private async teamSession(team: Team, userId: string, sessionId: string): Promise<{ ownAgentId: string }> {
    const [row] = await this.sql<Array<{ own_agent_id: string }>>`
      SELECT own_agent_id FROM agents.team_sessions
       WHERE session_id = ${sessionId} AND business_id = ${team.businessId} AND member_user_id = ${userId}
    `;
    if (!row) throw new TeamError('No such team session of yours', 'agents.team_session_not_found');
    return { ownAgentId: row.own_agent_id };
  }

  /**
   * Opens a run session of one of the member's own agents on the business pool. Needs the runner role. Refused, with
   * no session made, until the agent's own caps are set: nothing runs uncapped.
   */
  async open(input: { userId: string; businessId: string; agentId: string }) {
    const team = await this.team(input.userId, input.businessId);
    await requireRole(this.sql, team, input.userId, 'runner');
    const agent = await this.ownAgent(input.userId, input.agentId);
    if (!(await readOwnCaps(this.sql, input.userId, agent.id))) throw new OwnAgentRefusal('agents.spend.cap_unset');
    const session = await this.runtime.openOwnSession({ userId: input.userId, guardrail: ownGuardrail(agent) });
    await this.sql`
      INSERT INTO agents.team_sessions (session_id, business_id, member_user_id, own_agent_id)
      VALUES (${session.id}, ${team.businessId}, ${input.userId}, ${agent.id})
    `;
    return { sessionId: session.id, agentId: agent.id, businessId: team.businessId };
  }

  /** One run on a team session, as the member asks it now: still on the business and still a runner. */
  async run(input: { userId: string; businessId: string; sessionId: string; requestId: string; ask: string }) {
    const team = await this.team(input.userId, input.businessId);
    await requireRole(this.sql, team, input.userId, 'runner');
    const { ownAgentId } = await this.teamSession(team, input.userId, input.sessionId);
    const agent = await this.ownAgent(input.userId, ownAgentId);
    const result = await this.runtime.think({
      sessionId: input.sessionId,
      requestId: `${TEAM_RUN_KEY_PREFIX}${input.requestId}`,
      task: OWN_RUN_TASK,
      ...(agent.instructions.trim() ? { system: agent.instructions } : {}),
      messages: [{ role: 'user', content: input.ask }],
    });
    return {
      text: result.text,
      cost: formatAmount(result.cost),
      assetId: this.feeAssetId,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    };
  }

  /**
   * Closes the member's team session once its windows are settled, each charged to their own account on its own key.
   * Settling what was already used does not wait on membership: a member removed since still pays what they ran.
   */
  async close(input: { userId: string; sessionId: string }) {
    const [row] = await this.sql<Array<{ session_id: string }>>`
      SELECT session_id::text FROM agents.team_sessions WHERE session_id = ${input.sessionId} AND member_user_id = ${input.userId}
    `;
    if (!row) throw new TeamError('No such team session of yours', 'agents.team_session_not_found');
    const closed = await this.runtime.closeSettled(input.sessionId);
    return { sessionId: closed.id, status: 'closed' as const, closedAt: (closed.closedAt ?? new Date()).toISOString() };
  }

  /**
   * Proposes a tool action of the member's own agent for the team: its guardrail holds it (`agents.approval_required`)
   * until an approver who is not its creator approves it. Needs the creator role. Held action `seq` of the business has
   * the key `agents:hold:<business>:<seq>`; the same proposal again is a replay, any other with a used number stale.
   */
  async hold(input: { userId: string; businessId: string; agentId: string; tool: string; seq: number }) {
    const team = await this.team(input.userId, input.businessId);
    await requireRole(this.sql, team, input.userId, 'creator');
    const agent = await this.ownAgent(input.userId, input.agentId);
    // On a team, every tool of an agent asks for approval before it runs.
    const base = ownGuardrail(agent);
    const guardrail: Guardrail = { ...base, tools: base.tools.map((tool) => ({ ...tool, requiresApproval: true })) };
    const decision = evaluateToolCall(guardrail, EMPTY_SESSION_STATE, { tool: input.tool });
    if (decision.allowed || decision.code !== 'agents.approval_required') {
      throw new TeamError(`${input.tool} is not one of this agent's tools`, 'agents.team_tool_not_declared');
    }
    const key = `agents:hold:${team.businessId}:${input.seq}`;
    return transaction(this.sql, async (tx) => {
      await lockBusiness(tx, team.businessId);
      const [same] = await tx<HeldRow[]>`
        SELECT id::text, own_agent_id, creator_user_id, tool, status, approved_by FROM agents.team_held_actions
         WHERE idempotency_key = ${key}
      `;
      if (same) {
        if (same.own_agent_id !== agent.id || same.creator_user_id !== input.userId || same.tool !== input.tool) {
          throw new TeamError('The team changed since this was read; read it again', 'agents.team_change_stale');
        }
        return { action: heldView(same), replayed: true };
      }
      const [last] = await tx<Array<{ seq: number }>>`
        SELECT COALESCE(MAX(seq), 0)::int AS seq FROM agents.team_held_actions WHERE business_id = ${team.businessId}
      `;
      if (input.seq !== (last?.seq ?? 0) + 1) {
        throw new TeamError('The team changed since this was read; read it again', 'agents.team_change_stale');
      }
      const [row] = await tx<HeldRow[]>`
        INSERT INTO agents.team_held_actions (id, business_id, own_agent_id, creator_user_id, tool, seq, idempotency_key)
        VALUES (gen_random_uuid(), ${team.businessId}, ${agent.id}, ${input.userId}, ${input.tool}, ${input.seq}, ${key})
        RETURNING id::text, own_agent_id, creator_user_id, tool, status, approved_by
      `;
      return { action: heldView(row!), replayed: false };
    });
  }

  /**
   * Approves a held action. Needs the approver role, and four eyes: the agent's creator is refused
   * `agents.team_four_eyes` even when they also hold approver. Approving again as the same approver is a replay.
   */
  async approve(input: { userId: string; businessId: string; actionId: string }) {
    const team = await this.team(input.userId, input.businessId);
    await requireRole(this.sql, team, input.userId, 'approver');
    return transaction(this.sql, async (tx) => {
      await lockBusiness(tx, team.businessId);
      const [row] = await tx<HeldRow[]>`
        SELECT id::text, own_agent_id, creator_user_id, tool, status, approved_by FROM agents.team_held_actions
         WHERE id = ${input.actionId}::uuid AND business_id = ${team.businessId}
      `;
      if (!row) throw new TeamError('No such held action', 'agents.team_action_not_found');
      if (row.creator_user_id === input.userId) {
        throw new TeamError("The agent's creator cannot approve its own action", 'agents.team_four_eyes');
      }
      if (row.status === 'approved') {
        if (row.approved_by === input.userId) return { action: heldView(row), replayed: true };
        throw new TeamError('Already approved by someone else', 'agents.team_action_closed');
      }
      const [next] = await tx<HeldRow[]>`
        UPDATE agents.team_held_actions SET status = 'approved', approved_by = ${input.userId}, approved_at = now()
         WHERE id = ${row.id}::uuid AND status = 'held'
        RETURNING id::text, own_agent_id, creator_user_id, tool, status, approved_by
      `;
      return { action: heldView(next!), replayed: false };
    });
  }

  /** The business's held actions, newest first, to any current member. */
  async actions(input: { userId: string; businessId: string; limit: number }): Promise<AgentsTeamHeldAction[]> {
    const team = await this.team(input.userId, input.businessId);
    const rows = await this.sql<HeldRow[]>`
      SELECT id::text, own_agent_id, creator_user_id, tool, status, approved_by FROM agents.team_held_actions
       WHERE business_id = ${team.businessId} ORDER BY seq DESC LIMIT ${input.limit}
    `;
    return rows.map(heldView);
  }

  /**
   * Usage by member and task from sealed windows of the business's team sessions, for current members only. Needs the
   * spend reader role, or a business admin. A window still open is not counted: only what was sealed is a total.
   */
  async usage(input: { userId: string; businessId: string }): Promise<AgentsTeamUsage> {
    const team = await this.team(input.userId, input.businessId);
    TeamStore.assertMember(team, input.userId);
    if (!MANAGERS.includes(team.myRole) && !(await effectiveRoles(this.sql, team.businessId, input.userId)).includes('spend_reader')) {
      throw new TeamError('This needs the spend_reader team role', 'agents.team_role_required');
    }
    const ids = team.members.map((m) => m.userId);
    const windows = await this.sql<Array<{ member_user_id: string; session_id: string; window_id: string; charged_amount: string }>>`
      SELECT t.member_user_id, w.session_id::text, w.window_id, w.charged_amount::text
        FROM agents.usage_windows w
        JOIN agents.team_sessions t ON t.session_id = w.session_id
       WHERE t.business_id = ${team.businessId} AND t.member_user_id = ANY(${ids}) AND w.sealed_at IS NOT NULL
    `;
    const records = windows.length
      ? await this.sql<
          Array<{
            session_id: string;
            window_id: string;
            task: string;
            input_tokens: string;
            output_tokens: string;
            input_price_per_million: string;
            output_price_per_million: string;
          }>
        >`
          SELECT r.session_id::text, r.window_id, r.task, r.input_tokens::text, r.output_tokens::text,
                 r.input_price_per_million::text, r.output_price_per_million::text
            FROM agents.usage_records r
            JOIN agents.team_sessions t ON t.session_id = r.session_id
            JOIN agents.usage_windows w ON w.session_id = r.session_id AND w.window_id = r.window_id
           WHERE t.business_id = ${team.businessId} AND t.member_user_id = ANY(${ids}) AND w.sealed_at IS NOT NULL
        `
      : [];

    let businessTotal: Amount = 0n;
    const members = team.members.map((m) => {
      const mine = windows.filter((w) => w.member_user_id === m.userId);
      let sealedTotal: Amount = 0n;
      for (const w of mine) sealedTotal += parseAmount(w.charged_amount);
      businessTotal += sealedTotal;
      const tasks = new Map<string, { inputTokens: bigint; outputTokens: bigint; cost: Amount }>();
      for (const w of mine) {
        const inWindow = records.filter((r) => r.session_id === w.session_id && r.window_id === w.window_id);
        for (const task of new Set(inWindow.map((r) => r.task))) {
          const rows = inWindow.filter((r) => r.task === task);
          const groups: UsageGroup[] = rows.map((r) => ({
            inputTokens: BigInt(r.input_tokens),
            outputTokens: BigInt(r.output_tokens),
            price: { inputPerMillion: parseAmount(r.input_price_per_million), outputPerMillion: parseAmount(r.output_price_per_million) },
          }));
          const sum = tasks.get(task) ?? { inputTokens: 0n, outputTokens: 0n, cost: 0n };
          for (const g of groups) {
            sum.inputTokens += g.inputTokens;
            sum.outputTokens += g.outputTokens;
          }
          sum.cost += windowCost(groups);
          tasks.set(task, sum);
        }
      }
      return {
        userId: m.userId,
        windows: mine.length,
        sealedTotal: formatAmount(sealedTotal),
        tasks: [...tasks.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([task, t]) => ({
            task,
            inputTokens: Number(t.inputTokens),
            outputTokens: Number(t.outputTokens),
            cost: formatAmount(t.cost),
          })),
      };
    });
    return { businessId: team.businessId, assetId: this.feeAssetId, members, sealedTotal: formatAmount(businessTotal) };
  }
}
