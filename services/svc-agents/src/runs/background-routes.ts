import { z } from 'zod';
import { scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { AgentsRouterDeps } from '../router.js';
import type { RunRouteKit } from './routes.js';
import { RUN_NOTICES, sessionRunSchema, sessionRunStopSchema } from '@intafaced/contracts/agents-runs';
import { SessionRunConflict, SessionRunStore } from './background.js';

/**
 * The background run routes (AG-sessions-04, AG-control-01; J-agents-06): start a run on one of the caller's open
 * sessions, read it with its steps, pause, resume, ask it more, and stop it. Every route is bounded to the caller's own
 * runs: someone else's run id is `agents.run_not_found`, the same as one that does not exist.
 */
export function backgroundRunRoutes(deps: AgentsRouterDeps, kit: RunRouteKit) {
  const { guard, executeProcedure, ownedSession } = kit;
  const settings = deps.sessionRuns ?? { maxSteps: null, stepMs: null };
  const store = () => {
    if (!deps.sql) throw new Error('agents sql is unset');
    return new SessionRunStore(deps.sql, deps.runtime, deps.feeAssetId);
  };
  const notFound = () => new TRPCError({ code: 'NOT_FOUND', message: 'agents.run_not_found' });
  const found = <T>(value: T | null): T => {
    if (value === null) throw notFound();
    return value;
  };
  const typed = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SessionRunConflict) throw new TRPCError({ code: 'CONFLICT', message: err.code, cause: err });
      throw err;
    }
  };
  const byId = z.object({ runId: z.string().guid() }).strict();

  return {
    /** Starts a run in the background on the caller's open session; the same request id again is that run. */
    start: executeProcedure()
      .input(
        z
          .object({
            sessionId: z.string().guid(),
            requestId: z.string().min(8).max(200),
            task: z.string().min(1).max(120),
            ask: z.string().trim().min(1).max(20_000),
            steps: z.number().int().min(1),
            notice: z.enum(RUN_NOTICES),
          })
          .strict(),
      )
      .output(sessionRunSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          // Blank owner values refuse by name; nothing invents how many steps a run may take or how long one is.
          if (settings.maxSteps === null || settings.stepMs === null) {
            throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'agents.session_run_unset' });
          }
          if (input.steps > settings.maxSteps) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'agents.session_run_steps_over' });
          }
          const session = await ownedSession(input.sessionId, ctx.principal.userId);
          if (session.status !== 'open') throw new TRPCError({ code: 'CONFLICT', message: 'agents.refused.session_closed' });
          deps.gateway.routeFor(input.task);
          return store().start({
            userId: ctx.principal.userId,
            sessionId: session.id,
            agentId: session.agentId,
            requestKey: input.requestId,
            task: input.task,
            ask: input.ask,
            notice: input.notice,
            steps: input.steps,
          });
        }),
      ),

    /** One of the caller's runs, with every step it took and the stop's answer. */
    get: scopedProcedure('agents:read', { module: 'agents' })
      .input(byId)
      .output(sessionRunSchema)
      .query(({ ctx, input }) => guard(async () => found(await store().get(input.runId, ctx.principal.userId)))),

    pause: executeProcedure()
      .input(byId)
      .output(sessionRunSchema)
      .mutation(({ ctx, input }) => guard(() => typed(async () => found(await store().pause(input.runId, ctx.principal.userId))))),

    resume: executeProcedure()
      .input(byId)
      .output(sessionRunSchema)
      .mutation(({ ctx, input }) => guard(() => typed(async () => found(await store().resume(input.runId, ctx.principal.userId))))),

    /** One more request to the run; while it is paused, refused `agents.run.paused`. */
    askMore: executeProcedure()
      .input(z.object({ runId: z.string().guid(), text: z.string().trim().min(1).max(20_000) }).strict())
      .output(sessionRunSchema)
      .mutation(({ ctx, input }) =>
        guard(() =>
          typed(async () => {
            if (settings.maxSteps === null) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'agents.session_run_unset' });
            return found(await store().askMore(input.runId, ctx.principal.userId, input.text, settings.maxSteps));
          }),
        ),
      ),

    /** Stops the run; pressed again, the first stop's answer is returned with `repeated`. */
    stop: executeProcedure()
      .input(byId)
      .output(sessionRunStopSchema)
      .mutation(({ ctx, input }) => guard(() => typed(async () => found(await store().stop(input.runId, ctx.principal.userId))))),
  };
}
