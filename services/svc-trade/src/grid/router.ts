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
import { mountRecord, type RefusalOf } from '@intafaced/contracts/procedure-mount';
import { GRID_SUBMIT_PERMISSION } from '@intafaced/contracts/trade-grid-procedures';
import { TradeError } from '../spot/types.js';
import { TradingControlError } from '../controls/trading-controls.js';
import { GRID_CONFLICT_CODES, GRID_NOT_FOUND_CODES, GridError } from './errors.js';
import type { GridService } from './grid-service.js';
import type { VenueGrid } from './venue-grid.js';

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
          : error.code === 'trade.api_withdraw_not_allowed' || error.code === 'trade.bots_grid_withdraw_not_permitted'
            ? 'FORBIDDEN'
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

/** svc-trade's grid refusals in their wire form, read once for every grid record (procedure-mount.ts). */
export const gridRefusalOf: RefusalOf = (err) => {
  const wire = gridTrpcError(err);
  if (!(wire instanceof TRPCError)) return undefined;
  const cause: unknown = wire.cause;
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  return typeof code === 'string' ? { code, error: wire } : undefined;
};

/** Decimal strings only on the wire; blank is allowed through so the service names the blank field. */
const decimalOrBlank = z.string().max(64).optional().nullable();

/**
 * With the user-venue door on, a grid trades on the person's own venue account (venue-grid.ts): create makes a
 * venue grid, and every door that names a venue grid's id answers for it. With the door off, the grid on our own book
 * (grid-service.ts) answers, as before.
 */
export function gridRouter(grid?: GridService, venueGrid?: VenueGrid | null) {
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
          /** The person's own venue account (their wallet) a venue grid trades on. */
          owner: z.string().max(64).optional().nullable(),
        }),
      )
      .mutation(({ ctx, input }) =>
        call((g): Promise<unknown> => (venueGrid ? venueGrid.create(ctx.principal, input, ctx.region) : g.create(ctx.principal, input))),
      ),
    get: scopedProcedure('trade:read', { module: 'trade' })
      .input(z.object({ botId: z.string().min(1).max(64) }))
      .query(({ ctx, input }) =>
        call(async (g): Promise<unknown> =>
          venueGrid && (await venueGrid.has(input.botId)) ? venueGrid.get(ctx.principal, input.botId) : g.get(ctx.principal, input.botId),
        ),
      ),
    list: scopedProcedure('trade:read', { module: 'trade' }).query(({ ctx }) =>
      call(async (g): Promise<unknown[]> => [...(venueGrid ? await venueGrid.list(ctx.principal) : []), ...(await g.list(ctx.principal))]),
    ),
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
      .mutation(({ ctx, input }) =>
        call(async (g): Promise<unknown> =>
          venueGrid && (await venueGrid.has(input.botId))
            ? venueGrid.withdrawProfit(ctx.principal, input.botId)
            : g.withdrawProfit(ctx.principal, input),
        ),
      ),
    topUpFree: scopedProcedure('trade:read', { module: 'trade' })
      .input(z.object({ botId: z.string().min(1).max(64) }))
      .query(({ ctx, input }) => call((g) => g.topUpFree(ctx.principal, input.botId))),
    topUp: scopedProcedure('trade:write', { module: 'trade' })
      .input(
        z.object({
          botId: z.string().min(1).max(64),
          requestId: z.string().min(8).max(120),
          asset: z.string().max(16).optional().nullable(),
          amount: decimalOrBlank,
        }),
      )
      .mutation(({ ctx, input }) => call((g) => g.topUp(ctx.principal, input))),
    modify: scopedProcedure('trade:write', { module: 'trade' })
      .input(
        z.object({
          botId: z.string().min(1).max(64),
          trailing: z.boolean().optional().nullable(),
          shiftLimitPercent: decimalOrBlank,
          minGridCount: z.number().int().optional().nullable(),
        }),
      )
      .mutation(({ ctx, input }) => call((g) => g.modify(ctx.principal, input))),
    stop: scopedProcedure('trade:write', { module: 'trade' })
      .input(z.object({ botId: z.string().min(1).max(64) }))
      .mutation(({ ctx, input }) =>
        call(async (g): Promise<unknown> =>
          venueGrid && (await venueGrid.has(input.botId)) ? venueGrid.stop(ctx.principal, input.botId) : g.stop(ctx.principal, input.botId),
        ),
      ),
    submitPermission: mountRecord(
      GRID_SUBMIT_PERMISSION,
      ({ ctx, input }) =>
        call(async () => {
          if (!venueGrid) throw new GridError('The grid bot service is not mounted', 'trade.grid_unavailable');
          return venueGrid.submitPermission(ctx.principal, input);
        }),
      gridRefusalOf,
    ),
  });
}
