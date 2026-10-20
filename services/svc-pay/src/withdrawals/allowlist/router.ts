import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { z } from 'zod';
import type { FounderAuthority } from '../../founder-authority.js';
import { founderProcedure, type FounderContext } from '../../namespaces/founder-procedure.js';
import { toTrpcError } from '../../router.js';
import {
  cancelInputSchema,
  changeViewSchema,
  decideInputSchema,
  entryViewSchema,
  getInputSchema,
  listForTeamInputSchema,
  listInputSchema,
  modeViewSchema,
  policyViewSchema,
  proposeAddInputSchema,
  proposeDeleteInputSchema,
  proposePolicyInputSchema,
  quorumViewSchema,
  resumeInputSchema,
  setModeInputSchema,
  setModeResultSchema,
  setQuorumInputSchema,
  suspendInputSchema,
  userQueryInputSchema,
} from './schemas.js';
import type { AllowlistService } from './service.js';

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toTrpcError(error);
  }
}

/**
 * `allowlist.*`: the customer and approver side of the withdrawal allowlist (W-withdraw-10).
 *
 * - Everything that changes the list, the mode or the one-time policy takes `trade:withdraw` (interactive, step-up) like
 *   `pay.withdrawal.create`: the list decides where money may go. The caller is always the token's user.
 * - `cancel` only withdraws the caller's own waiting change, so it takes `trade:write`.
 * - Reads take `trade:read`. A change is readable by its requester and by an eligible approver of its team.
 */
export function createAllowlistRouter(service: AllowlistService) {
  return router({
    allowlist: router({
      mode: scopedProcedure('trade:read', { module: 'ledger' })
        .input(z.object({}).strict())
        .output(modeViewSchema)
        .query(({ ctx }) => wrap(() => service.mode(ctx.principal.userId))),
      policy: scopedProcedure('trade:read', { module: 'ledger' })
        .input(z.object({}).strict())
        .output(policyViewSchema)
        .query(({ ctx }) => wrap(() => service.policy(ctx.principal.userId))),
      setMode: scopedProcedure('trade:withdraw', { module: 'ledger' })
        .input(setModeInputSchema)
        .output(setModeResultSchema)
        .mutation(({ ctx, input }) => wrap(() => service.setMode(ctx.principal.userId, input))),
      proposePolicy: scopedProcedure('trade:withdraw', { module: 'ledger' })
        .input(proposePolicyInputSchema)
        .output(changeViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.proposePolicy(ctx.principal.userId, input))),
      proposeAdd: scopedProcedure('trade:withdraw', { module: 'ledger' })
        .input(proposeAddInputSchema)
        .output(changeViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.proposeAdd(ctx.principal.userId, input))),
      proposeDelete: scopedProcedure('trade:withdraw', { module: 'ledger' })
        .input(proposeDeleteInputSchema)
        .output(changeViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.proposeDelete(ctx.principal.userId, input))),
      approve: scopedProcedure('trade:withdraw', { module: 'ledger' })
        .input(decideInputSchema)
        .output(changeViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.approve(ctx.principal.userId, input.changeId, input.requestHash))),
      reject: scopedProcedure('trade:withdraw', { module: 'ledger' })
        .input(decideInputSchema)
        .output(changeViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.reject(ctx.principal.userId, input.changeId, input.requestHash))),
      cancel: scopedProcedure('trade:write', { module: 'ledger' })
        .input(cancelInputSchema)
        .output(changeViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.cancel(ctx.principal.userId, input.changeId))),
      get: scopedProcedure('trade:read', { module: 'ledger' })
        .input(getInputSchema)
        .output(changeViewSchema)
        .query(({ ctx, input }) => wrap(() => service.get(ctx.principal.userId, input.changeId))),
      listEntries: scopedProcedure('trade:read', { module: 'ledger' })
        .input(listInputSchema)
        .output(z.array(entryViewSchema))
        .query(({ ctx, input }) => wrap(() => service.listEntries(ctx.principal.userId, input))),
      listChanges: scopedProcedure('trade:read', { module: 'ledger' })
        .input(listInputSchema)
        .output(z.array(changeViewSchema))
        .query(({ ctx, input }) => wrap(() => service.listChanges(ctx.principal.userId, input))),
      listForTeam: scopedProcedure('trade:read', { module: 'ledger' })
        .input(listForTeamInputSchema)
        .output(z.array(changeViewSchema))
        .query(({ ctx, input }) => wrap(() => service.listForTeam(ctx.principal.userId, input))),
    }),
  });
}

/** What a mount supplies besides the founder authority. */
export type AllowlistMountDeps = { readonly service: AllowlistService };

function actorOf(ctx: unknown): string {
  const id = (ctx as Partial<FounderContext>).founderUserId;
  if (typeof id !== 'string' || id.trim() === '') throw new TRPCError({ code: 'FORBIDDEN', message: 'operator.denied' });
  return id;
}

/**
 * `founderAdmin.allowlist.*` (W-withdraw-10). Founder-only. `setQuorum` is where the owner sets who approves list changes
 * for a user and how many: nothing has a default, so a blank field is a parse error. The reads show a user's list, changes,
 * mode and one-time policy to the operator desks. `suspend` and `resume` stop and restore one entry at once.
 */
export function createAllowlistFounderRouter(deps: AllowlistMountDeps & { founderAuthority: FounderAuthority }) {
  const founder = founderProcedure(deps.founderAuthority);
  return router({
    setQuorum: founder
      .input(setQuorumInputSchema)
      .output(quorumViewSchema)
      .mutation(({ ctx, input }) => wrap(() => deps.service.setQuorum(actorOf(ctx), input))),
    quorum: founder
      .input(z.object({ userId: z.string().uuid() }).strict())
      .output(quorumViewSchema.nullable())
      .query(({ input }) => wrap(() => deps.service.quorum(input.userId))),
    mode: founder
      .input(z.object({ userId: z.string().uuid() }).strict())
      .output(modeViewSchema)
      .query(({ input }) => wrap(() => deps.service.mode(input.userId))),
    policy: founder
      .input(z.object({ userId: z.string().uuid() }).strict())
      .output(policyViewSchema)
      .query(({ input }) => wrap(() => deps.service.policy(input.userId))),
    entries: founder
      .input(userQueryInputSchema)
      .output(z.array(entryViewSchema))
      .query(({ input }) => wrap(() => deps.service.listEntries(input.userId, input, true))),
    changes: founder
      .input(userQueryInputSchema)
      .output(z.array(changeViewSchema))
      .query(({ input }) => wrap(() => deps.service.listChanges(input.userId, input))),
    suspend: founder
      .input(suspendInputSchema)
      .output(entryViewSchema)
      .mutation(({ ctx, input }) => wrap(() => deps.service.suspend(actorOf(ctx), input.entryId, input.reason))),
    resume: founder
      .input(resumeInputSchema)
      .output(entryViewSchema)
      .mutation(({ ctx, input }) => wrap(() => deps.service.resume(actorOf(ctx), input.entryId))),
  });
}
