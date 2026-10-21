import { router } from '@intafaced/contracts';
import { z } from 'zod';
import type { founderProcedure } from '../../namespaces/founder-procedure.js';
import { custodyApprovalToTrpcError } from './errors.js';
import {
  approverViewSchema,
  configProposeInputSchema,
  decideInputSchema,
  initiateInputSchema,
  listInputSchema,
  pendingInputSchema,
  quorumQueryInputSchema,
  quorumViewSchema,
  registerApproverInputSchema,
  revokeApproverInputSchema,
  setQuorumInputSchema,
  settleResultSchema,
  taskDetailSchema,
  taskIdInputSchema,
  taskViewSchema,
} from './schemas.js';
import type { CustodyApprovalService } from './service.js';

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw custodyApprovalToTrpcError(error);
  }
}

/**
 * `founderAdmin.custody.tasks.*`, `.config.*`, `.approvers.*` and `.approvalSettings.*` (W-custody-ops-06). Built from the
 * custody router's own founder procedure, so every call is founder-only and the actor is the signed-in founder. Approving
 * needs the payload hash the approver read and an active registered approver; the initiator never decides their own task.
 */
export function createCustodyApprovalRouters(
  founder: ReturnType<typeof founderProcedure>,
  service: CustodyApprovalService,
  actorOf: (ctx: unknown) => string,
) {
  return {
    tasks: router({
      initiate: founder
        .input(initiateInputSchema)
        .output(taskViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.initiate(actorOf(ctx), input))),
      approve: founder
        .input(decideInputSchema)
        .output(taskViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.approve(actorOf(ctx), input.taskId, input.payloadHash))),
      reject: founder
        .input(decideInputSchema)
        .output(taskViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.reject(actorOf(ctx), input.taskId, input.payloadHash))),
      cancel: founder
        .input(taskIdInputSchema)
        .output(taskViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.cancel(actorOf(ctx), input.taskId))),
      get: founder
        .input(taskIdInputSchema)
        .output(taskDetailSchema)
        .query(({ ctx, input }) => wrap(() => service.get(actorOf(ctx), input.taskId))),
      list: founder
        .input(listInputSchema)
        .output(z.array(taskViewSchema))
        .query(({ ctx, input }) => wrap(() => service.list(actorOf(ctx), input))),
      settleDue: founder
        .input(z.object({}).strict())
        .output(settleResultSchema)
        .mutation(({ ctx }) => wrap(() => service.settleDue(actorOf(ctx)))),
    }),
    config: router({
      propose: founder
        .input(configProposeInputSchema)
        .output(taskViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.proposeConfig(actorOf(ctx), input))),
      approve: founder
        .input(decideInputSchema)
        .output(taskViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.approve(actorOf(ctx), input.taskId, input.payloadHash, 'config'))),
      reject: founder
        .input(decideInputSchema)
        .output(taskViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.reject(actorOf(ctx), input.taskId, input.payloadHash, 'config'))),
    }),
    approvers: router({
      register: founder
        .input(registerApproverInputSchema)
        .output(approverViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.registerApprover(actorOf(ctx), input))),
      revoke: founder
        .input(revokeApproverInputSchema)
        .output(approverViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.revokeApprover(actorOf(ctx), input.userId))),
      list: founder
        .input(z.object({}).strict())
        .output(z.array(approverViewSchema))
        .query(() => wrap(() => service.listApprovers())),
      pending: founder
        .input(pendingInputSchema)
        .output(z.array(taskViewSchema))
        .query(({ ctx, input }) => wrap(() => service.pending(actorOf(ctx), input))),
    }),
    approvalSettings: router({
      setQuorum: founder
        .input(setQuorumInputSchema)
        .output(quorumViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.setQuorum(actorOf(ctx), input))),
      quorum: founder
        .input(quorumQueryInputSchema)
        .output(quorumViewSchema.nullable())
        .query(({ input }) => wrap(() => service.quorum(input.kind))),
    }),
  };
}
