import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { z } from 'zod';
import type { FounderAuthority } from '../../founder-authority.js';
import { founderProcedure, type FounderContext } from '../../namespaces/founder-procedure.js';
import { toTrpcError } from '../../router.js';
import {
  decideInputSchema,
  getInputSchema,
  listForTeamInputSchema,
  listInputSchema,
  policyQueryInputSchema,
  policyViewSchema,
  proposeInputSchema,
  requestViewSchema,
  setPolicyInputSchema,
  settleResultSchema,
} from './schemas.js';
import type { WithdrawalApprovalService } from './service.js';

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toTrpcError(error);
  }
}

/**
 * `withdrawalApproval.*`: the customer and approver side of multi-approval withdrawals (W-withdraw-11).
 *
 * - `propose`, `approve` and `reject` move or decide money, so they take `trade:withdraw` (interactive, step-up) like
 *   `pay.withdrawal.create`. The caller is always the token's user: there is no user id input.
 * - `cancel` only withdraws the caller's own waiting request and gives its hold back, so it takes `trade:write` like the
 *   withdrawal cancel.
 * - `get`, `list` and `listForTeam` take `trade:read`. A request is readable by its initiator and by an eligible approver
 *   of its team; anyone else reads the same as no request.
 */
export function createWithdrawalApprovalRouter(service: WithdrawalApprovalService) {
  return router({
    withdrawalApproval: router({
      propose: scopedProcedure('trade:withdraw', { module: 'ledger' })
        .input(proposeInputSchema)
        .output(requestViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.propose(ctx.principal.userId, input))),
      approve: scopedProcedure('trade:withdraw', { module: 'ledger' })
        .input(decideInputSchema)
        .output(requestViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.approve(ctx.principal.userId, input.requestId))),
      reject: scopedProcedure('trade:withdraw', { module: 'ledger' })
        .input(decideInputSchema)
        .output(requestViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.reject(ctx.principal.userId, input.requestId))),
      cancel: scopedProcedure('trade:write', { module: 'ledger' })
        .input(decideInputSchema)
        .output(requestViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.cancel(ctx.principal.userId, input.requestId))),
      get: scopedProcedure('trade:read', { module: 'ledger' })
        .input(getInputSchema)
        .output(requestViewSchema)
        .query(({ ctx, input }) => wrap(() => service.get(ctx.principal.userId, input.requestId))),
      list: scopedProcedure('trade:read', { module: 'ledger' })
        .input(listInputSchema)
        .output(z.array(requestViewSchema))
        .query(({ ctx, input }) => wrap(() => service.list(ctx.principal.userId, input))),
      listForTeam: scopedProcedure('trade:read', { module: 'ledger' })
        .input(listForTeamInputSchema)
        .output(z.array(requestViewSchema))
        .query(({ ctx, input }) => wrap(() => service.listForTeam(ctx.principal.userId, input))),
    }),
  });
}

/** What a mount supplies besides the founder authority. */
export type WithdrawalApprovalMountDeps = { readonly service: WithdrawalApprovalService };

function actorOf(ctx: unknown): string {
  const id = (ctx as Partial<FounderContext>).founderUserId;
  if (typeof id !== 'string' || id.trim() === '') throw new TRPCError({ code: 'FORBIDDEN', message: 'operator.denied' });
  return id;
}

/**
 * `founderAdmin.withdrawalApprovals.*` (W-withdraw-11). Founder-only. `setPolicy` is where the owner sets who approves, how
 * many, the threshold, the window, the expiry and whether the amount is held at submission: nothing has a default, so a
 * blank field is a parse error. `settleDue` expires waiting requests, finishes any release a crash left and runs any request
 * that reached its approvals; it is safe to call repeatedly.
 */
export function createWithdrawalApprovalFounderRouter(deps: WithdrawalApprovalMountDeps & { founderAuthority: FounderAuthority }) {
  const founder = founderProcedure(deps.founderAuthority);
  return router({
    setPolicy: founder
      .input(setPolicyInputSchema)
      .output(policyViewSchema)
      .mutation(({ ctx, input }) => wrap(() => deps.service.setPolicy(actorOf(ctx), input))),
    policy: founder
      .input(policyQueryInputSchema)
      .output(policyViewSchema.nullable())
      .query(({ input }) => wrap(() => deps.service.policy(input.userId, input.assetId))),
    settleDue: founder
      .input(z.object({}).strict())
      .output(settleResultSchema)
      .mutation(({ ctx }) => wrap(() => deps.service.settleDue(actorOf(ctx)))),
  });
}
