import { z } from 'zod';
import { scopedProcedure } from '@intafaced/contracts/trpc';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import {
  SUPPORT_DESK_AVAILABILITY_LOG,
  SUPPORT_DESK_GROUPS_LOG,
  SUPPORT_DESK_ROUTING_OVERVIEW,
  SUPPORT_DESK_ROUTING_SET_MODE,
  SUPPORT_DESK_ROUTING_WAITING,
  SUPPORT_DESK_STAFF_SET_ROUTING,
  SUPPORT_DESK_TICKET_ROUTING,
  SUPPORT_DESK_TICKET_SET_SKILL,
  supportRouteOutcomeSchema,
} from '@intafaced/contracts/support-desk-procedures';
import type { DeskRouting } from './desk-routing.js';
import { requireSupportOps, type SupportService } from './support-service.js';
import { mapError } from './router.js';
import { supportRefusal } from './record-refusal.js';

/**
 * Routing, capacity and skills (SP-routing-01), and the logs the agent directory and group settings read (SP-agents-01,
 * SP-desk-04). Every procedure is the desk's (`support:ops`); every write is a lead's. The desk's are mounted from their
 * records (`@intafaced/contracts/support-desk-procedures`).
 */
const guid = z.string().guid();

export function routingProcedures(routing: DeskRouting, support: SupportService) {
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      mapError(err);
    }
  };
  return {
    routingOverview: mountRecord(
      SUPPORT_DESK_ROUTING_OVERVIEW,
      ({ ctx }) => {
        requireSupportOps(ctx.principal);
        return routing.overview(ctx.principal.userId);
      },
      supportRefusal,
    ),

    routingSetMode: mountRecord(
      SUPPORT_DESK_ROUTING_SET_MODE,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return routing.setMode(ctx.principal.userId, input);
      },
      supportRefusal,
    ),

    staffSetRouting: mountRecord(
      SUPPORT_DESK_STAFF_SET_ROUTING,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return routing.setStaffRouting(ctx.principal.userId, input);
      },
      supportRefusal,
    ),

    ticketSetRequiredSkill: mountRecord(
      SUPPORT_DESK_TICKET_SET_SKILL,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return routing.setRequiredSkill(ctx.principal.userId, input);
      },
      supportRefusal,
    ),

    ticketRouting: mountRecord(
      SUPPORT_DESK_TICKET_ROUTING,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return routing.ticketState(ctx.principal.userId, input.ticketId);
      },
      supportRefusal,
    ),

    routingWaiting: mountRecord(
      SUPPORT_DESK_ROUTING_WAITING,
      ({ ctx }) => {
        requireSupportOps(ctx.principal);
        return routing.waiting(ctx.principal.userId);
      },
      supportRefusal,
    ),
    /** A lead runs the worker's pass for one request. Racing passes, or a pass and a hand claim, make one assignment. */
    routingRun: scopedProcedure('support:ops')
      .input(z.object({ ticketId: guid }))
      .output(supportRouteOutcomeSchema)
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

    staffAvailabilityLog: mountRecord(
      SUPPORT_DESK_AVAILABILITY_LOG,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.staffAvailabilityHistory({ actorId: ctx.principal.userId, userId: input?.userId });
      },
      supportRefusal,
    ),

    groupsLog: mountRecord(
      SUPPORT_DESK_GROUPS_LOG,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.groupHistory({ actorId: ctx.principal.userId, groupId: input.groupId });
      },
      supportRefusal,
    ),
  };
}
