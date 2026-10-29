/**
 * `trade.bots.grid.*` — the spot grid bot's doors (CB-bots-02, CB-bots-10; J-copy-bots-otc-14).
 *
 * Refusals keep their typed code on `data.cause.code`: a grid field refusal is 400, a bot below the owner's
 * verification level (or a blank level) is 403 as on the algo doors, a missing bot is 404 and a reused request key
 * with a different body is 409. With no grid service mounted every door answers 503 `trade.grid_unavailable`.
 */
import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
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
    stop: scopedProcedure('trade:write', { module: 'trade' })
      .input(z.object({ botId: z.string().min(1).max(64) }))
      .mutation(({ ctx, input }) => call((g) => g.stop(ctx.principal, input.botId))),
  });
}
