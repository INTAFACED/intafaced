import { router, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { FounderAuthority } from '../founder-authority.js';
import { founderProcedure, type FounderContext } from '../namespaces/founder-procedure.js';
import type { MessageCipher } from './cipher.js';
import { travelRuleToTrpcError } from './errors.js';
import {
  assessInputSchema,
  assessmentViewSchema,
  expireResultSchema,
  listInputSchema,
  markInputSchema,
  messageInputSchema,
  messageResultSchema,
  openInputSchema,
  ruleViewSchema,
  setRuleInputSchema,
  setWaitLimitsInputSchema,
  transferDetailSchema,
  transferIdInputSchema,
  transferViewSchema,
  waitLimitsViewSchema,
} from './schemas.js';
import { TravelRuleService, type TravelRuleProvider } from './service.js';

/** What a mount supplies besides the founder authority. */
export type TravelRuleMountDeps = Omit<TravelRuleRouterDeps, 'founderAuthority'>;

export interface TravelRuleRouterDeps {
  readonly founderAuthority: FounderAuthority;
  readonly sql: Sql;
  readonly cipher?: MessageCipher | null;
  /** No counterparty network is connected; a send then answers `vendor.travelrule`. */
  readonly provider?: TravelRuleProvider | null;
  /** Tests inject a clock; production uses the wall clock. */
  readonly now?: () => Date;
}

function actorOf(ctx: unknown): string {
  const id = (ctx as Partial<FounderContext>).founderUserId;
  if (typeof id !== 'string' || id.trim() === '') throw new TRPCError({ code: 'FORBIDDEN', message: 'operator.denied' });
  return id;
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw travelRuleToTrpcError(error);
  }
}

/**
 * `founderAdmin.travelRule.*` (W-compliance-notices-04): the owner's applicability rules and wait limits, the transfer
 * records, the encrypted message and the send. Founder-only: every procedure is built from `founderProcedure`. No
 * procedure returns a decrypted message, and none can approve, complete or bypass a transfer: `mark` refuses those with
 * `travel_rule.operator_cannot_bypass`.
 */
export function createTravelRuleRouter(deps: TravelRuleRouterDeps) {
  const founder = founderProcedure(deps.founderAuthority);
  const service = new TravelRuleService({ sql: deps.sql, cipher: deps.cipher, provider: deps.provider, now: deps.now });
  const none = z.object({}).strict();
  return router({
    rules: router({
      list: founder
        .input(none)
        .output(z.array(ruleViewSchema))
        .query(() => wrap(() => service.listRules())),
      set: founder
        .input(setRuleInputSchema)
        .output(ruleViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.setRule(actorOf(ctx), input))),
      assess: founder
        .input(assessInputSchema)
        .output(assessmentViewSchema)
        .query(({ input }) => wrap(() => service.assess(input))),
    }),
    waitLimits: router({
      get: founder
        .input(none)
        .output(waitLimitsViewSchema)
        .query(() => wrap(() => service.waitLimits())),
      set: founder
        .input(setWaitLimitsInputSchema)
        .output(waitLimitsViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.setWaitLimits(actorOf(ctx), input))),
    }),
    transfer: router({
      open: founder
        .input(openInputSchema)
        .output(transferViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.open(actorOf(ctx), input))),
      get: founder
        .input(transferIdInputSchema)
        .output(transferDetailSchema)
        .query(({ input }) => wrap(() => service.get(input.transferId))),
      listByWithdrawal: founder
        .input(z.object({ withdrawalId: z.string().guid() }).strict())
        .output(z.array(transferDetailSchema))
        .query(({ input }) => wrap(() => service.listByWithdrawal(input.withdrawalId))),
      list: founder
        .input(listInputSchema)
        .output(z.array(transferViewSchema))
        .query(({ input }) => wrap(() => service.list(input))),
      mark: founder
        .input(markInputSchema)
        .output(transferViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.operatorMark(actorOf(ctx), input))),
      submit: founder
        .input(transferIdInputSchema)
        .output(transferViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.submit(actorOf(ctx), input.transferId))),
      expireDue: founder
        .input(none)
        .output(expireResultSchema)
        .mutation(async ({ ctx }) => wrap(async () => ({ expired: await service.expireDue(actorOf(ctx)) }))),
    }),
    message: router({
      create: founder
        .input(messageInputSchema)
        .output(messageResultSchema)
        .mutation(({ ctx, input }) => wrap(() => service.attachMessage(actorOf(ctx), input))),
    }),
  });
}
