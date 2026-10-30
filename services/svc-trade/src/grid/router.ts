/**
 * `trade.bots.grid.*` — the spot grid bot's doors (CB-bots-02, CB-bots-10; J-copy-bots-otc-14).
 *
 * Refusals keep their typed code on `data.cause.code`: a grid field refusal is 400, a bot below the owner's
 * verification level (or a blank level) is 403 as on the algo doors, a missing bot is 404 and a reused request key
 * with a different body is 409. A withdrawal's step-up codes come from identity unchanged: `identity.step_up_required`
 * is 403 and `identity.step_up_unavailable` 503. With no grid service mounted every door answers 503 `trade.grid_unavailable`.
 */
import { z } from 'zod';
import { router, scopedProcedure, StepUpCheckError, TRPCError } from '@intafaced/contracts';
import { TradeError } from '../spot/types.js';
import { TradingControlError } from '../controls/trading-controls.js';
import { GRID_CONFLICT_CODES, GRID_NOT_FOUND_CODES, GridError } from './errors.js';
import type { GridService } from './grid-service.js';

const VERIFICATION_CODES = new Set(['trade.bots_verification_insufficient', 'trade.bots_verification_level_not_set']);

export function gridTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof GridError) {
    const code = GRID_NOT_FOUND_CODES.has(error.code)
      ? 'NOT_FOUND'
      : GRID_CONFLICT_CODES.has(error.code)
        ? 'CONFLICT'
        : error.code === 'trade.grid_unavailable'
          ? 'SERVICE_UNAVAILABLE'
          : 'BAD_REQUEST';
    return new TRPCError({ code, message: error.message, cause: error });
  }
  // Identity's step-up codes reach the person unchanged: confirm again (403), or identity could not check it (503).
  if (error instanceof StepUpCheckError) {
    const code = error.code === 'identity.step_up_required' ? 'FORBIDDEN' : 'SERVICE_UNAVAILABLE';
    return new TRPCError({ code, message: error.message, cause: error });
  }
  if (error instanceof TradeError && VERIFICATION_CODES.has(error.code)) {
    return new TRPCError({ code: 'FORBIDDEN', message: error.message, cause: error });
  }
  if (error instanceof TradeError) return new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
  if (error instanceof TradingControlError) return new TRPCError({ code: 'FORBIDDEN', message: error.message, cause: error });
  return error;
}

/** Decimal strings only on the wire; blank is allowed through so the service names the blank field. */
const decimalOrBlank = z.string().max(64).optional().nullable();

export function gridRouter(grid?: GridService) {
  async function call<T>(fn: (grid: GridService) => Promise<T> | T): Promise<T> {
    try {
      if (!grid) throw new GridError('The grid bot service is not mounted', 'trade.grid_unavailable');
      return await fn(grid);
    } catch (error) {
      throw gridTrpcError(error);
    }
  }
  return router({
    setup: scopedProcedure('trade:read', { module: 'trade' }).query(({ ctx }) => call((g) => g.setup(ctx.principal))),
    presets: scopedProcedure('trade:read', { module: 'trade' }).query(() => call((g) => g.presets())),
    create: scopedProcedure('trade:write', { module: 'trade' })
      .input(
        z.object({
          clientRequestId: z.string().min(8).max(120),
          symbol: z.string().min(3).max(64),
          lowerPrice: decimalOrBlank,
          upperPrice: decimalOrBlank,
          gridCount: z.number().int().optional().nullable(),
          investment: decimalOrBlank,
        }),
      )
      .mutation(({ ctx, input }) => call((g) => g.create(ctx.principal, input))),
    get: scopedProcedure('trade:read', { module: 'trade' })
      .input(z.object({ botId: z.string().min(1).max(64) }))
      .query(({ ctx, input }) => call((g) => g.get(ctx.principal, input.botId))),
    list: scopedProcedure('trade:read', { module: 'trade' }).query(({ ctx }) => call((g) => g.list(ctx.principal))),
    withdrawProfit: scopedProcedure('trade:write', { module: 'trade' })
      .input(
        z.object({
          botId: z.string().min(1).max(64),
          requestId: z.string().min(8).max(120),
          asset: z.string().min(2).max(16),
          amount: decimalOrBlank,
          stepUpApprovalId: z.string().max(128).optional().nullable(),
        }),
      )
      .mutation(({ ctx, input }) => call((g) => g.withdrawProfit(ctx.principal, input))),
    stop: scopedProcedure('trade:write', { module: 'trade' })
      .input(z.object({ botId: z.string().min(1).max(64) }))
      .mutation(({ ctx, input }) => call((g) => g.stop(ctx.principal, input.botId))),
  });
}
