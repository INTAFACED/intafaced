import { z } from 'zod';
import { scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import type { AgentRuntime } from '../runtime.js';
import { actionOutput, toActionOutput } from '../router.js';
import { analyticsRange, analyticsSummary, decodeLogCursor, encodeLogCursor, recordOwnExport, runTrace, usageSummary } from './store.js';

/**
 * What my agents did (J-agents-13): the dashboard, one run's trace, the activity log's outcome filter, count and whole
 * export, and usage by agent, user and task. Every procedure reads only the signed person's own rows (the user id comes
 * from the signed principal, never the body) and writes nothing; no money moves.
 */

const outcome = z.enum(['executed', 'refused', 'failed']);

interface ReviewDeps {
  readonly runtime: AgentRuntime;
  readonly sql?: Sql | undefined;
  readonly feeAssetId: string;
}

interface ReviewKit {
  readonly guard: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly ownedSession: (sessionId: string, userId: string) => Promise<{ id: string }>;
}

const group = z.object({
  key: z.string(),
  name: z.string().nullable(),
  windows: z.number().int(),
  assetId: z.string(),
  amount: z.string(),
});
const amountLine = z.object({ assetId: z.string(), amount: z.string() });
const dayFigures = z.object({
  day: z.string(),
  sessions: z.number().int(),
  actions: z.number().int(),
  executed: z.number().int(),
  refused: z.number().int(),
  failed: z.number().int(),
  testRuns: z.number().int().nullable(),
  spend: z.array(amountLine),
});

export function reviewRoutes(deps: ReviewDeps, kit: ReviewKit) {
  const { runtime, feeAssetId } = deps;
  const { guard, ownedSession } = kit;
  const db = () => {
    if (!deps.sql) throw new Error('agents sql is unset');
    return deps.sql;
  };

  return {
    /**
     * The person's dashboard over a range of UTC days, both ends included. A blank end refuses naming it
     * (`agents.analytics_range_unset`); test and dry runs are counted only when `includeTest` is true.
     */
    analyticsSummary: scopedProcedure('agents:read', { module: 'agents' })
      .input(
        z
          .object({
            from: z.string().max(32).optional(),
            to: z.string().max(32).optional(),
            includeTest: z.boolean().optional(),
          })
          .strict(),
      )
      .output(
        z.object({
          from: z.string(),
          to: z.string(),
          includesTest: z.boolean(),
          totals: dayFigures.omit({ day: true }),
          days: z.array(dayFigures),
        }),
      )
      .query(({ ctx, input }) =>
        guard(async () => {
          const range = analyticsRange(input.from, input.to);
          return analyticsSummary(db(), {
            userId: ctx.principal.userId,
            ...range,
            includeTest: input.includeTest === true,
            feeAssetId,
          });
        }),
      ),

    /** One run of one of the person's sessions, by its request id, as timed steps and calls. Someone else's: not found. */
    runTrace: scopedProcedure('agents:read', { module: 'agents' })
      .input(z.object({ sessionId: z.string().guid(), requestId: z.string().min(1).max(200) }).strict())
      .output(
        z.object({
          runId: z.string(),
          requestId: z.string(),
          sessionId: z.string(),
          agentId: z.string(),
          task: z.string().nullable(),
          state: z.string(),
          cost: z.string().nullable(),
          assetId: z.string().nullable(),
          startedAt: z.string(),
          plan: z.array(
            z.object({
              sequence: z.number().int(),
              state: z.string(),
              code: z.string().nullable(),
              startedAt: z.string(),
              tookMs: z.number().int().nullable(),
            }),
          ),
          calls: z.array(
            z.object({
              actionId: z.string(),
              sequence: z.number().int(),
              kind: z.string(),
              status: outcome,
              tool: z.string().nullable(),
              task: z.string().nullable(),
              startedAt: z.string(),
              finishedAt: z.string(),
              tookMs: z.number().int(),
              inputTokens: z.string(),
              outputTokens: z.string(),
              cost: z.string(),
              refusalCode: z.string().nullable(),
            }),
          ),
        }),
      )
      .query(({ ctx, input }) =>
        guard(async () => {
          const session = await ownedSession(input.sessionId, ctx.principal.userId);
          const trace = await runTrace(db(), { sessionId: session.id, requestId: input.requestId });
          if (!trace) throw new TRPCError({ code: 'NOT_FOUND', message: 'agents.run_not_found' });
          return trace;
        }),
      ),

    /** How many rows the person's log holds, of one outcome or all: what an export of that filter will hold. */
    logCount: scopedProcedure('agents:read', { module: 'agents' })
      .input(z.object({ outcome: outcome.optional() }).strict())
      .output(z.object({ total: z.number().int() }))
      .query(({ ctx, input }) =>
        guard(async () => ({ total: await runtime.audit.countForUser(ctx.principal.userId, input.outcome ?? null) })),
      ),

    /**
     * The person's whole log for an export, a page at a time, newest first, with the same outcome filter as the screen;
     * `nextCursor` is null on the last page. Blank limit refuses (`agents.log_mine_limit_unset`).
     */
    logExport: scopedProcedure('agents:read', { module: 'agents' })
      .input(
        z
          .object({
            outcome: outcome.optional(),
            cursor: z.string().min(1).max(512).optional(),
            limit: z.number().int().min(1).max(500).optional(),
            /** The caller's id for this export: its last page writes one audit row keyed on it, so a retry writes none. */
            requestId: z.string().min(8).max(200).optional(),
            format: z.enum(['csv', 'json']).optional(),
          })
          .strict(),
      )
      .output(z.object({ rows: z.array(actionOutput), nextCursor: z.string().nullable() }))
      .query(({ ctx, input }) =>
        guard(async () => {
          const after = input.cursor ? decodeLogCursor(input.cursor) : null;
          const limit = input.limit;
          const rows = await runtime.audit.forUserAfter(ctx.principal.userId, {
            status: input.outcome ?? null,
            after,
            limit: limit as number,
          });
          const last = rows.at(-1);
          const full = limit !== undefined && rows.length === Math.min(500, limit);
          // The last page of an export writes its one audit row: who exported, the filter and how many rows it held.
          if (!full && input.requestId)
            await recordOwnExport(db(), {
              userId: ctx.principal.userId,
              requestId: input.requestId,
              filter: { outcome: input.outcome ?? 'all', format: input.format ?? 'csv' },
              rowCount: await runtime.audit.countForUser(ctx.principal.userId, input.outcome ?? null),
            });
          return {
            rows: rows.map(toActionOutput),
            nextCursor:
              full && last
                ? encodeLogCursor({ at: last.occurredAt.toISOString(), sessionId: last.sessionId, sequence: last.sequence })
                : null,
          };
        }),
      ),

    /**
     * The person's usage from sealed windows: the newest `limit` windows, the count of all of them, and the totals by
     * agent, user and task, each adding up to the same total. `limit` is the caller's page size and is never defaulted.
     */
    usageSummary: scopedProcedure('agents:read', { module: 'agents' })
      .input(z.object({ limit: z.number().int().min(1).max(500) }).strict())
      .output(
        z.object({
          windowCount: z.number().int(),
          windows: z.array(
            z.object({
              sessionId: z.string(),
              agentId: z.string(),
              agentName: z.string().nullable(),
              windowId: z.string(),
              day: z.string(),
              task: z.string(),
              state: z.enum(['unpaid', 'settled']),
              amount: z.string(),
              assetId: z.string(),
            }),
          ),
          total: z.array(amountLine),
          byAgent: z.array(group),
          byUser: z.array(group),
          byTask: z.array(group),
        }),
      )
      .query(({ ctx, input }) => guard(() => usageSummary(db(), { userId: ctx.principal.userId, limit: input.limit, feeAssetId }))),
  };
}
