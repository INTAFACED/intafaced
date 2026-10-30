import { z } from 'zod';
import { scopedProcedure, TRPCError } from '@intafaced/contracts';
import { formatAmount } from '@intafaced/ledger-client';
import { AgentError } from '../errors.js';
import { actionOutput, toActionOutput, type AgentsRouterDeps, type ExecuteProcedure } from '../router.js';
import { RUN_STATES, RunTransitionError } from './machine.js';
import { runRecorded } from './record.js';
import { createRunStore, type StoredRun } from './store.js';

/** The run routes' builders, handed in by the agents router so the procedures here match the rest of it. */
export interface RunRouteKit {
  readonly guard: <T>(fn: () => Promise<T>) => Promise<T>;
  /** `agents:execute`, the person's own session only (OWNER 107). */
  readonly executeProcedure: ExecuteProcedure;
  /** The session if it is the caller's; the same not-found for someone else's. */
  readonly ownedSession: (sessionId: string, userId: string) => Promise<{ id: string; agentId: string }>;
}

const runState = z.enum(RUN_STATES);

const runOutput = z.object({
  runId: z.string().guid(),
  sessionId: z.string().guid(),
  agentId: z.string(),
  requestId: z.string(),
  task: z.string().nullable(),
  state: runState,
  /** The stored reply once the run completed; the prompt is never stored or returned. */
  reply: z.string().nullable(),
  cost: z.string().nullable(),
  assetId: z.string().nullable(),
  metered: z.boolean().nullable(),
  /** Every typed refusal the run met, oldest first, as codes a client maps to its own words. */
  refusalCodes: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const toRunOutput = (run: StoredRun, refusalCodes: string[]) => ({
  runId: run.id,
  sessionId: run.sessionId,
  agentId: run.agentId,
  requestId: run.requestId,
  task: run.task,
  state: run.state,
  reply: run.reply,
  cost: run.cost,
  assetId: run.assetId,
  metered: run.metered,
  refusalCodes,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
});

/** A cursor is the last event sequence the caller has read, as a decimal string; a malformed one is the existing typed refusal. */
export function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^(0|[1-9]\d{0,8})$/.test(cursor)) {
    throw new AgentError('run events cursor is not valid', 'agents.cursor_invalid', 'agents.refused.cursor_invalid');
  }
  return Number(cursor);
}

/** A move RS-2 does not allow is the caller's conflict, by its own typed code. */
async function typed<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RunTransitionError) throw new TRPCError({ code: 'CONFLICT', message: err.code, cause: err });
    throw err;
  }
}

/**
 * The run routes (AG-sessions-01, AG-sessions-04's read side): `complete` runs one engine call as a stored run, and a
 * caller with `agents:read` (an API key included) lists a session's runs, reads one, and reads its events from a
 * cursor. Every read is bounded to the caller's own runs; someone else's run is not found.
 */
export function runRoutes(deps: AgentsRouterDeps, kit: RunRouteKit) {
  const { runtime, feeAssetId, sql } = deps;
  const { guard, executeProcedure, ownedSession } = kit;
  const store = () => {
    if (deps.runStore) return deps.runStore;
    if (!sql) throw new Error('agents sql is unset');
    return createRunStore(sql);
  };
  const notFound = () => new TRPCError({ code: 'NOT_FOUND', message: 'agents.run_not_found' });

  return {
    /**
     * One metered engine call, stored as a run.
     *
     * `requestId` is supplied by the CALLER and is the anti-double-bill
     * handle: a client that retries after a timeout reuses it, and the
     * usage is counted once no matter how many times the request arrives.
     */
    complete: executeProcedure()
      .input(
        z.object({
          sessionId: z.string().guid(),
          requestId: z.string().min(8).max(200),
          task: z.string().min(1),
          system: z.string().max(20_000).optional(),
          messages: z
            .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(200_000) }))
            .min(1)
            .max(200),
          maxOutputTokens: z.number().int().min(1).optional(),
        }),
      )
      .output(
        z.object({
          runId: z.string().guid(),
          text: z.string(),
          inputTokens: z.number().int(),
          outputTokens: z.number().int(),
          cost: z.string(),
          assetId: z.string(),
          metered: z.boolean(),
          action: actionOutput,
        }),
      )
      .mutation(({ ctx, input }) =>
        guard(() =>
          typed(async () => {
            const session = await ownedSession(input.sessionId, ctx.principal.userId);
            const { result, run } = await runRecorded(
              store(),
              {
                userId: ctx.principal.userId,
                sessionId: session.id,
                agentId: session.agentId,
                requestId: input.requestId,
                task: input.task,
                assetId: feeAssetId,
              },
              () =>
                runtime.think({
                  sessionId: input.sessionId,
                  requestId: input.requestId,
                  task: input.task,
                  ...(input.system ? { system: input.system } : {}),
                  messages: input.messages,
                  ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
                }),
            );

            return {
              runId: run.id,
              text: result.text,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              cost: formatAmount(result.cost),
              assetId: feeAssetId,
              metered: result.metered,
              action: toActionOutput(result.action),
            };
          }),
        ),
      ),

    /** The runs of one of the caller's sessions, oldest first. */
    list: scopedProcedure('agents:read', { module: 'agents' })
      .input(z.object({ sessionId: z.string().guid() }).strict())
      .output(z.array(z.object({ runId: z.string().guid(), requestId: z.string(), state: runState, createdAt: z.string() })))
      .query(({ ctx, input }) =>
        guard(async () => {
          const session = await ownedSession(input.sessionId, ctx.principal.userId);
          return (await store().forSession(session.id)).map((run) => ({
            runId: run.id,
            requestId: run.requestId,
            state: run.state,
            createdAt: run.createdAt,
          }));
        }),
      ),

    /** One of the caller's runs: its state, the stored reply, its cost and its refusal codes. No prompt text. */
    get: scopedProcedure('agents:read', { module: 'agents' })
      .input(z.object({ runId: z.string().guid() }).strict())
      .output(runOutput)
      .query(({ ctx, input }) =>
        guard(async () => {
          const found = await store().get(input.runId, ctx.principal.userId);
          if (!found) throw notFound();
          return toRunOutput(found.run, found.refusalCodes);
        }),
      ),

    /**
     * A run's events after `cursor` (the last sequence read; none reads from the start), oldest first, and the cursor
     * to pass next. Only the caller's own run; `limit` is the caller's page size and is never defaulted.
     */
    events: scopedProcedure('agents:read', { module: 'agents' })
      .input(
        z.object({ runId: z.string().guid(), cursor: z.string().max(16).optional(), limit: z.number().int().min(1).max(500) }).strict(),
      )
      .output(
        z.object({
          events: z.array(
            z.object({
              id: z.string(),
              sequence: z.number().int(),
              state: runState,
              /** The typed code a refusal or failure ended on. */
              code: z.string().nullable(),
              occurredAt: z.string(),
            }),
          ),
          cursor: z.string(),
        }),
      )
      .query(({ ctx, input }) =>
        guard(async () => {
          const after = parseCursor(input.cursor);
          const events = await store().events(input.runId, ctx.principal.userId, after, input.limit);
          if (!events) throw notFound();
          const last = events.at(-1);
          return {
            events: events.map((event) => ({ id: `${input.runId}:${event.sequence}`, ...event })),
            cursor: String(last ? last.sequence : after),
          };
        }),
      ),
  };
}
