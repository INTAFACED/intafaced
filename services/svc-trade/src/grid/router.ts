/**
 * `trade.bots.grid.*` — the spot grid bot's doors (CB-bots-02, CB-bots-10; J-copy-bots-otc-14).
 *
 * Refusals keep their typed code on `data.cause.code`: a grid field refusal is 400, a bot below the owner's
 * verification level (or a blank level) is 403 as on the algo doors, a missing bot is 404 and a reused request key
 * with a different body is 409. A withdrawal's step-up codes come from identity unchanged: `identity.step_up_required`
 * is 403 and `identity.step_up_unavailable` 503. With no grid service mounted every door answers 503 `trade.grid_unavailable`.
 */
import { z } from 'zod';
import { StepUpCheckError } from '@intafaced/contracts/step-up-check';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts/trpc';
import { mountRecord, type RefusalOf } from '@intafaced/contracts/procedure-mount';
import { GRID_SET_EXITS, GRID_SET_IDLE_YIELD, GRID_SUBMIT_PERMISSION, venueGridSchema } from '@intafaced/contracts/trade-grid-procedures';
import { answerKeys } from '../answer-keys.js';
import { TradeError } from '../spot/types.js';
import { TradingControlError } from '../controls/trading-controls.js';
import { GRID_CONFLICT_CODES, GRID_NOT_FOUND_CODES, GridError } from './errors.js';
import type { GridBotView, GridPresetsView, GridService, GridSetupView, GridTopUpView, GridWithdrawalView } from './grid-service.js';
import type { VenueGrid, VenueGridView } from './venue-grid.js';

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
const gridRefusalOf: RefusalOf = (err) => {
  const wire = gridTrpcError(err);
  if (!(wire instanceof TRPCError)) return undefined;
  const cause: unknown = wire.cause;
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  return typeof code === 'string' ? { code, error: wire } : undefined;
};

/** Decimal strings only on the wire; blank is allowed through so the service names the blank field. */
const decimalOrBlank = z.string().max(64).optional().nullable();

/**
 * The answer schemas: each names every key its handler answers with (`answerKeys`) and checks no more than the
 * handler's own type, so a reply leaves exactly as it did before the schema was added.
 */
const gridSetupAnswer = z.object({
  countRange: z.object({ min: z.number(), max: z.number() }).nullable(),
  boundsMaxDistanceBps: z.number().nullable(),
});
answerKeys<GridSetupView>()(gridSetupAnswer);

const gridPresetsAnswer = z.object({ source: z.null(), presets: z.tuple([]).readonly() });
answerKeys<GridPresetsView>()(gridPresetsAnswer);

const gridSide = z.enum(['buy', 'sell']);
/** A grid on our own book (grid-service.ts). */
const ownGridAnswer = z.object({
  botId: z.string(),
  clientRequestId: z.string(),
  symbol: z.string(),
  baseAsset: z.string(),
  quoteAsset: z.string(),
  lowerPrice: z.string(),
  upperPrice: z.string(),
  gridCount: z.number(),
  investment: z.string(),
  reinitCount: z.number(),
  status: z.enum(['initializing', 'running', 'paused_range', 'initialization_failed', 'stopped']),
  statusReason: z.string().nullable(),
  reserve: z.object({ key: z.string(), asset: z.string(), amount: z.string(), releasedAt: z.string().nullable() }).nullable(),
  levels: z
    .array(
      z.object({
        index: z.number(),
        price: z.string(),
        qty: z.string(),
        hold: z.string(),
        openOrder: z.object({ side: gridSide, orderId: z.string(), clientOrderId: z.string() }).nullable(),
      }),
    )
    .readonly(),
  orders: z
    .array(
      z.object({
        clientOrderId: z.string(),
        orderId: z.string(),
        levelIndex: z.number(),
        side: gridSide,
        cycle: z.number(),
        price: z.string(),
        qty: z.string(),
        holdAmount: z.string(),
        status: z.enum(['open', 'filled', 'partial', 'cancelled']),
        pairProfit: z.string().nullable(),
      }),
    )
    .readonly(),
  exits: z.object({ stopBelow: z.string().nullable(), stopAbove: z.string().nullable(), rsi: z.object({ source: z.null() }) }),
  gridProfit: z.string(),
  withdrawableProfit: z.string(),
  closedPairs: z.number(),
  gridApr: z.union([
    z.object({ state: z.literal('under_a_day'), percent: z.null() }),
    z.object({ state: z.literal('set'), percent: z.string() }),
  ]),
  createdAt: z.string(),
});
answerKeys<GridBotView>()(ownGridAnswer);

/**
 * A grid on the person's own venue account (venue-grid.ts) or on our own book. The venue form is tried first: only it
 * has `venue`, so a grid on our own book never reads as one.
 */
const gridAnswer = z.union([venueGridSchema, ownGridAnswer]);
answerKeys<VenueGridView | GridBotView>()(gridAnswer);

const gridWithdrawalAnswer = z.object({
  withdrawalId: z.string(),
  botId: z.string(),
  asset: z.string(),
  amount: z.string(),
  profitBefore: z.string(),
  profitAfter: z.string(),
  reserveBefore: z.string(),
  reserveAfter: z.string(),
  dailyCap: z.string(),
  capUsed: z.string(),
  capRemaining: z.string(),
  stepUpEventId: z.string(),
  appliedAt: z.string(),
});
answerKeys<GridWithdrawalView>()(gridWithdrawalAnswer);

const gridTopUpFreeAnswer = z.object({ asset: z.string(), free: z.string() });
answerKeys<Awaited<ReturnType<GridService['topUpFree']>>>()(gridTopUpFreeAnswer);

const gridTopUpAnswer = z.object({
  topUpId: z.string(),
  botId: z.string(),
  asset: z.string(),
  amount: z.string(),
  investmentBefore: z.string(),
  investmentAfter: z.string(),
  freeBefore: z.string(),
  appliedAt: z.string(),
  bot: ownGridAnswer,
});
answerKeys<GridTopUpView>()(gridTopUpAnswer);

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
    setup: scopedProcedure('trade:read', { module: 'trade' })
      .output(gridSetupAnswer)
      .query(({ ctx }) => call((g) => g.setup(ctx.principal))),
    presets: scopedProcedure('trade:read', { module: 'trade' })
      .output(gridPresetsAnswer)
      .query(() => call((g) => g.presets())),
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
      .output(gridAnswer)
      .mutation(({ ctx, input }) =>
        call((g): Promise<VenueGridView | GridBotView> =>
          venueGrid ? venueGrid.create(ctx.principal, input, ctx.region) : g.create(ctx.principal, input),
        ),
      ),
    get: scopedProcedure('trade:read', { module: 'trade' })
      .input(z.object({ botId: z.string().min(1).max(64) }))
      .output(gridAnswer)
      .query(({ ctx, input }) =>
        call(async (g): Promise<VenueGridView | GridBotView> =>
          venueGrid && (await venueGrid.has(input.botId)) ? venueGrid.get(ctx.principal, input.botId) : g.get(ctx.principal, input.botId),
        ),
      ),
    list: scopedProcedure('trade:read', { module: 'trade' })
      .output(z.array(gridAnswer))
      .query(({ ctx }) =>
        call(async (g): Promise<Array<VenueGridView | GridBotView>> => [
          ...(venueGrid ? await venueGrid.list(ctx.principal) : []),
          ...(await g.list(ctx.principal)),
        ]),
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
      .output(gridWithdrawalAnswer)
      .mutation(({ ctx, input }) =>
        call(async (g): Promise<GridWithdrawalView> =>
          venueGrid && (await venueGrid.has(input.botId))
            ? venueGrid.withdrawProfit(ctx.principal, input.botId)
            : g.withdrawProfit(ctx.principal, input),
        ),
      ),
    topUpFree: scopedProcedure('trade:read', { module: 'trade' })
      .input(z.object({ botId: z.string().min(1).max(64) }))
      .output(gridTopUpFreeAnswer)
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
      .output(gridTopUpAnswer)
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
      .output(ownGridAnswer)
      .mutation(({ ctx, input }) => call((g) => g.modify(ctx.principal, input))),
    setExits: mountRecord(GRID_SET_EXITS, ({ ctx, input }) => call((g) => g.setExits(ctx.principal, input)), gridRefusalOf),
    setIdleYield: mountRecord(GRID_SET_IDLE_YIELD, ({ ctx, input }) => call((g) => g.setIdleYield(ctx.principal, input)), gridRefusalOf),
    stop: scopedProcedure('trade:write', { module: 'trade' })
      .input(z.object({ botId: z.string().min(1).max(64) }))
      .output(gridAnswer)
      .mutation(({ ctx, input }) =>
        call(async (g): Promise<VenueGridView | GridBotView> =>
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
