import { z } from 'zod';
import { scopedProcedure } from '@intafaced/contracts';
import { ROUTING_MODES, SKILLS_MAX, type DeskRouting } from './desk-routing.js';
import { requireSupportOps, type SupportService } from './support-service.js';
import { mapError } from './router.js';

/**
 * Routing, capacity and skills (SP-routing-01), and the logs the agent directory and group settings read (SP-agents-01,
 * SP-desk-04). Every procedure is the desk's (`support:ops`); every write is a lead's.
 */
const guid = z.string().guid();
const skill = z.string().trim().min(1).max(40);
const outcome = z.union([
  z.object({
    status: z.literal('assigned'),
    ticketId: z.string(),
    assigneeId: z.string(),
    groupId: z.string(),
    mode: z.enum(ROUTING_MODES),
  }),
  z.object({ status: z.literal('queued'), ticketId: z.string(), groupId: z.string(), code: z.literal('support.no_agent_available') }),
  z.object({
    status: z.literal('skipped'),
    ticketId: z.string(),
    reason: z.enum(['not_found', 'not_queueable', 'already_assigned', 'ungrouped', 'routing_unset', 'routing_off']),
  }),
]);
const groupRouting = z.object({
  groupId: z.string(),
  mode: z.enum(ROUTING_MODES),
  cursorUserId: z.string().nullable(),
  revision: z.number().int(),
  setBy: z.string(),
  setAt: z.string(),
});
const staffRouting = z.object({ userId: z.string(), capacity: z.number().int().nullable(), skills: z.array(z.string()) });

export function routingProcedures(routing: DeskRouting, support: SupportService) {
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      mapError(err);
    }
  };
  return {
    routingOverview: scopedProcedure('support:ops')
      .output(
        z.object({
          groups: z.array(
            z.object({
              groupId: z.string(),
              name: z.string(),
              mode: z.enum(ROUTING_MODES).nullable(),
              cursorUserId: z.string().nullable(),
              setBy: z.string().nullable(),
              setAt: z.string().nullable(),
            }),
          ),
          staff: z.array(staffRouting),
          sweepSeconds: z.number().int().positive().nullable(),
        }),
      )
      .query(({ ctx }) => {
        requireSupportOps(ctx.principal!);
        return run(() => routing.overview(ctx.principal!.userId));
      }),

    routingSetMode: scopedProcedure('support:ops')
      .input(z.object({ groupId: guid, mode: z.enum(ROUTING_MODES) }))
      .output(z.object({ routing: groupRouting, routed: z.array(outcome) }))
      .mutation(({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        return run(() => routing.setMode(ctx.principal!.userId, input));
      }),

    staffSetRouting: scopedProcedure('support:ops')
      .input(
        z.object({ userId: z.string().min(1).max(200), capacity: z.number().int().nullable(), skills: z.array(skill).max(SKILLS_MAX) }),
      )
      .output(staffRouting)
      .mutation(({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        return run(() => routing.setStaffRouting(ctx.principal!.userId, input));
      }),

    ticketSetRequiredSkill: scopedProcedure('support:ops')
      .input(z.object({ ticketId: guid, skill: skill.nullable() }))
      .output(
        z.object({
          routing: z.object({
            ticketId: z.string(),
            requiredSkill: z.string().nullable(),
            state: z.enum(['assigned', 'no_agent']).nullable(),
            stateAt: z.string().nullable(),
          }),
          outcome,
        }),
      )
      .mutation(({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        return run(() => routing.setRequiredSkill(ctx.principal!.userId, input));
      }),

    ticketRouting: scopedProcedure('support:ops')
      .input(z.object({ ticketId: guid }))
      .output(
        z.object({
          ticketId: z.string(),
          requiredSkill: z.string().nullable(),
          state: z.enum(['assigned', 'no_agent']).nullable(),
          code: z.literal('support.no_agent_available').nullable(),
          stateAt: z.string().nullable(),
        }),
      )
      .query(({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        return run(() => routing.ticketState(ctx.principal!.userId, input.ticketId));
      }),

    routingWaiting: scopedProcedure('support:ops')
      .output(z.array(z.object({ ticketId: z.string(), code: z.literal('support.no_agent_available'), since: z.string().nullable() })))
      .query(({ ctx }) => {
        requireSupportOps(ctx.principal!);
        return run(() => routing.waiting(ctx.principal!.userId));
      }),

    /** A lead runs the worker's pass for one request. Racing passes, or a pass and a hand claim, make one assignment. */
    routingRun: scopedProcedure('support:ops')
      .input(z.object({ ticketId: guid }))
      .output(outcome)
      .mutation(({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        return run(() => routing.run(ctx.principal!.userId, input.ticketId));
      }),

    routingLog: scopedProcedure('support:ops')
      .input(z.object({ subject: z.string().min(1).max(200).optional() }).optional())
      .output(z.array(z.object({ action: z.string(), subject: z.string(), value: z.string().nullable(), by: z.string(), at: z.string() })))
      .query(({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        return run(() => routing.log(ctx.principal!.userId, input?.subject));
      }),

    staffAvailabilityLog: scopedProcedure('support:ops')
      .input(z.object({ userId: z.string().min(1).max(200).optional() }).optional())
      .output(
        z.array(
          z.object({
            userId: z.string(),
            availability: z.enum(['online', 'busy', 'offline']),
            by: z.string(),
            reason: z.string().nullable(),
            at: z.string(),
          }),
        ),
      )
      .query(({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        return run(() => support.staffAvailabilityHistory({ actorId: ctx.principal!.userId, userId: input?.userId }));
      }),

    groupsLog: scopedProcedure('support:ops')
      .input(z.object({ groupId: guid }))
      .output(
        z.array(z.object({ groupId: z.string(), action: z.string(), subject: z.string().nullable(), by: z.string(), at: z.string() })),
      )
      .query(({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        return run(() => support.groupHistory({ actorId: ctx.principal!.userId, groupId: input.groupId }));
      }),
  };
}
