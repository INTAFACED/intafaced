import { z } from 'zod';
import { scopedProcedure, router, TRPCError } from '@intafaced/contracts';
import { AuthError } from '@intafaced/auth';
import { InsufficientFundsError } from '@intafaced/ledger-client';
import type { TradeService } from '../spot/trade-service.js';
import { TradeError } from '../spot/types.js';
import { deskTrpcError } from './errors.js';

async function asTrpc<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const desk = deskTrpcError(err);
    if (desk) throw desk;
    if (err instanceof AuthError) {
      throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
    }
    if (
      err instanceof TradeError &&
      (err.code === 'trade.market_not_found' || err.code === 'trade.order_not_found' || err.code === 'trade.algo_not_found')
    ) {
      throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
    }
    if (err instanceof TradeError || err instanceof InsufficientFundsError) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
    }
    throw err;
  }
}

const decimal = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places');

function jobsEnabled(): boolean {
  return process.env.TRADE_OPTIONS_JOBS_ENABLED === 'true';
}

export function algoDeskProcedures(trade: TradeService) {
  return {
    list: scopedProcedure('trade:read')
      .input(
        z.object({
          status: z.string().optional(),
          kind: z.string().optional(),
          from: z.string().optional(),
          limit: z.number().int().optional(),
          cursor: z.string().optional(),
        }),
      )
      .query(({ ctx, input }) => asTrpc(() => trade.algoList(ctx.principal, input))),

    reports: scopedProcedure('trade:read')
      .input(z.object({ algoId: z.string().min(1), limit: z.number().int().optional(), cursor: z.string().optional() }))
      .query(({ ctx, input }) => asTrpc(() => trade.algoReports(ctx.principal, input))),
  };
}

export function optionsDeskProcedures(trade: TradeService) {
  return {
    catalogue: scopedProcedure('trade:read')
      .input(
        z.object({
          underlying: z.string().optional(),
          expiry: z.string().optional(),
          limit: z.number().int().optional(),
          cursor: z.string().optional(),
        }),
      )
      .query(({ ctx, input }) => asTrpc(() => trade.optionsCatalogue(ctx.principal, input))),

    positions: scopedProcedure('trade:read').query(({ ctx }) => asTrpc(() => Promise.resolve(trade.optionsPositions(ctx.principal)))),

    exercises: scopedProcedure('trade:read').query(({ ctx }) =>
      asTrpc(() => Promise.resolve(trade.optionsExercises(ctx.principal, jobsEnabled()))),
    ),

    marginPreview: scopedProcedure('trade:read')
      .input(z.object({ symbol: z.string().optional(), qty: decimal.optional() }).optional())
      .query(({ ctx }) => asTrpc(() => Promise.resolve(trade.optionsMarginPreview(ctx.principal)))),
  };
}

export function scaleProcedures(trade: TradeService) {
  return router({
    create: scopedProcedure('trade:write', { module: 'trade' })
      .input(
        z.object({
          market: z.string().min(1),
          side: z.enum(['buy', 'sell']),
          totalQty: z.string(),
          levels: z.number().int().optional(),
          priceFrom: z.string(),
          priceTo: z.string(),
          clientGroupId: z.string(),
        }),
      )
      .mutation(({ ctx, input }) => asTrpc(() => trade.scaleCreate(ctx.principal, input))),

    get: scopedProcedure('trade:read')
      .input(z.object({ groupId: z.string().min(1) }))
      .query(({ ctx, input }) => asTrpc(() => trade.scaleGet(ctx.principal, input.groupId))),

    cancel: scopedProcedure('trade:write', { module: 'trade' })
      .input(z.object({ groupId: z.string().min(1) }))
      .mutation(({ ctx, input }) => asTrpc(() => trade.scaleCancel(ctx.principal, input.groupId))),
  });
}

export function rfqHistoryProcedures(trade: TradeService) {
  return {
    list: scopedProcedure('trade:read')
      .input(
        z.object({
          from: z.string().optional(),
          to: z.string().optional(),
          limit: z.number().int().optional(),
          cursor: z.string().optional(),
        }),
      )
      .query(({ ctx, input }) => asTrpc(() => trade.rfqList(ctx.principal, input))),

    board: scopedProcedure('trade:read')
      .input(
        z.object({
          from: z.string().optional(),
          to: z.string().optional(),
          limit: z.number().int().optional(),
        }),
      )
      .query(({ ctx, input }) => asTrpc(() => trade.rfqBoard(ctx.principal, input))),
  };
}
