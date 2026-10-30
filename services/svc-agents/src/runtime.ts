import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import type { EventBus } from '@intafaced/events';
import { formatAmount, InsufficientFundsError, parseAmount, type Amount } from '@intafaced/ledger-client';
import { AgentError } from './errors.js';
import { AuditLog, type ActionKind, type AuditedAction } from './fleet/audit.js';
import {
  evaluateCompletion,
  evaluateToolCall,
  isPlaceTool,
  parseGuardrail,
  serialiseGuardrail,
  type Guardrail,
  type Refusal,
  type SessionState,
} from './fleet/guardrails.js';
import { digestOfText, type ModelGateway } from './gateway/gateway.js';
import type { RouteDef } from './gateway/routing.js';
import { type SettlementResult, type UsageMeter, type UsageWindowView } from './metering/meter.js';
import { meteringOffSettlementStub, shouldMeterUsage } from './metering/product-law.js';
import { usageCost } from './metering/pricing.js';
import type { TokenUsage } from './providers/provider.js';
import type { SpendGate } from './spend/gate.js';
import { UserSpendStore } from './spend/store.js';
import { withEngineSpan } from './tracing.js';

/**
 * THE FLEET RUNTIME (§8.2).
 *
 * This is the thing the agents run on. It is not an agent, and there are no
 * agents in this service — Navigator, Support and Market Scanner are separate
 * work that lands on top of these five methods:
 *
 *   openSession → think → act → settle → closeSession
 *
 * Every one of them writes to `agent_actions` before returning, including the
 * ones that refuse. §8.2's Agentic Law is "every action → agent_actions table +
 * user-visible log", and the word doing the work in that sentence is *every*:
 * an agent that only logs what succeeded produces a record in which nothing
 * ever went wrong.
 *
 * ── The order of operations, and why it is this order ───────────────────────
 *
 *   1. Resolve the route. A task with no route is a configuration fault, and it
 *      is logged as a failed action rather than thrown quietly — otherwise the
 *      session's log would show a gap where a user asked for something.
 *   2. Evaluate the guardrail. BEFORE the engine or the tool is touched. A
 *      refusal recorded after execution is a post-mortem, not a guardrail.
 *   3. Execute.
 *   4. Meter and audit in ONE transaction. A usage record without its action,
 *      or an action without its usage, is a discrepancy nobody can resolve
 *      afterwards — so they commit together or not at all.
 *
 * Step 4 is also why a provider failure cannot double-charge: nothing is
 * metered until the provider has returned usage, and a failure never reaches
 * step 4 at all.
 */

export interface AgentRuntimeOptions {
  /** Asset metered usage is billed in. */
  readonly feeAssetId: string;
  /**
   * Operator kill-switch for billing (§14 admin controls).
   *
   * When off (D26-P1-A6 product law, sealed): audit-only forever — no
   * `usage_records` row, no usage window, no `feeCharge`. The completion still
   * lands on the action audit with token counts so operators can see what the
   * fleet spent while billing was dark. Dual-write of `usage_records` while
   * metering is off is forbidden — see `metering/product-law.ts`.
   *
   * Omitted / undefined is fail-closed (must NOT bill). Never `?? true`.
   */
  readonly meteringEnabled?: boolean;
  /**
   * User spend caps. Absent only in tests that exercise the guardrail ceiling
   * alone. When set, a run with no user limit refuses before the provider.
   */
  readonly spend?: SpendGate;
  /**
   * The person's available balance in the fee asset, read before the engine is called. Absent only in tests that do
   * not exercise funds; production wires the ledger's balance read.
   */
  readonly funds?: { available(userId: string, assetId: string): Promise<Amount> };
  /**
   * AGENTS_TRANSCRIPT_RETENTION_DAYS: how many days an executed engine call's prompt text is kept for an operator's
   * transcript read. Null (blank) or 0 keeps nothing: only the digests are on the action row.
   */
  readonly transcriptRetentionDays?: number | null;
  /**
   * AGENTS_OVERAGE_GRACE: how much usage a person may leave unpaid and still start a run, in the fee asset. An owner
   * value. Blank is null: any unpaid window refuses the next run with `agents.overage_grace_unset`, never a grace
   * nobody published.
   */
  readonly overageGrace?: Amount | null;
}

/** The agent's own stored cap per session, as the spend hold takes it. */
function agentCapOf(guardrail: Guardrail): string | null {
  return guardrail.limits.maxSpendPerSession === null ? null : formatAmount(guardrail.limits.maxSpendPerSession);
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly agentId: string;
  readonly guardrail: Guardrail;
  readonly guardrailVersion: number;
  readonly status: 'open' | 'closed';
  readonly metered: boolean;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
}

/**
 * A guardrail said no.
 *
 * Thrown, not returned, because every caller must stop — and it carries the
 * audit row that was written, so a caller cannot claim the refusal went
 * unrecorded.
 */
/** Thrown inside the metering transaction so the charge rolls back. */
class SessionSpendCeilingError extends Error {
  constructor(readonly cap: Amount) {
    super('session spend ceiling');
    this.name = 'SessionSpendCeilingError';
  }
}

/** A team run's hold refusals (team/hold.ts), recorded as refusals like the own-agent caps. */
const TEAM_HOLD_REFUSALS = [
  'agents.team.allocation_exceeded',
  'agents.team.project_limit_exceeded',
  'agents.team.pool_exceeded',
  'agents.team.allocation_unset',
] as const;
const isTeamHoldRefusal = (code: string): code is (typeof TEAM_HOLD_REFUSALS)[number] =>
  (TEAM_HOLD_REFUSALS as readonly string[]).includes(code);

export class RefusedError extends AgentError {
  constructor(
    readonly refusal: Refusal,
    readonly action: AuditedAction,
  ) {
    super(`Refused by guardrail: ${refusal.code}`, 'agents.refused', refusal.userMessageKey, refusal.userMessageParams);
    this.name = 'RefusedError';
  }
}

export interface ThinkInput {
  readonly sessionId: string;
  /**
   * The caller's id for this completion.
   *
   * THE anti-double-bill handle. A caller that retries after a timeout must
   * reuse it; a caller that genuinely wants a second completion must not.
   */
  readonly requestId: string;
  readonly task: string;
  readonly system?: string;
  readonly messages: readonly { role: 'user' | 'assistant'; content: string }[];
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
  /**
   * Set only by the team run route (team/runs.ts), after it read the member's business membership and runner role. A
   * team session's hold refuses without it, so no other route can run on a team session, whatever request id it sends.
   * Never taken from a request body.
   */
  readonly teamRun?: boolean;
}

export interface ThinkResult {
  readonly text: string;
  readonly usage: TokenUsage;
  /** Derived cost of this call. The BILL is the window's, at settlement. */
  readonly cost: Amount;
  /** False when this request id had already been metered — a retry. */
  readonly metered: boolean;
  readonly windowId: string | null;
  readonly route: RouteDef;
  readonly action: AuditedAction;
}

export interface ActInput {
  readonly sessionId: string;
  readonly tool: string;
  /** The user's explicit confirmation, for tools that require one. */
  readonly approved?: boolean;
  /**
   * Stable business key for place tools. The same key on a conversational
   * repeat returns the first outcome and does not place again.
   */
  readonly idempotencyKey?: string;
  /** The tool itself. Called only after the guardrail has allowed it. */
  readonly execute: () => Promise<unknown>;
}

export interface ActResult {
  readonly result: unknown;
  readonly action: AuditedAction;
  /** True when this call reused a prior place instead of executing again. */
  readonly replayed?: boolean;
}

interface SessionRow {
  id: string;
  user_id: string;
  agent_id: string;
  guardrail: unknown;
  guardrail_version: number;
  status: 'open' | 'closed';
  metered: boolean;
  opened_at: Date;
  closed_at: Date | null;
}

export class AgentRuntime {
  readonly audit: AuditLog;
  private readonly feeAssetId: string;
  private readonly meteringEnabled: boolean;
  private readonly spend: SpendGate | null;
  private readonly funds: AgentRuntimeOptions['funds'] | null;
  private readonly transcriptRetentionDays: number;
  private readonly overageGrace: Amount | null;

  constructor(
    private readonly sql: Sql,
    private readonly gateway: ModelGateway,
    private readonly meter: UsageMeter,
    private readonly bus: EventBus,
    options: AgentRuntimeOptions,
  ) {
    this.audit = new AuditLog(sql);
    this.feeAssetId = options.feeAssetId;
    this.meteringEnabled = options.meteringEnabled ?? false;
    this.spend = options.spend ?? null;
    this.funds = options.funds ?? null;
    this.transcriptRetentionDays = options.transcriptRetentionDays ?? 0;
    this.overageGrace = options.overageGrace ?? null;
  }

  /** The owner's overage grace as the runtime applies it; null is blank, and any unpaid window then refuses runs. */
  get overageGraceAmount(): Amount | null {
    return this.overageGrace;
  }

  // ── Agent definitions ──────────────────────────────────────────────────────

  /**
   * Declare an agent's toolset and limits.
   *
   * Parsed and re-serialised rather than stored as given: `parseGuardrail`
   * rejects contradictions (a tool in a module the agent may not act in), and a
   * contradiction in a security policy resolves however the enforcement code
   * happens to be ordered.
   */
  /**
   * Upsert a guardrail into `agent_definitions`.
   *
   * Insert defaults `enabled` to true (or `options.enabled`). On conflict,
   * **guardrail + version are refreshed; `enabled` is preserved.** Operator
   * kill (`enabled = false`) must survive boot re-register and redeploy —
   * overwriting enabled on every upsert made the kill-switch a reboot lie.
   * Re-enable is an explicit SQL / admin act on the flag, not a side-effect of
   * re-shipping the factory snapshot.
   */
  async registerAgent(input: unknown, options: { enabled?: boolean } = {}): Promise<Guardrail> {
    const guardrail = parseGuardrail(input);
    const body = serialiseGuardrail(guardrail);

    await this.sql`
      INSERT INTO agents.agent_definitions (agent_id, version, guardrail, enabled)
      VALUES (${guardrail.agentId}, ${guardrail.version}, ${this.sql.json(body as never)}, ${options.enabled ?? true})
      ON CONFLICT (agent_id) DO UPDATE
        SET version = EXCLUDED.version,
            guardrail = EXCLUDED.guardrail,
            updated_at = now()
    `;

    return guardrail;
  }

  async agentDefinition(agentId: string): Promise<{ guardrail: Guardrail; enabled: boolean } | null> {
    const rows = await this.sql<Array<{ guardrail: unknown; enabled: boolean }>>`
      SELECT guardrail, enabled FROM agents.agent_definitions WHERE agent_id = ${agentId}
    `;
    const row = rows[0];
    return row ? { guardrail: parseGuardrail(row.guardrail), enabled: row.enabled } : null;
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  /**
   * Open a session and BIND the guardrail to it.
   *
   * The guardrail is copied onto the session row. Widening an agent's powers
   * mid-session must not retroactively legitimise a call already made under
   * narrower terms — the same reason `stakes.multiplier_bps` is snapshotted in
   * svc-token.
   */
  async openSession(input: { userId: string; agentId: string; metered?: boolean }): Promise<SessionRecord> {
    const definition = await this.agentDefinition(input.agentId);
    if (!definition) {
      throw new AgentError(`No agent "${input.agentId}" is registered`, 'agents.agent_not_found', 'agents.error.route_not_found', {
        task: input.agentId,
      });
    }
    if (!definition.enabled) {
      throw new AgentError(`Agent "${input.agentId}" is disabled`, 'agents.agent_not_found', 'agents.error.engine_unavailable');
    }

    return this.insertSession(input.userId, definition.guardrail, input.metered ?? true);
  }

  /**
   * Open a session of an agent the person built (AG-builder-01). It has no registered definition: the caller builds
   * its guardrail from the agent as saved, and it is bound to the session as any other. Its id is `own.<agent id>`,
   * which no registered agent can take, so `openSession` can never open one and this can open nothing else. Its
   * spend is held against the caps the person set for that agent (`UserSpendStore.reserve`).
   */
  async openOwnSession(input: { userId: string; guardrail: Guardrail }): Promise<SessionRecord> {
    if (!input.guardrail.agentId.startsWith('own.')) {
      throw new AgentError(`"${input.guardrail.agentId}" is not an own agent`, 'agents.agent_not_found', 'agents.error.route_not_found', {
        task: input.guardrail.agentId,
      });
    }
    return this.insertSession(input.userId, input.guardrail, true);
  }

  private async insertSession(userId: string, guardrail: Guardrail, metered: boolean): Promise<SessionRecord> {
    const snapshot = serialiseGuardrail(guardrail);

    return transaction(
      this.sql,
      async (tx) => {
        const rows = await tx<SessionRow[]>`
          INSERT INTO agents.agent_sessions (user_id, agent_id, guardrail, guardrail_version, metered)
          VALUES (
            ${userId}, ${guardrail.agentId}, ${tx.json(snapshot as never)},
            ${guardrail.version}, ${metered}
          )
          RETURNING *
        `;

        const session = toSession(rows[0]!);

        await this.audit.append(tx, {
          sessionId: session.id,
          userId: session.userId,
          agentId: session.agentId,
          kind: 'session_open',
          status: 'executed',
          userMessageKey: 'agents.session.opened',
          userMessageParams: { agent: session.agentId },
        });

        return session;
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  async closeSession(sessionId: string): Promise<SessionRecord> {
    return transaction(
      this.sql,
      async (tx) => {
        const rows = await tx<SessionRow[]>`
          SELECT * FROM agents.agent_sessions WHERE id = ${sessionId} FOR UPDATE
        `;
        const row = rows[0];
        if (!row) throw new AgentError(`No session ${sessionId}`, 'agents.session_not_found', 'agents.refused.session_closed');

        if (row.status === 'closed') return toSession(row);

        const updated = await tx<SessionRow[]>`
          UPDATE agents.agent_sessions SET status = 'closed', closed_at = now() WHERE id = ${sessionId} RETURNING *
        `;

        const steps = await tx<Array<{ count: string }>>`
          SELECT count(*)::text AS count FROM agents.agent_actions
           WHERE session_id = ${sessionId} AND kind NOT IN ('session_open', 'session_close', 'usage_settlement')
        `;

        await this.audit.append(tx, {
          sessionId,
          userId: row.user_id,
          agentId: row.agent_id,
          kind: 'session_close',
          status: 'executed',
          userMessageKey: 'agents.session.closed',
          userMessageParams: { steps: Number(steps[0]?.count ?? 0) },
        });

        return toSession(updated[0]!);
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  async session(sessionId: string): Promise<SessionRecord | null> {
    const rows = await this.sql<SessionRow[]>`SELECT * FROM agents.agent_sessions WHERE id = ${sessionId}`;
    return rows[0] ? toSession(rows[0]) : null;
  }

  /**
   * What the guardrail evaluator needs to know about a session's history.
   *
   * Bookkeeping kinds are excluded from `actionCount`: an agent's action budget
   * should govern what the agent decided to do, not how many times the runtime
   * wrote a boundary marker on its behalf.
   */
  async stateOf(session: SessionRecord): Promise<SessionState> {
    const [counts, tools, spend] = await Promise.all([
      this.sql<Array<{ count: string }>>`
        SELECT count(*)::text AS count FROM agents.agent_actions
         WHERE session_id = ${session.id} AND kind NOT IN ('session_open', 'session_close', 'usage_settlement')
      `,
      this.sql<Array<{ tool: string; count: string }>>`
        SELECT tool, count(*)::text AS count FROM agents.agent_actions
         WHERE session_id = ${session.id} AND kind = 'tool_call' AND status = 'executed' AND tool IS NOT NULL
         GROUP BY tool
      `,
      this.meter.sessionSpend(session.id),
    ]);

    const toolCalls: Record<string, number> = {};
    for (const row of tools) toolCalls[row.tool] = Number(row.count);

    return {
      status: session.status,
      actionCount: Number(counts[0]?.count ?? 0),
      toolCalls,
      spend,
      // Approval is per-call today: the surface presents the confirmation and
      // passes `approved` on the request. A surface that remembers a
      // session-scoped approval supplies it here instead.
      approvedTools: [],
    };
  }

  // ── Think: a metered engine call ───────────────────────────────────────────

  async think(input: ThinkInput): Promise<ThinkResult> {
    const session = await this.requireSession(input.sessionId);

    return withEngineSpan(
      'agents.runtime.think',
      {
        operation: 'think',
        task: input.task,
        sessionId: session.id,
        agentId: session.agentId,
        userId: session.userId,
      },
      async () => this.thinkInner(session, input),
    );
  }

  private async thinkInner(session: SessionRecord, input: ThinkInput): Promise<ThinkResult> {
    // 1 · Route. A missing route is logged as a failed action rather than
    //     thrown silently — the user asked for something and the log must say so.
    let route: RouteDef;
    try {
      route = this.gateway.routeFor(input.task);
    } catch (err) {
      await this.appendFailure(session, { kind: 'completion', task: input.task, error: err });
      throw err;
    }

    // 1a · Request-id replay must not re-enter the engine free of charge.
    //
    // Usage is unique on (session, request_id). A second think with the same id
    // used to call the provider again, insert zero-cost usage (ON CONFLICT), and
    // bypass the spend cap. Once a request id has been metered, the caller opens
    // a new id — they do not get free re-inference under the old one. Checked
    // before price and funds, so a replay reads as a replay whatever the balance.
    const shouldMeter = shouldMeterUsage(session.metered, this.meteringEnabled);
    if (shouldMeter && (await this.meter.hasRequest(session.id, input.requestId))) {
      const err = new AgentError(
        `Request id "${input.requestId}" was already metered on session ${session.id}`,
        'agents.request_id_replay',
        'agents.error.request_id_replay',
        { requestId: input.requestId },
      );
      await this.appendFailure(session, { kind: 'completion', task: input.task, error: err });
      throw err;
    }

    const maxOutputTokens =
      input.maxOutputTokens === undefined ? route.maxOutputTokens : Math.min(input.maxOutputTokens, route.maxOutputTokens);
    // A route with no published rate never runs: nothing invents a price (OWNER 107). Refused before the guardrail, the
    // hold and the engine, and logged so the person can read why.
    const price = route.price;
    if (!price) {
      throw await this.appendRefusal(
        session,
        {
          allowed: false,
          code: 'agents.price_unset',
          userMessageKey: 'agents.refused.price_unset',
          userMessageParams: { task: input.task },
        },
        { kind: 'completion', task: input.task },
      );
    }
    const worstCaseCost = usageCost(
      { inputTokens: estimateInputTokens(input.system, input.messages), outputTokens: maxOutputTokens },
      price,
    );

    // 2 · Guardrail, before anything is called.
    const state = await this.stateOf(session);
    const decision = evaluateCompletion(
      session.guardrail,
      state,
      {
        task: input.task,
        maxOutputTokens,
        worstCaseCost,
      },
      this.feeAssetId,
    );

    if (!decision.allowed) {
      throw await this.appendRefusal(session, decision, { kind: 'completion', task: input.task });
    }

    // 2b · Unpaid usage. A window that could not be paid is retried first, on its own charge key, so adding funds is
    //      all a person does to recover. What still cannot be paid holds the run back unless the owner's grace covers
    //      it: blank grace refuses outright, and nothing is claimed, held or called.
    if (shouldMeter) {
      const owed = await this.retryUnpaidWindows(session.userId);
      if (owed > 0n && (this.overageGrace === null || owed > this.overageGrace)) {
        const grace = this.overageGrace;
        throw await this.appendRefusal(
          session,
          grace === null
            ? {
                allowed: false,
                code: 'agents.overage_grace_unset',
                userMessageKey: 'agents.refused.overage_grace_unset',
                userMessageParams: { owed: formatAmount(owed), asset: this.feeAssetId },
              }
            : {
                allowed: false,
                code: 'agents.overage_grace_exceeded',
                userMessageKey: 'agents.refused.overage_grace_exceeded',
                userMessageParams: { owed: formatAmount(owed), grace: formatAmount(grace), asset: this.feeAssetId },
              },
          { kind: 'completion', task: input.task },
        );
      }
    }

    // 2b' · A sealed window takes no more usage: a run in it would reach the engine and then fail to record, an engine
    //       call nobody pays for. A session whose current window was sealed (a close the ledger refused for funds, or
    //       the sweep) refuses before anything is claimed or called; a new session, or the next window, runs.
    if (shouldMeter && (await this.meter.isSealed(session.id, this.meter.windowFor(new Date())))) {
      throw await this.appendRefusal(
        session,
        { allowed: false, code: 'agents.window_sealed', userMessageKey: 'agents.refused.window_sealed', userMessageParams: {} },
        { kind: 'completion', task: input.task },
      );
    }

    // 2a · Funds. A run whose worst case the person's available balance cannot cover does not start (OWNER 107): the
    //      charge settles later, so this check narrows the windows nobody can pay. It reads the balance and holds
    //      nothing in the ledger, so a withdrawal before the window seals can still leave it unpaid (it is then
    //      retried on its charge key); a ledger hold at reserve closes that gap. A read that fails refuses too — an
    //      unknown balance is not a covered one.
    //      With a spend gate the check runs inside its reservation instead, under the per-user lock and net of what is
    //      already owed and held (2c); this path is only for a runtime wired without one.
    if (!this.spend && this.funds && shouldMeter && worstCaseCost > 0n) {
      let available: Amount | null;
      try {
        available = await this.funds.available(session.userId, this.feeAssetId);
      } catch {
        available = null;
      }
      if (available === null || available < worstCaseCost) {
        throw await this.appendRefusal(
          session,
          {
            allowed: false,
            code: available === null ? 'agents.funds_unread' : 'agents.funds_insufficient',
            userMessageKey: available === null ? 'agents.refused.funds_unread' : 'agents.refused.funds_insufficient',
            userMessageParams: { worstCase: formatAmount(worstCaseCost), asset: this.feeAssetId },
          },
          { kind: 'completion', task: input.task },
        );
      }
    }

    // The hasRequest read above is not the claim. Overlapping thinks both see
    // no usage row. The unique insert commits before the provider is called,
    // and only while metering is on — metering-off must not invent a replay.
    let claimed = false;
    if (shouldMeter) {
      claimed = await this.meter.claimRequest(session.id, input.requestId);
      if (!claimed) {
        const err = new AgentError(
          `Request id "${input.requestId}" was already metered on session ${session.id}`,
          'agents.request_id_replay',
          'agents.error.request_id_replay',
          { requestId: input.requestId },
        );
        await this.appendFailure(session, { kind: 'completion', task: input.task, error: err });
        throw err;
      }
    }

    // 2c · User cap. The worst case is the price the route already declared.
    // A blank user limit refuses. This hold is not a ledger post.
    let reserved: Amount | null = null;
    let reservationKey = input.requestId;
    const funds = this.funds;
    const fundsRead = funds && shouldMeter && worstCaseCost > 0n ? () => funds.available(session.userId, this.feeAssetId) : null;
    if (this.spend) {
      try {
        let held = await this.spend.reserve({
          userId: session.userId,
          sessionId: session.id,
          reservationKey,
          assetId: this.feeAssetId,
          amount: formatAmount(worstCaseCost),
          agentCap: agentCapOf(session.guardrail),
          overageGrace: this.overageGrace,
          teamRun: input.teamRun === true,
          ...(fundsRead ? { funds: fundsRead } : {}),
        });
        // A committed hold is a metered replay. Metering-off must not invent
        // agents.request_id_replay (D26-P1-A6).
        if (held.status === 'committed' && shouldMeter) {
          if (claimed) await this.meter.releaseClaim(session.id, input.requestId);
          throw new AgentError(
            `Request id "${input.requestId}" already reserved on session ${session.id}`,
            'agents.request_id_replay',
            'agents.error.request_id_replay',
            { requestId: input.requestId },
          );
        }
        // A committed row is a finished call. Metering-off must not invent
        // agents.request_id_replay. The next key is requestId:N, where N is
        // how many committed keys already use that id. If it does not fit,
        // reserve throws agents.spend_limit and the provider is not called.
        if (held.replayed && held.status === 'committed' && !shouldMeter) {
          const counted = await this.sql<Array<{ n: string }>>`
            SELECT count(*)::text AS n
              FROM agents.spend_reservations
             WHERE user_id = ${session.userId}
               AND status = 'committed'
               AND (
                 reservation_key = ${input.requestId}
                 OR strpos(reservation_key, ${`${input.requestId}:`}) = 1
               )
          `;
          reservationKey = `${input.requestId}:${counted[0]?.n ?? '0'}`;
          held = await this.spend.reserve({
            userId: session.userId,
            sessionId: session.id,
            reservationKey,
            assetId: this.feeAssetId,
            amount: formatAmount(worstCaseCost),
            agentCap: agentCapOf(session.guardrail),
            overageGrace: this.overageGrace,
            teamRun: input.teamRun === true,
            ...(fundsRead ? { funds: fundsRead } : {}),
          });
        }
        // One hold does not authorize a second provider call. A crashed hold
        // stays held until reconcileSpendHolds; this retry does not finish it.
        if (held.replayed && (held.status === 'held' || held.status === 'committed')) {
          if (claimed) await this.meter.releaseClaim(session.id, input.requestId);
          throw new AgentError(
            `Reservation ${reservationKey} is still held`,
            'agents.spend_reservation_conflict',
            'agents.refused.spend_reservation_conflict',
          );
        }
        reserved = parseAmount(held.amount);
      } catch (err) {
        if (claimed) await this.meter.releaseClaim(session.id, input.requestId);
        if (
          err instanceof AgentError &&
          (err.code === 'agents.spend_limit' || err.code === 'agents.spend_limit_unset' || err.code === 'agents.spend_limit_invalid')
        ) {
          throw await this.appendRefusal(
            session,
            {
              allowed: false,
              code: 'agents.spend_limit',
              userMessageKey: err.userMessageKey,
              userMessageParams: err.userMessageParams,
            },
            { kind: 'completion', task: input.task },
          );
        }
        if (
          err instanceof AgentError &&
          (err.code === 'agents.spend.cap_exceeded' || err.code === 'agents.spend.cap_unset' || isTeamHoldRefusal(err.code))
        ) {
          throw await this.appendRefusal(
            session,
            {
              allowed: false,
              code: err.code,
              userMessageKey: err.userMessageKey,
              userMessageParams: err.userMessageParams,
            },
            { kind: 'completion', task: input.task },
          );
        }
        if (err instanceof AgentError && (err.code === 'agents.funds_insufficient' || err.code === 'agents.funds_unread')) {
          throw await this.appendRefusal(
            session,
            {
              allowed: false,
              code: err.code,
              userMessageKey: err.userMessageKey,
              userMessageParams: err.userMessageParams,
            },
            { kind: 'completion', task: input.task },
          );
        }
        throw err;
      }
    }

    // 3 · Execute.
    let completion: Awaited<ReturnType<ModelGateway['complete']>>;
    try {
      completion = await this.gateway.complete(input.task, {
        ...(input.system ? { system: input.system } : {}),
        messages: input.messages,
        maxOutputTokens,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (err) {
      // Nothing was metered: usage is only recorded from a provider's own
      // reported counts, and there are none. A failed call cannot be billed,
      // and cannot be double-billed. Release the claim so the same request id
      // can be retried once the engine answers.
      if (reserved !== null && this.spend) await this.spend.release({ userId: session.userId, reservationKey });
      if (claimed) await this.meter.releaseClaim(session.id, input.requestId);
      await this.appendFailure(session, {
        kind: 'completion',
        task: input.task,
        error: err,
        providerId: route.providerId,
        model: route.model,
      });
      throw err;
    }

    const usage = completion.result.usage;
    const cost = usageCost(usage, price);

    // 4 · Meter and audit together.
    //
    // If this transaction fails, the engine ran and we could not record it. The
    // user is NOT billed — the house absorbs a call it cannot account for,
    // which is the only acceptable direction for that error. The attempt is
    // still logged, because §8.2 admits no gaps.
    const ceiling = session.guardrail.limits.maxSpendPerSession;
    // The provider can report more than the worst case that was held. Throwing
    // here used to skip the commit, so the hold stayed `held` and the meter
    // claim stayed taken. Finish the hold at the reserved amount — never the
    // larger actual cost, which the reservation rejects — drop the claim, then
    // refuse the text. The session-ceiling path below finishes its hold
    // (it releases) before it refuses.
    const spend = this.spend;
    const releaseHoldAndClaim = async (gate: NonNullable<typeof this.spend>, claim: boolean): Promise<void> => {
      const steps: Array<Promise<unknown>> = [gate.release({ userId: session.userId, reservationKey })];
      if (claim) steps.push(this.meter.releaseClaim(session.id, input.requestId));
      const results = await Promise.allSettled(steps);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    };
    if (reserved !== null && spend && cost > reserved) {
      const heldAmount = reserved;
      const commitHeld = () =>
        transaction(
          this.sql,
          async (tx) => {
            await spend.commitIn(tx, {
              userId: session.userId,
              reservationKey,
              amount: formatAmount(heldAmount),
            });
          },
          { isolation: 'read committed', maxAttempts: 5 },
        );
      try {
        await commitHeld();
      } catch (first) {
        try {
          // The provider already ran. Retry the commit only.
          await commitHeld();
        } catch (again) {
          await releaseHoldAndClaim(spend, claimed);
          throw again instanceof Error ? again : first;
        }
      }
      if (claimed) await this.meter.releaseClaim(session.id, input.requestId);
      throw await this.appendRefusal(
        session,
        {
          allowed: false,
          code: 'agents.spend_limit',
          userMessageKey: 'agents.refused.spend_cap',
          userMessageParams: { limit: formatAmount(heldAmount), asset: this.feeAssetId, scope: 'call' },
        },
        { kind: 'completion', task: input.task },
      );
    }
    const prompt = canonicalPrompt(input.system, input.messages);
    const committed = await transaction(
      this.sql,
      async (tx) => {
        let recorded = false;
        let window: string | null = null;

        // The pre-call worst-case check is not the bill. Two thinks that each
        // fit alone both pass it, then both would commit. The session row lock
        // orders the charges; a null ceiling stays null.
        if (shouldMeter && ceiling !== null) {
          await tx`SELECT id FROM agents.agent_sessions WHERE id = ${session.id} FOR UPDATE`;
          const spend = await this.meter.sessionSpend(session.id, tx);
          if (spend + cost > ceiling) throw new SessionSpendCeilingError(ceiling);
        }

        if (shouldMeter) {
          const result = await this.meter.record(tx, {
            sessionId: session.id,
            requestId: input.requestId,
            task: input.task,
            providerId: completion.result.providerId,
            model: route.model,
            usage,
            price,
          });
          recorded = result.recorded;
          window = result.windowId;
        }

        const row = await this.audit.append(tx, {
          sessionId: session.id,
          userId: session.userId,
          agentId: session.agentId,
          kind: 'completion',
          status: 'executed',
          task: input.task,
          providerId: completion.result.providerId,
          model: route.model,
          inputTokens: BigInt(usage.inputTokens),
          outputTokens: BigInt(usage.outputTokens),
          // A retried request id is logged — the engine really was called again —
          // but carries zero cost, because zero is what it added to the bill.
          cost: recorded ? cost : 0n,
          userMessageKey: 'agents.action.completed',
          userMessageParams: { task: input.task },
          inputDigest: digestOfText(prompt),
          outputDigest: digestOfText(completion.result.text),
        });
        // The prompt text whose sha256 is the row's input digest, kept for the owner's retention and no longer.
        if (this.transcriptRetentionDays > 0) await keepTranscript(tx, row.id, session.userId, prompt, this.transcriptRetentionDays);

        if (this.spend && reserved !== null) {
          // The user cap counts this call's cost even when metering is off.
          // The audit row above keeps recorded ? cost : 0n — that zero is the
          // bill, not the cap.
          await this.spend.commitIn(tx, {
            userId: session.userId,
            reservationKey,
            amount: formatAmount(cost),
          });
        }

        return { action: row, metered: recorded, windowId: window };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    ).catch(async (err: unknown) => {
      if (reserved !== null && this.spend && !(err instanceof SessionSpendCeilingError)) {
        await this.spend.release({ userId: session.userId, reservationKey });
      }
      if (err instanceof SessionSpendCeilingError) {
        if (reserved !== null && this.spend) await this.spend.release({ userId: session.userId, reservationKey });
        throw await this.appendRefusal(
          session,
          {
            allowed: false,
            code: 'agents.spend_limit',
            userMessageKey: 'agents.refused.spend_limit',
            userMessageParams: { limit: formatAmount(err.cap), asset: this.feeAssetId },
          },
          { kind: 'completion', task: input.task },
        );
      }
      await this.appendFailure(session, {
        kind: 'completion',
        task: input.task,
        error: err,
        providerId: completion.result.providerId,
        model: route.model,
      });
      throw err;
    });

    const { action, metered, windowId } = committed;

    await this.publishCompleted(action, usage);

    return { text: completion.result.text, usage, cost: metered ? cost : 0n, metered, windowId, route, action };
  }

  // ── Act: a guarded tool call ───────────────────────────────────────────────

  /**
   * Run a tool inside the session's guardrails.
   *
   * A stored place for the same session, the same key, and the same tool
   * returns that outcome without spending the call budget. Any other place
   * call is judged by the guardrail first. A place that passes is claimed in
   * `agent_place_intents` before `execute`. The loser of that insert does not
   * run the tool. A failed execute deletes the claim. A place that returned
   * does not.
   *
   * `execute` is supplied by the caller because the runtime does not own the
   * tools — §8.2's fleet calls module APIs, and this service must not grow a
   * dependency on every module in the platform to be able to police them.
   */
  async act(input: ActInput): Promise<ActResult> {
    const session = await this.requireSession(input.sessionId);
    const idempotencyKey = input.idempotencyKey?.trim();
    const placeKey = isPlaceTool(input.tool) && idempotencyKey ? idempotencyKey : undefined;

    if (placeKey) {
      const stored = await this.storedPlaceIntent(session.id, placeKey, input.tool);
      if (stored) return { result: stored.result, action: stored.action, replayed: true };
    }

    const state = await this.stateOf(session);
    const decision = evaluateToolCall(session.guardrail, state, {
      tool: input.tool,
      ...(input.approved === undefined ? {} : { approved: input.approved }),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    if (!decision.allowed) {
      throw await this.appendRefusal(session, decision, { kind: 'tool_call', tool: input.tool });
    }

    let claimed = false;
    if (placeKey) {
      const claim = await this.claimPlaceIntent(session.id, placeKey, input.tool);
      if (claim.kind === 'replay') return { result: claim.result, action: claim.action, replayed: true };
      if (claim.kind === 'conflict') {
        throw await this.appendRefusal(session, this.placeKeyConflict(input.tool), { kind: 'tool_call', tool: input.tool });
      }
      claimed = true;
    }

    let result: unknown;
    try {
      result = await input.execute();
    } catch (err) {
      if (claimed && placeKey) await this.releasePlaceClaim(session.id, placeKey, input.tool);
      await this.appendFailure(session, { kind: 'tool_call', tool: input.tool, error: err });
      throw err;
    }

    const action = await transaction(
      this.sql,
      async (tx) => {
        const row = await this.audit.append(tx, {
          sessionId: session.id,
          userId: session.userId,
          agentId: session.agentId,
          kind: 'tool_call',
          status: 'executed',
          tool: input.tool,
          userMessageKey: 'agents.action.executed',
          userMessageParams: { tool: input.tool },
          outputDigest: digestOfText(JSON.stringify(result ?? null)),
        });
        if (claimed && placeKey) {
          const updated = await tx<Array<{ session_id: string }>>`
            UPDATE agents.agent_place_intents
               SET action_id = ${row.id}, result_json = ${JSON.stringify(result ?? null)}
             WHERE session_id = ${session.id}
               AND idempotency_key = ${placeKey}
               AND tool = ${input.tool}
               AND result_json IS NULL
            RETURNING session_id
          `;
          if (updated.length === 0) throw new Error(`place intent for session ${session.id} was not stored`);
        }
        return row;
      },
      { isolation: 'read committed', maxAttempts: 5 },
    ).catch(async (err: unknown) => {
      if (claimed) {
        await this.appendFailure(session, { kind: 'tool_call', tool: input.tool, error: err });
      }
      throw err;
    });

    await this.publishCompleted(action, { inputTokens: 0, outputTokens: 0 });

    return { result, action };
  }

  private placeKeyConflict(tool: string): Refusal {
    return {
      allowed: false,
      code: 'agents.place_key_conflict',
      userMessageKey: 'agents.refused.place_key_conflict',
      userMessageParams: { tool },
    };
  }

  /** Same tool, same key, with a stored result. A different tool is not a replay. */
  private async storedPlaceIntent(
    sessionId: string,
    idempotencyKey: string,
    tool: string,
  ): Promise<{ result: unknown; action: AuditedAction } | null> {
    const rows = await this.sql<Array<{ action_id: string; result_json: string }>>`
      SELECT action_id, result_json FROM agents.agent_place_intents
       WHERE session_id = ${sessionId}
         AND idempotency_key = ${idempotencyKey}
         AND tool = ${tool}
         AND action_id IS NOT NULL
         AND result_json IS NOT NULL
    `;
    const row = rows[0];
    if (!row) return null;
    const action = await this.audit.byId(row.action_id);
    if (!action) return null;
    return { result: JSON.parse(row.result_json) as unknown, action };
  }

  /**
   * Insert the claim before execute. False means another row already holds
   * (session, key): a stored result for this tool is a replay, anything else
   * is a conflict and must not execute.
   */
  private async claimPlaceIntent(
    sessionId: string,
    idempotencyKey: string,
    tool: string,
  ): Promise<{ kind: 'claimed' } | { kind: 'conflict' } | { kind: 'replay'; result: unknown; action: AuditedAction }> {
    const inserted = await this.sql<Array<{ session_id: string }>>`
      INSERT INTO agents.agent_place_intents (session_id, idempotency_key, tool, action_id, result_json)
      VALUES (${sessionId}, ${idempotencyKey}, ${tool}, NULL, NULL)
      ON CONFLICT (session_id, idempotency_key) DO NOTHING
      RETURNING session_id
    `;
    if (inserted.length > 0) return { kind: 'claimed' };

    const rows = await this.sql<Array<{ tool: string; action_id: string | null; result_json: string | null }>>`
      SELECT tool, action_id, result_json FROM agents.agent_place_intents
       WHERE session_id = ${sessionId} AND idempotency_key = ${idempotencyKey}
    `;
    const row = rows[0];
    if (row && row.tool === tool && row.action_id && row.result_json !== null) {
      const action = await this.audit.byId(row.action_id);
      if (action) return { kind: 'replay', result: JSON.parse(row.result_json) as unknown, action };
    }
    return { kind: 'conflict' };
  }

  /** Drop a claim whose execute never returned. A stored place stays. */
  private async releasePlaceClaim(sessionId: string, idempotencyKey: string, tool: string): Promise<void> {
    await this.sql`
      DELETE FROM agents.agent_place_intents
       WHERE session_id = ${sessionId}
         AND idempotency_key = ${idempotencyKey}
         AND tool = ${tool}
         AND result_json IS NULL
    `;
  }

  /**
   * Release held reservations older than an owner-set age.
   *
   * There is no default age and no timer. A blank age refuses and releases nothing.
   */
  async reconcileSpendHolds(maxAge: string | null | undefined, now?: Date): Promise<{ released: number }> {
    const store = this.spend instanceof UserSpendStore ? this.spend : new UserSpendStore(this.sql);
    return store.releaseStaleHolds({ maxAge, now });
  }

  // ── Settle ─────────────────────────────────────────────────────────────────

  /**
   * Bill a usage window.
   *
   * The audit row is appended in the same step that records the ledger
   * transaction id, so a settlement that was posted but not yet recorded
   * resumes to exactly one charge and exactly one log line.
   *
   * When `meteringEnabled` is false (D26-P1-A6), returns the metering-off
   * settlement stub and posts nothing — leftover windows stay open for a later
   * metering-on process. No silent feeCharge.
   */
  async settleWindow(sessionId: string, windowId: string): Promise<SettlementResult> {
    const session = await this.requireSession(sessionId, { allowClosed: true });
    // D26-P1-A6: never feeCharge while metering is off — including leftover
    // windows from a prior metering-on process. When billing returns, open
    // windows are settled again; while off, inventing a charge would break the
    // audit-only forever promise.
    if (!this.meteringEnabled) {
      return meteringOffSettlementStub(sessionId, windowId);
    }
    const result = await this.meter.settle({ sessionId, userId: session.userId, windowId });

    // Only a settlement that actually happened is logged. A repeat call finds
    // the window already sealed, posts nothing, and appends nothing — one
    // charge, one log line, however many times the sweep runs.
    if (result.settled) {
      await transaction(
        this.sql,
        async (tx) =>
          this.audit.append(tx, {
            sessionId,
            userId: session.userId,
            agentId: session.agentId,
            kind: 'usage_settlement',
            status: 'executed',
            cost: result.amount,
            userMessageKey: result.amount > 0n ? 'agents.usage.settled' : 'agents.usage.free',
            userMessageParams: result.amount > 0n ? { amount: formatAmount(result.amount), asset: this.feeAssetId } : {},
          }),
        { isolation: 'read committed', maxAttempts: 5 },
      );

      if (result.amount > 0n) {
        await this.bus.publish(
          'agentUsageSettled',
          {
            sessionId,
            userId: session.userId,
            windowId,
            amount: formatAmount(result.amount),
            assetId: this.feeAssetId,
            chargeKey: result.chargeKey,
          },
          { idempotencyKey: result.chargeKey },
        );
      }
    }

    return result;
  }

  /**
   * Retry the person's sealed, unpaid windows, across their sessions, each on its own charge key, smallest first.
   * Returns what is still owed. The first window the ledger does not take (short funds, a posting freeze, the ledger
   * down) stops the retry, and it and every larger one stay unpaid and count: a payment nobody could confirm is owed,
   * so the run refuses with its typed code (and its log row) unless the owner's grace covers it.
   */
  async retryUnpaidWindows(userId: string): Promise<Amount> {
    let owed = 0n;
    let stopped = false;
    for (const window of await this.meter.unpaidWindows(userId)) {
      if (!stopped) {
        try {
          await this.settleWindow(window.sessionId, window.windowId);
          continue;
        } catch {
          stopped = true;
        }
      }
      owed += window.amount;
    }
    return owed;
  }

  /** The usage windows of one agent's sessions of a person's, newest first (see `UsageMeter.windowsOf`). */
  async usageWindowsOf(userId: string, agentId: string, limit: number): Promise<UsageWindowView[]> {
    return this.meter.windowsOf(userId, agentId, limit);
  }

  /** Settle every open window of a session. Used when a session closes. */
  async settleSession(sessionId: string): Promise<SettlementResult[]> {
    const windows = await this.meter.openWindows(sessionId);
    const results: SettlementResult[] = [];
    for (const windowId of windows) results.push(await this.settleWindow(sessionId, windowId));
    return results;
  }

  /**
   * Settle a session's windows, then close it. A window the ledger refuses for funds stays sealed and unpaid on its
   * charge key and the session stays open, refused `agents.window_unpaid`, so the person sees what they owe; adding
   * funds and closing again (or starting a run) retries it on that same key.
   */
  async closeSettled(sessionId: string): Promise<SessionRecord> {
    try {
      await this.settleSession(sessionId);
    } catch (err) {
      if (!(err instanceof InsufficientFundsError)) throw err;
      throw new AgentError(
        `A usage window of session ${sessionId} could not be paid`,
        'agents.window_unpaid',
        'agents.error.window_unpaid',
      );
    }
    return this.closeSession(sessionId);
  }

  // ── The user-visible log (§8.2) ────────────────────────────────────────────

  async userLog(userId: string, limit: number): Promise<AuditedAction[]> {
    return this.audit.forUser(userId, limit);
  }

  async sessionLog(sessionId: string, limit: number): Promise<AuditedAction[]> {
    return this.audit.forSession(sessionId, limit);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async requireSession(sessionId: string, options: { allowClosed?: boolean } = {}): Promise<SessionRecord> {
    const session = await this.session(sessionId);
    if (!session) {
      throw new AgentError(`No session ${sessionId}`, 'agents.session_not_found', 'agents.refused.session_closed');
    }
    if (session.status === 'closed' && !options.allowClosed) {
      throw new AgentError(`Session ${sessionId} is closed`, 'agents.session_closed', 'agents.refused.session_closed');
    }
    return session;
  }

  private async appendRefusal(
    session: SessionRecord,
    refusal: Refusal,
    context: { kind: ActionKind; tool?: string; task?: string },
  ): Promise<RefusedError> {
    const action = await transaction(
      this.sql,
      async (tx) =>
        this.audit.append(tx, {
          sessionId: session.id,
          userId: session.userId,
          agentId: session.agentId,
          kind: context.kind,
          status: 'refused',
          tool: context.tool ?? null,
          task: context.task ?? null,
          refusalCode: refusal.code,
          userMessageKey: refusal.userMessageKey,
          userMessageParams: refusal.userMessageParams,
        }),
      { isolation: 'read committed', maxAttempts: 5 },
    );

    await this.bus.publish(
      'agentActionRejected',
      {
        sessionId: session.id,
        userId: session.userId,
        agentId: session.agentId,
        sequence: action.sequence,
        refusalCode: refusal.code,
        tool: action.tool,
        task: action.task,
      },
      { idempotencyKey: `agents.action:${session.id}:${action.sequence}` },
    );

    return new RefusedError(refusal, action);
  }

  private async appendFailure(
    session: SessionRecord,
    context: { kind: ActionKind; tool?: string; task?: string; providerId?: string; model?: string; error: unknown },
  ): Promise<AuditedAction> {
    const key = context.error instanceof AgentError ? context.error.userMessageKey : ('agents.error.engine_unavailable' as const);
    const params = context.error instanceof AgentError ? context.error.userMessageParams : {};

    return transaction(
      this.sql,
      async (tx) =>
        this.audit.append(tx, {
          sessionId: session.id,
          userId: session.userId,
          agentId: session.agentId,
          kind: context.kind,
          status: 'failed',
          tool: context.tool ?? null,
          task: context.task ?? null,
          providerId: context.providerId ?? null,
          model: context.model ?? null,
          userMessageKey: key,
          userMessageParams: params,
        }),
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  private async publishCompleted(action: AuditedAction, usage: TokenUsage): Promise<void> {
    await this.bus.publish(
      'agentActionCompleted',
      {
        sessionId: action.sessionId,
        userId: action.userId,
        agentId: action.agentId,
        sequence: action.sequence,
        kind: action.kind,
        task: action.task,
        tool: action.tool,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
      { idempotencyKey: `agents.action:${action.sessionId}:${action.sequence}` },
    );
  }
}

function toSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    guardrail: parseGuardrail(row.guardrail),
    guardrailVersion: Number(row.guardrail_version),
    status: row.status,
    metered: row.metered,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
  };
}

/**
 * A deliberately PESSIMISTIC input-token estimate, used only for the pre-flight
 * spend check.
 *
 * The real counts always come from the provider. This exists because a spend
 * ceiling has to be checked before the tokens are spent, and the only honest
 * way to do that is to over-estimate: an estimate that ran low would let a call
 * cross the limit it was checked against, which is the one failure mode a
 * ceiling exists to prevent. Three characters per token is tighter than any
 * real tokeniser, so the guardrail errs toward refusing.
 */
export function estimateInputTokens(system: string | undefined, messages: readonly { content: string }[]): number {
  const chars = (system?.length ?? 0) + messages.reduce((acc, m) => acc + m.content.length, 0);
  return Math.ceil(chars / 3);
}

/**
 * Keeps one executed engine call's prompt text for `days` (AGENTS_TRANSCRIPT_RETENTION_DAYS), inside the transaction that
 * wrote its action row: the row and its text land together or not at all. The purge is index.ts's timer
 * (purgeExpiredTranscripts), never this transaction.
 */
async function keepTranscript(tx: Sql, actionId: string, userId: string, text: string, days: number): Promise<void> {
  await tx`
    INSERT INTO agents.agent_transcripts (action_id, user_id, text, expires_at)
    VALUES (${actionId}, ${userId}, ${text}, now() + make_interval(days => ${days}))
  `;
}

function canonicalPrompt(system: string | undefined, messages: readonly { role: string; content: string }[]): string {
  return JSON.stringify([system ?? null, messages.map((m) => [m.role, m.content])]);
}
