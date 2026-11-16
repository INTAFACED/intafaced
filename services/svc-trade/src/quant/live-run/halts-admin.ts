import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { TradeOpsError } from '../../admin/common.js';
import type { StrategyHaltDesk } from './halts.js';

/** A desk refusal keeps its typed code in the message's last bracket, where the console reads it. */
function fail(error: unknown): never {
  if (error instanceof TradeOpsError) {
    const code: TRPCError['code'] = error.code.endsWith('_not_found')
      ? 'NOT_FOUND'
      : error.code.startsWith('approval_') ||
          error.code.endsWith('_conflict') ||
          error.code.endsWith('_decided') ||
          error.code === 'quant_halt_already_halted' ||
          error.code === 'quant_halt_not_halted' ||
          error.code === 'quant_halt_nothing_live'
        ? 'CONFLICT'
        : 'BAD_REQUEST';
    throw new TRPCError({ code, message: `${error.message} [trade_ops.${error.code}]`, cause: error });
  }
  throw error;
}

/**
 * `admin.quantLive.*` (J-algo-dev-11; halts.ts): the risk desk over every person's live strategy runs. Reads are
 * `admin:read`; halting one strategy is one operator's `admin:write` with a reason; halting every strategy and every
 * restore is `propose` by one founder and `confirm` by a second.
 */
export function quantLiveAdminRouter(desk?: StrategyHaltDesk | null) {
  const ready = (): StrategyHaltDesk => {
    if (!desk)
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'the live strategy desk is off [trade_ops.quant_halt_unavailable]' });
    return desk;
  };
  return router({
    quantLive: router({
      desk: scopedProcedure('admin:read', { module: 'trade' }).query(({ ctx }) => ready().desk(ctx.principal).catch(fail)),
      request: scopedProcedure('admin:read', { module: 'trade' })
        .input(z.object({ requestId: z.string().uuid() }).strict())
        .query(({ ctx, input }) => ready().request(ctx.principal, input.requestId).catch(fail)),
      halt: scopedProcedure('admin:write', { module: 'trade' })
        .input(
          z
            .object({
              requestId: z.string().uuid(),
              userId: z.string().trim().min(1).max(128),
              strategyId: z.string().trim().min(1).max(128),
              reason: z.string().max(500),
            })
            .strict(),
        )
        .mutation(({ ctx, input }) => ready().halt(ctx.principal, input).catch(fail)),
      propose: scopedProcedure('admin:write', { module: 'trade' })
        .input(
          z
            .object({
              requestId: z.string().uuid(),
              op: z.enum(['halt_all', 'restore', 'restore_all']),
              haltId: z.string().uuid().nullable(),
              reason: z.string().max(500),
              approvalId: z.string().trim().min(1).max(128),
            })
            .strict(),
        )
        .mutation(({ ctx, input }) => ready().propose(ctx.principal, input).catch(fail)),
      confirm: scopedProcedure('admin:write', { module: 'trade' })
        .input(z.object({ requestId: z.string().uuid(), operationId: z.string().trim().min(1).max(128) }).strict())
        .mutation(({ ctx, input }) => ready().confirm(ctx.principal, input).catch(fail)),
    }),
  });
}
