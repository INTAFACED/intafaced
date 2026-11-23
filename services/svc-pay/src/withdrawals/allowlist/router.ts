import { router, TRPCError } from '@intafaced/contracts/trpc';
import {
  PAY_ALLOWLIST_APPROVE,
  PAY_ALLOWLIST_CANCEL,
  PAY_ALLOWLIST_GET,
  PAY_ALLOWLIST_LIST_CHANGES,
  PAY_ALLOWLIST_LIST_ENTRIES,
  PAY_ALLOWLIST_LIST_FOR_TEAM,
  PAY_ALLOWLIST_MODE,
  PAY_ALLOWLIST_POLICY,
  PAY_ALLOWLIST_PROPOSE_ADD,
  PAY_ALLOWLIST_PROPOSE_DELETE,
  PAY_ALLOWLIST_PROPOSE_POLICY,
  PAY_ALLOWLIST_REJECT,
  PAY_ALLOWLIST_SET_MODE,
} from '@intafaced/contracts/pay-allowlist-procedures';
import {
  payAllowlistEntrySchema,
  payAllowlistChangeSchema,
  payAllowlistModeSchema,
  payAllowlistPolicySchema,
} from '@intafaced/contracts/pay-money-room';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { z } from 'zod';
import type { FounderAuthority } from '../../founder-authority.js';
import { founderProcedure, type FounderContext } from '../../namespaces/founder-procedure.js';
import { payRefusal } from '../../record-refusal.js';
import { toTrpcError } from '../../router.js';
import { quorumViewSchema, resumeInputSchema, setQuorumInputSchema, suspendInputSchema, userQueryInputSchema } from './schemas.js';
import type { AllowlistService } from './service.js';

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toTrpcError(error);
  }
}

/**
 * `allowlist.*`: the customer and approver side of the withdrawal allowlist (W-withdraw-10), mounted from its records
 * (`@intafaced/contracts/pay-allowlist-procedures`), which name each call's scope, input, answer and refusals. The caller
 * is always the token's user. A change is readable by its requester and by an eligible approver of its team.
 */
export function createAllowlistRouter(service: AllowlistService) {
  return router({
    allowlist: router({
      mode: mountRecord(PAY_ALLOWLIST_MODE, ({ ctx }) => wrap(() => service.mode(ctx.principal.userId)), payRefusal),
      policy: mountRecord(PAY_ALLOWLIST_POLICY, ({ ctx }) => wrap(() => service.policy(ctx.principal.userId)), payRefusal),
      setMode: mountRecord(
        PAY_ALLOWLIST_SET_MODE,
        ({ ctx, input }) => wrap(() => service.setMode(ctx.principal.userId, input)),
        payRefusal,
      ),
      proposePolicy: mountRecord(
        PAY_ALLOWLIST_PROPOSE_POLICY,
        ({ ctx, input }) => wrap(() => service.proposePolicy(ctx.principal.userId, input)),
        payRefusal,
      ),
      proposeAdd: mountRecord(
        PAY_ALLOWLIST_PROPOSE_ADD,
        ({ ctx, input }) => wrap(() => service.proposeAdd(ctx.principal.userId, input)),
        payRefusal,
      ),
      proposeDelete: mountRecord(
        PAY_ALLOWLIST_PROPOSE_DELETE,
        ({ ctx, input }) => wrap(() => service.proposeDelete(ctx.principal.userId, input)),
        payRefusal,
      ),
      approve: mountRecord(
        PAY_ALLOWLIST_APPROVE,
        ({ ctx, input }) => wrap(() => service.approve(ctx.principal.userId, input.changeId, input.requestHash)),
        payRefusal,
      ),
      reject: mountRecord(
        PAY_ALLOWLIST_REJECT,
        ({ ctx, input }) => wrap(() => service.reject(ctx.principal.userId, input.changeId, input.requestHash)),
        payRefusal,
      ),
      cancel: mountRecord(
        PAY_ALLOWLIST_CANCEL,
        ({ ctx, input }) => wrap(() => service.cancel(ctx.principal.userId, input.changeId)),
        payRefusal,
      ),
      get: mountRecord(PAY_ALLOWLIST_GET, ({ ctx, input }) => wrap(() => service.get(ctx.principal.userId, input.changeId)), payRefusal),
      listEntries: mountRecord(
        PAY_ALLOWLIST_LIST_ENTRIES,
        ({ ctx, input }) => wrap(() => service.listEntries(ctx.principal.userId, input)),
        payRefusal,
      ),
      listChanges: mountRecord(
        PAY_ALLOWLIST_LIST_CHANGES,
        ({ ctx, input }) => wrap(() => service.listChanges(ctx.principal.userId, input)),
        payRefusal,
      ),
      listForTeam: mountRecord(
        PAY_ALLOWLIST_LIST_FOR_TEAM,
        ({ ctx, input }) => wrap(() => service.listForTeam(ctx.principal.userId, input)),
        payRefusal,
      ),
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
      .input(z.object({ userId: z.string().guid() }).strict())
      .output(quorumViewSchema.nullable())
      .query(({ input }) => wrap(() => deps.service.quorum(input.userId))),
    mode: founder
      .input(z.object({ userId: z.string().guid() }).strict())
      .output(payAllowlistModeSchema)
      .query(({ input }) => wrap(() => deps.service.mode(input.userId))),
    policy: founder
      .input(z.object({ userId: z.string().guid() }).strict())
      .output(payAllowlistPolicySchema)
      .query(({ input }) => wrap(() => deps.service.policy(input.userId))),
    entries: founder
      .input(userQueryInputSchema)
      .output(z.array(payAllowlistEntrySchema))
      .query(({ input }) => wrap(() => deps.service.listEntries(input.userId, input, true))),
    changes: founder
      .input(userQueryInputSchema)
      .output(z.array(payAllowlistChangeSchema))
      .query(({ input }) => wrap(() => deps.service.listChanges(input.userId, input))),
    suspend: founder
      .input(suspendInputSchema)
      .output(payAllowlistEntrySchema)
      .mutation(({ ctx, input }) => wrap(() => deps.service.suspend(actorOf(ctx), input.entryId, input.reason))),
    resume: founder
      .input(resumeInputSchema)
      .output(payAllowlistEntrySchema)
      .mutation(({ ctx, input }) => wrap(() => deps.service.resume(actorOf(ctx), input.entryId))),
  });
}
