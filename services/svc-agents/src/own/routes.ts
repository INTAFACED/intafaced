import type { Sql } from 'postgres';
import { z } from 'zod';
import {
  ownAgentCatalogueSchema,
  ownAgentLimitsSchema,
  ownAgentRunResultSchema,
  ownAgentRunRowSchema,
  ownAgentSchema,
  ownAgentSessionClosedSchema,
  ownAgentSessionSchema,
  ownAgentUsageDaySchema,
  ownAgentUsageWindowSchema,
  router,
  scopedProcedure,
  TRPCError,
} from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { AgentError } from '../errors.js';
import { parseGuardrail, type Guardrail } from '../fleet/guardrails.js';
import { executeProcedure } from '../procedures.js';
import { RefusedError, type AgentRuntime } from '../runtime.js';
import { assertPersonSetsLimits } from '../spend/routes.js';
import { OWN_AGENTS_MAX, OWN_TEMPLATE_IDS, OWN_TEMPLATES, OWN_TOOLS, OwnAgentRefusal } from './catalog.js';
import { OwnLimitsStore, readOwnCaps } from './limits.js';
import { OwnAgentStore, type OwnAgentView } from './store.js';

/** The task every run of a person's own agent is routed and priced as. */
export const OWN_RUN_TASK = 'own.run';
/** A session of an own agent is `own.<agent id>`, a name no registered agent can take. */
export const ownSessionAgentId = (id: string): string => `own.${id}`;
/** As many actions as the product agents allow a session, and the run route's own output ceiling. */
const OWN_MAX_ACTIONS = 60;
const OWN_MAX_OUTPUT_TOKENS = 2048;

/**
 * The guardrail an own agent's session is bound to: its saved tools, read only, in their modules; the one run task;
 * and the agent's own cap per session as the ceiling. The person's caps for it are held at every run, as they stand.
 */
export function ownGuardrail(agent: OwnAgentView): Guardrail {
  const tools = OWN_TOOLS.filter((tool) => !tool.movesMoney && agent.tools.includes(tool.name));
  return parseGuardrail({
    agentId: ownSessionAgentId(agent.id),
    version: agent.version,
    capacityMode: 'research_only',
    scopes: [],
    tools: tools.map((tool) => ({ name: tool.name, module: tool.module, mode: 'read', requiresApproval: false })),
    limits: {
      maxActionsPerSession: OWN_MAX_ACTIONS,
      maxOutputTokensPerCall: OWN_MAX_OUTPUT_TOKENS,
      maxSpendPerSession: agent.perSessionCap,
      allowedModules: [...new Set(tools.map((tool) => tool.module))],
      allowedTasks: [OWN_RUN_TASK],
    },
  });
}

/** A run's refusal or fault reaches the person as its code, which the Agents room words. */
function runError(err: unknown): never {
  if (err instanceof RefusedError) {
    throw new TRPCError({ code: 'FORBIDDEN', message: err.refusal.code, cause: err });
  }
  if (err instanceof AgentError) {
    const code =
      err.code === 'agents.session_not_found'
        ? 'NOT_FOUND'
        : err.code === 'agents.provider_unavailable'
          ? 'SERVICE_UNAVAILABLE'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.code, cause: err });
  }
  if (err instanceof TRPCError) throw err;
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'agents.error.engine_unavailable' });
}

/** What running needs; absent, every run route refuses as unavailable rather than half-working. */
export interface OwnRunDeps {
  readonly runtime: AgentRuntime;
  readonly feeAssetId: string;
}

/** A refusal reaches the person as its code, which the Agents room words; anything else is a fault. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof OwnAgentRefusal)) throw err;
    throw new TRPCError({ code: err.code === 'agents.own.not_found' ? 'NOT_FOUND' : 'BAD_REQUEST', message: err.code, cause: err });
  }
}

function storeOf(sql: Sql | undefined): OwnAgentStore {
  if (!sql) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'agents.capability_unavailable' });
  return new OwnAgentStore(sql);
}

function sqlOf(sql: Sql | undefined): Sql {
  if (!sql) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'agents.capability_unavailable' });
  return sql;
}

function runDepsOf(deps: OwnRunDeps | undefined): OwnRunDeps {
  if (!deps) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'agents.capability_unavailable' });
  return deps;
}

/** The owner's values a limits view carries: the fee asset, and the overage grace (null when blank). */
function owner(run: OwnRunDeps | undefined): { overageGrace: string | null; assetId: string } {
  const { runtime, feeAssetId } = runDepsOf(run);
  const grace = runtime.overageGraceAmount;
  return { overageGrace: grace === null ? null : formatAmount(grace), assetId: feeAssetId };
}

const idInput = z.object({ id: z.string().min(1).max(64) });

/** The person's own agent and a session of it. Not theirs, or not this agent's: one answer, so no oracle for others. */
async function ownedOwnSession(sql: Sql | undefined, runtime: AgentRuntime, userId: string, agentId: string, sessionId: string) {
  const agent = await guard(() => storeOf(sql).get(userId, agentId));
  const session = await runtime.session(sessionId);
  if (!session || session.userId !== userId || session.agentId !== ownSessionAgentId(agent.id)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'agents.session_not_found' });
  }
  return { agent, session };
}

/**
 * Agents a person builds for themselves (AG-builder-01). The owner is always the
 * signed-in person; a delegated token can neither build nor read their drafts,
 * whose instructions are theirs alone. Building moves no value.
 */
export function ownRouter(sql: Sql | undefined, run?: OwnRunDeps) {
  return router({
    /** The templates and the tools a draft may be given, with the ones that move money marked so they can be refused. */
    catalogue: scopedProcedure('agents:read', { module: 'agents' })
      .output(ownAgentCatalogueSchema)
      .query(() => {
        return {
          templates: OWN_TEMPLATE_IDS.map((id) => ({ id, tools: [...OWN_TEMPLATES[id].tools] })),
          tools: OWN_TOOLS.map((tool) => ({ ...tool })),
        };
      }),

    create: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(z.object({ template: z.string().min(1).max(64), createKey: z.string().min(8).max(128) }))
      .output(ownAgentSchema)
      .mutation(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(async () => {
          const template = OWN_TEMPLATE_IDS.find((id) => id === input.template);
          if (!template) throw new OwnAgentRefusal('agents.own.template_unknown');
          return storeOf(sql).create(ctx.principal.userId, template, input.createKey);
        });
      }),

    save: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(
        z.object({
          id: z.string().min(1).max(64),
          name: z.string().max(200),
          instructions: z.string().max(20_000),
          tools: z.array(z.string().max(120)).max(50),
          perSessionCap: z.string().max(64).nullable(),
        }),
      )
      .output(ownAgentSchema)
      .mutation(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        const { id, ...draft } = input;
        return guard(() => storeOf(sql).save(ctx.principal.userId, id, draft));
      }),

    get: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(z.object({ id: z.string().min(1).max(64) }))
      .output(ownAgentSchema)
      .query(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(() => storeOf(sql).get(ctx.principal.userId, input.id));
      }),

    list: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(z.object({ limit: z.number().int().min(1).max(200) }))
      .output(z.array(ownAgentSchema))
      .query(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(() => storeOf(sql).list(ctx.principal.userId, input.limit));
      }),

    /** The caps the person set for this agent, its own cap, and the per-session cap that applies (AG-spend-01). */
    limits: router({
      get: scopedProcedure('agents:read', { module: 'agents', person: true })
        .input(idInput)
        .output(ownAgentLimitsSchema)
        .query(({ ctx, input }) => {
          assertPersonSetsLimits(ctx.principal);
          return guard(async () => ({ ...(await new OwnLimitsStore(sqlOf(sql)).get(ctx.principal.userId, input.id)), ...owner(run) }));
        }),

      /** All three caps or none. Blank refuses `agents.spend.cap_unset`; above the agent's own cap is refused, not lowered. */
      set: scopedProcedure('agents:read', { module: 'agents', person: true })
        .input(
          idInput.extend({
            perCall: z.string().max(64).nullable(),
            perSession: z.string().max(64).nullable(),
            perPeriod: z.string().max(64).nullable(),
          }),
        )
        .output(ownAgentLimitsSchema)
        .mutation(({ ctx, input }) => {
          assertPersonSetsLimits(ctx.principal);
          const { id, ...caps } = input;
          return guard(async () => ({ ...(await new OwnLimitsStore(sqlOf(sql)).set(ctx.principal.userId, id, caps)), ...owner(run) }));
        }),
    }),

    session: router({
      /**
       * Opens a session of the person's own agent. Refused `agents.spend.cap_unset`, with no session made, until the
       * agent has its own cap and the person has set theirs for it: nothing of an own agent runs uncapped.
       */
      open: executeProcedure()
        .input(idInput)
        .output(ownAgentSessionSchema)
        .mutation(({ ctx, input }) =>
          guard(async () => {
            const { runtime } = runDepsOf(run);
            const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
            if (!(await readOwnCaps(sqlOf(sql), ctx.principal.userId, agent.id))) throw new OwnAgentRefusal('agents.spend.cap_unset');
            const session = await runtime.openOwnSession({ userId: ctx.principal.userId, guardrail: ownGuardrail(agent) });
            return { sessionId: session.id, agentId: session.agentId };
          }),
        ),

      /**
       * Closes a session of the person's own agent once its windows are paid, each on its own charge key. A window the
       * ledger refuses for funds stays unpaid and the session stays open: refused `agents.window_unpaid`.
       */
      close: executeProcedure()
        .input(idInput.extend({ sessionId: z.string().uuid() }))
        .output(ownAgentSessionClosedSchema)
        .mutation(async ({ ctx, input }) => {
          const { runtime } = runDepsOf(run);
          const { session } = await ownedOwnSession(sql, runtime, ctx.principal.userId, input.id, input.sessionId);
          try {
            const closed = await runtime.closeSettled(session.id);
            return { sessionId: closed.id, status: 'closed' as const, closedAt: (closed.closedAt ?? new Date()).toISOString() };
          } catch (err) {
            return runError(err);
          }
        }),
    }),

    /**
     * One run: the agent's instructions and the person's question, held against the agent's caps and the person's
     * balance before the engine is called. The same request id twice is one run and one charge.
     */
    run: executeProcedure()
      .input(
        idInput.extend({
          sessionId: z.string().uuid(),
          requestId: z.string().min(8).max(200),
          ask: z.string().min(1).max(4000),
        }),
      )
      .output(ownAgentRunResultSchema)
      .mutation(async ({ ctx, input }) => {
        const deps = runDepsOf(run);
        const { agent, session } = await ownedOwnSession(sql, deps.runtime, ctx.principal.userId, input.id, input.sessionId);
        try {
          const result = await deps.runtime.think({
            sessionId: session.id,
            requestId: input.requestId,
            task: OWN_RUN_TASK,
            ...(agent.instructions.trim() ? { system: agent.instructions } : {}),
            messages: [{ role: 'user', content: input.ask }],
          });
          return {
            text: result.text,
            cost: formatAmount(result.cost),
            assetId: deps.feeAssetId,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          };
        } catch (err) {
          return runError(err);
        }
      }),

    /** Every run asked of this agent by the person, newest first: admitted, refused with its code, or failed. */
    runs: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(idInput.extend({ limit: z.number().int().min(1).max(200) }))
      .output(z.array(ownAgentRunRowSchema))
      .query(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(async () => {
          const { feeAssetId } = runDepsOf(run);
          const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
          const rows = await sqlOf(sql)<
            Array<{
              session_id: string;
              sequence: number;
              status: 'executed' | 'refused' | 'failed';
              task: string | null;
              refusal_code: string | null;
              cost: string;
              occurred_at: Date;
            }>
          >`
            SELECT a.session_id::text, a.sequence, a.status, a.task, a.refusal_code, a.cost::text, a.occurred_at
              FROM agents.agent_actions a
             WHERE a.user_id = ${ctx.principal.userId}
               AND a.agent_id = ${ownSessionAgentId(agent.id)}
               AND a.kind = 'completion'
             ORDER BY a.occurred_at DESC, a.sequence DESC
             LIMIT ${input.limit}
          `;
          return rows.map((row) => ({
            sessionId: row.session_id,
            sequence: row.sequence,
            status: row.status,
            task: row.task,
            refusalCode: row.refusal_code,
            cost: formatAmount(parseAmount(row.cost)),
            assetId: feeAssetId,
            occurredAt: row.occurred_at.toISOString(),
          }));
        });
      }),

    /** The usage windows of this agent's sessions, newest first: open, unpaid (retried on its charge key) or settled. */
    usage: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(idInput.extend({ limit: z.number().int().min(1).max(200) }))
      .output(z.array(ownAgentUsageWindowSchema))
      .query(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(async () => {
          const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
          const windows = await runDepsOf(run).runtime.usageWindowsOf(ctx.principal.userId, ownSessionAgentId(agent.id), input.limit);
          return windows.map((w) => ({
            ...w,
            amount: w.amount === null ? null : formatAmount(w.amount),
            openedAt: w.openedAt.toISOString(),
          }));
        });
      }),

    /**
     * The sealed usage of every agent the person built, by agent, UTC day and task. Each row is the exact sum of the
     * sealed windows it covers, so an agent's rows add up to the amounts its Usage windows show.
     */
    usageByDay: scopedProcedure('agents:read', { module: 'agents', person: true })
      .output(z.array(ownAgentUsageDaySchema))
      .query(({ ctx }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(async () => {
          const agents = await storeOf(sql).list(ctx.principal.userId, OWN_AGENTS_MAX);
          const names = new Map(agents.map((agent) => [ownSessionAgentId(agent.id), agent]));
          const rows = await runDepsOf(run).runtime.usageByDayOf(ctx.principal.userId, [...names.keys()]);
          return rows.map((row) => {
            const agent = names.get(row.agentId)!;
            return { ...row, agentId: agent.id, agentName: agent.name, amount: formatAmount(row.amount) };
          });
        });
      }),
  });
}
