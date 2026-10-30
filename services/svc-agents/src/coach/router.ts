import { z } from 'zod';
import { AuthError, hasScope, requireScope } from '@intafaced/auth';
import { scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { AgentsRouterDeps } from '../router.js';
import { envCoachGrounding } from './grounded-session.js';
import { COACH_REFUSAL_CODES, createCoachRunStore, runCoachAnswer, type CoachRefusalCode } from './coach-run.js';

/**
 * The Coach run: `agents:execute` like every run (OWNER 107), with a typed refusal when the caller's session does not
 * hold it, so the panel can say why instead of a bare "forbidden". The same checks as `executeProcedure` follow: the
 * scope itself (a key gets `scope.interactive_only`), and never a key, a sub-account or a service forwarding a principal.
 */
function coachRunProcedure() {
  return scopedProcedure('agents:read', { module: 'agents', person: true }).use(({ ctx, next }) => {
    if (!hasScope(ctx.principal.scopes, 'agents:execute')) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'agents.execute_scope_unset' });
    }
    try {
      requireScope(ctx.principal, 'agents:execute');
    } catch (err) {
      if (err instanceof AuthError) throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
      throw err;
    }
    if (ctx.principal.kid || ctx.principal.sub_account) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'agents.execute_person_only' });
    }
    return next();
  });
}

/** The Coach run routes, spread into the `coach` router; `guard` is the agents router's error mapper. */
export function coachRunRoutes(deps: AgentsRouterDeps, guard: <T>(fn: () => Promise<T>) => Promise<T>) {
  const { runtime, gateway, meter, feeAssetId, loadCoachGrounding, sql } = deps;
  return {
    /**
     * One Coach answer inside a lesson (RC-agents-02): a metered run whose citations are only lessons the curriculum
     * returned. Refusals are typed results, not errors, so the panel shows each by its code. `requestId` is the
     * person's business key: a retry with it returns the stored answer and never calls the engine twice.
     */
    runSession: coachRunProcedure()
      .input(
        z.object({
          question: z.string().trim().min(1).max(2000),
          lessonSlug: z
            .string()
            .regex(/^[a-z0-9-]{1,128}$/)
            .optional(),
          requestId: z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/),
        }),
      )
      .output(
        z.discriminatedUnion('status', [
          z.object({
            status: z.literal('answered'),
            answer: z.string(),
            citations: z.array(z.object({ slug: z.string(), title: z.string() })).min(1),
            nextLesson: z.object({ slug: z.string(), title: z.string() }).nullable(),
            engine: z.enum(['sandbox', 'live', 'unknown']),
            sessionId: z.string().guid(),
            runKey: z.string(),
            assetId: z.string(),
            charge: z.discriminatedUnion('state', [
              z.object({ state: z.literal('settled'), billedAmount: z.string() }),
              z.object({ state: z.literal('unpaid'), code: z.string() }),
            ]),
            replayed: z.boolean(),
          }),
          z.object({ status: z.literal('not_covered'), citations: z.array(z.never()).length(0) }),
          z.object({
            status: z.literal('refused'),
            code: z.enum(COACH_REFUSAL_CODES as [CoachRefusalCode, ...CoachRefusalCode[]]),
          }),
        ]),
      )
      .mutation(({ ctx, input }) =>
        guard(async () => {
          if (!sql) throw new Error('agents sql is unset');
          return runCoachAnswer(
            {
              runtime,
              gateway,
              store: createCoachRunStore(sql),
              feeAssetId,
              loadGrounding: async () => (await loadCoachGrounding?.()) ?? envCoachGrounding(),
              metered: (sessionId, requestId) => meter.hasRequest(sessionId, requestId),
            },
            {
              userId: ctx.principal.userId,
              requestId: input.requestId,
              question: input.question,
              ...(input.lessonSlug ? { lessonSlug: input.lessonSlug } : {}),
            },
          );
        }),
      ),
  };
}
