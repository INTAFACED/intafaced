import { router, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { FounderAuthority } from '../../founder-authority.js';
import { founderProcedure, type FounderContext } from '../../namespaces/founder-procedure.js';
import { withdrawalReturnToTrpcError } from './errors.js';
import { getInputSchema, listInputSchema, recordInputSchema, recreditInputSchema, returnViewSchema } from './schemas.js';
import { WithdrawalReturnService } from './service.js';

/** What a mount supplies besides the founder authority. */
export type WithdrawalReturnMountDeps = Omit<WithdrawalReturnRouterDeps, 'founderAuthority'>;

export interface WithdrawalReturnRouterDeps {
  readonly founderAuthority: FounderAuthority;
  readonly sql: Sql;
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
    throw withdrawalReturnToTrpcError(error);
  }
}

/**
 * `founderAdmin.withdrawalReturns.*`: returned withdrawals (W-withdraw-07). Founder-only: every procedure is built from
 * `founderProcedure`. Mounted INSIDE the founderAdmin router. A return is recorded and parked; nothing is booked.
 */
export function createWithdrawalReturnRouter(deps: WithdrawalReturnRouterDeps) {
  const founder = founderProcedure(deps.founderAuthority);
  const service = new WithdrawalReturnService({ sql: deps.sql });
  return router({
    record: founder
      .input(recordInputSchema)
      .output(returnViewSchema)
      .mutation(({ ctx, input }) => wrap(() => service.record(actorOf(ctx), input))),
    get: founder
      .input(getInputSchema)
      .output(returnViewSchema)
      .query(({ input }) => wrap(() => service.get(input.withdrawalId))),
    list: founder
      .input(listInputSchema)
      .output(z.array(returnViewSchema))
      .query(({ input }) => wrap(() => service.list(input))),
    recredit: founder
      .input(recreditInputSchema)
      .output(z.never())
      .mutation(({ input }) => wrap(() => service.recredit(input.withdrawalId))),
  });
}
