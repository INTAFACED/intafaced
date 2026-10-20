import { router, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { ActionApprovalConsumer } from '../action-approval-consume.js';
import type { FounderAuthority } from '../founder-authority.js';
import { founderProcedure, type FounderContext } from '../namespaces/founder-procedure.js';
import { limitChangeToTrpcError } from './change-errors.js';
import {
  limitChangeInputSchema,
  limitEventViewSchema,
  limitHistoryInputSchema,
  limitPreviewInputSchema,
  limitPreviewSchema,
  limitViewSchema,
} from './change-schemas.js';
import { LimitChangeService } from './change-service.js';

/** What a mount supplies besides the founder authority. */
export type WithdrawalLimitsMountDeps = Omit<WithdrawalLimitsRouterDeps, 'founderAuthority'>;

export interface WithdrawalLimitsRouterDeps {
  readonly founderAuthority: FounderAuthority;
  readonly sql: Sql;
  readonly approvals: ActionApprovalConsumer;
}

/** The authority middleware put the verified founder id on the context. A missing one refuses. */
function actorOf(ctx: unknown): string {
  const id = (ctx as Partial<FounderContext>).founderUserId;
  if (typeof id !== 'string' || id.trim() === '') throw new TRPCError({ code: 'FORBIDDEN', message: 'operator.denied' });
  return id;
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw limitChangeToTrpcError(error);
  }
}

/**
 * `founderAdmin.limits.*`: the owner-set withdrawal limits per KYC tier and asset
 * (W-withdraw-05). Founder-only: every procedure is built from `founderProcedure`.
 * Mounted INSIDE the founderAdmin router (see namespaces/founder-admin.ts).
 */
export function createWithdrawalLimitsRouter(deps: WithdrawalLimitsRouterDeps) {
  const founder = founderProcedure(deps.founderAuthority);
  const service = new LimitChangeService({ sql: deps.sql, approvals: deps.approvals });
  return router({
    list: founder
      .input(z.object({}).strict().optional())
      .output(z.array(limitViewSchema))
      .query(() => wrap(() => service.list())),
    history: founder
      .input(limitHistoryInputSchema)
      .output(z.array(limitEventViewSchema))
      .query(({ input }) => wrap(() => service.history(input.tier, input.assetId, input.limit))),
    /** What a change would need (a second founder or not) and the hash that founder's approval must bind to. */
    preview: founder
      .input(limitPreviewInputSchema)
      .output(limitPreviewSchema)
      .query(({ input }) => wrap(() => service.preview(input))),
    change: founder
      .input(limitChangeInputSchema)
      .output(limitViewSchema)
      .mutation(({ ctx, input }) => wrap(() => service.change(actorOf(ctx), input))),
  });
}
export type WithdrawalLimitsRouter = ReturnType<typeof createWithdrawalLimitsRouter>;
