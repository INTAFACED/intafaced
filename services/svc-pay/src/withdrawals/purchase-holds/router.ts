import { router, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { FounderAuthority } from '../../founder-authority.js';
import { founderProcedure, type FounderContext } from '../../namespaces/founder-procedure.js';
import { purchaseHoldToTrpcError } from './errors.js';
import {
  holdViewSchema,
  listInputSchema,
  policyViewSchema,
  recordInputSchema,
  releaseDueInputSchema,
  releaseResultSchema,
  setPolicyInputSchema,
} from './schemas.js';
import { PurchaseHoldService } from './service.js';

/** What a mount supplies besides the founder authority. */
export type PurchaseHoldMountDeps = Omit<PurchaseHoldRouterDeps, 'founderAuthority'>;

export interface PurchaseHoldRouterDeps {
  readonly founderAuthority: FounderAuthority;
  readonly sql: Sql;
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
    throw purchaseHoldToTrpcError(error);
  }
}

/**
 * `founderAdmin.purchaseHolds.*`: holds on funds bought by card, ACH or PayPal (W-withdraw-13). Founder-only: every
 * procedure is built from `founderProcedure`. Mounted INSIDE the founderAdmin router. Recording a hold moves no money;
 * it limits what may be withdrawn. The release period is set by the owner here and is never defaulted.
 */
export function createPurchaseHoldRouter(deps: PurchaseHoldRouterDeps) {
  const founder = founderProcedure(deps.founderAuthority);
  const service = new PurchaseHoldService({ sql: deps.sql, now: deps.now });
  return router({
    record: founder
      .input(recordInputSchema)
      .output(holdViewSchema)
      .mutation(({ ctx, input }) => wrap(() => service.record(actorOf(ctx), input))),
    list: founder
      .input(listInputSchema)
      .output(z.array(holdViewSchema))
      .query(({ input }) => wrap(() => service.list(input))),
    policy: founder
      .input(z.object({}).strict())
      .output(policyViewSchema)
      .query(() => wrap(() => service.policy())),
    setPolicy: founder
      .input(setPolicyInputSchema)
      .output(policyViewSchema)
      .mutation(({ ctx, input }) => wrap(() => service.setPolicy(actorOf(ctx), input))),
    releaseDue: founder
      .input(releaseDueInputSchema)
      .output(releaseResultSchema)
      .mutation(({ ctx }) => wrap(() => service.releaseDue(actorOf(ctx)))),
  });
}
