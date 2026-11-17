import type { Sql } from 'postgres';
import { z } from 'zod';
import {
  ownAgentScheduleCreateSchema,
  ownAgentScheduleSchema,
  ownAgentSchedulesSchema,
  ownAgentTriggerCreateSchema,
  ownAgentTriggerSchema,
  OWN_AGENT_AUTOMATION_LIMITS,
  router,
  scopedProcedure,
  TRPCError,
} from '@intafaced/contracts';
import { executeProcedure } from '../procedures.js';
import { assertPersonSetsLimits } from '../spend/routes.js';
import { AGENT_DISABLED, ownAgentSwitch } from '../fleet/control.js';
import { checkScheduleRequest, checkTriggerRequest, OwnAutomationStore, type Cadence } from './automation.js';
import { OwnAgentRefusal } from './catalog.js';
import { OwnAgentStore } from './store.js';

/** A refusal reaches the person as its code, which the Agents room words; anything else is a fault. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof OwnAgentRefusal)) throw err;
    const code = err.code.endsWith('.not_found')
      ? 'NOT_FOUND'
      : err.code === 'agents.schedule_cadence_unset'
        ? 'PRECONDITION_FAILED'
        : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.code, cause: err });
  }
}

const idInput = z.object({ id: z.string().min(1).max(64) });

/**
 * A person's own agent's schedules and event triggers (AG-sessions-02). Only the signed-in person reads or changes them,
 * for their own agent; another's agent reads as not found. Creating one moves no value: each run it makes is metered
 * like any run of the agent, against the person's caps for it.
 */
export function ownAutomationRouter(sql: Sql | undefined, deps: { feeAssetId: string | null; cadence: Cadence }) {
  const stores = () => {
    if (!sql || !deps.feeAssetId) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'agents.capability_unavailable' });
    return { agents: new OwnAgentStore(sql), automation: new OwnAutomationStore(sql, deps.feeAssetId) };
  };
  /** New work of a quarantined agent, or one whose kind is off, refuses `agents.agent.disabled`. */
  const assertOn = async (agentId: string) => {
    if ((await ownAgentSwitch(sql!, agentId)) !== 'active') throw new TRPCError({ code: 'FORBIDDEN', message: AGENT_DISABLED });
  };

  return {
    schedules: router({
      /** The agent's schedules, newest first, each with its status, next occurrence and recent occurrences. */
      list: scopedProcedure('agents:read', { module: 'agents', person: true })
        .input(idInput)
        .output(ownAgentSchedulesSchema)
        .query(({ ctx, input }) => {
          assertPersonSetsLimits(ctx.principal);
          return guard(async () => {
            const { agents, automation } = stores();
            const agent = await agents.get(ctx.principal.userId, input.id);
            return {
              cadence: deps.cadence,
              schedules: await automation.schedules(ctx.principal.userId, agent.id, OWN_AGENT_AUTOMATION_LIMITS.list),
            };
          });
        }),

      /**
       * A new schedule, due at once and then every interval. Blank cadence values of the owner refuse
       * `agents.schedule_cadence_unset`; a repeating schedule with a blank interval refuses
       * `agents.schedule.min_interval_unset`. Either way nothing is stored. The same create key is the same schedule.
       */
      create: executeProcedure()
        .input(ownAgentScheduleCreateSchema)
        .output(ownAgentScheduleSchema)
        .mutation(({ ctx, input }) =>
          guard(async () => {
            const { agents, automation } = stores();
            const agent = await agents.get(ctx.principal.userId, input.id);
            await assertOn(agent.id);
            const request = checkScheduleRequest(input, deps.cadence);
            return automation.createSchedule(ctx.principal.userId, agent, input.createKey, request);
          }),
        ),

      /** Cancels a schedule: no further occurrence is due. A run already running goes on. */
      cancel: executeProcedure()
        .input(idInput.extend({ scheduleId: z.string().min(1).max(64) }))
        .output(ownAgentScheduleSchema)
        .mutation(({ ctx, input }) =>
          guard(async () => {
            const { agents, automation } = stores();
            const agent = await agents.get(ctx.principal.userId, input.id);
            return automation.cancelSchedule(ctx.principal.userId, agent.id, input.scheduleId);
          }),
        ),
    }),

    triggers: router({
      /** The agent's triggers, newest first, each with the events delivered to it and the runs they made. */
      list: scopedProcedure('agents:read', { module: 'agents', person: true })
        .input(idInput)
        .output(z.array(ownAgentTriggerSchema))
        .query(({ ctx, input }) => {
          assertPersonSetsLimits(ctx.principal);
          return guard(async () => {
            const { agents, automation } = stores();
            const agent = await agents.get(ctx.principal.userId, input.id);
            return automation.triggers(ctx.principal.userId, agent.id, OWN_AGENT_AUTOMATION_LIMITS.list);
          });
        }),

      /** A new trigger on one of the offered subjects; any other refuses `agents.trigger_subject_invalid`. */
      create: executeProcedure()
        .input(ownAgentTriggerCreateSchema)
        .output(ownAgentTriggerSchema)
        .mutation(({ ctx, input }) =>
          guard(async () => {
            const { agents, automation } = stores();
            const agent = await agents.get(ctx.principal.userId, input.id);
            await assertOn(agent.id);
            return automation.createTrigger(ctx.principal.userId, agent, input.createKey, checkTriggerRequest(input));
          }),
        ),
    }),
  };
}
