/**
 * tRPC surface the trade operator desk calls. Reads are `admin:read`.
 * Writes are `admin:write`. Procedures exist even when the service is
 * unwired: they refuse `trade_ops_admin_unconfigured`.
 */
import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { AuthError } from '@intafaced/auth';
import { TradeOpsError } from './common.js';
import type { TradeOpsAdmin } from './service.js';

const limit = z.number().int().min(1).max(200);
const id = z.string().uuid();
const reason = z.string().trim().min(3).max(500);
const clientRequestId = z.string().trim().min(1).max(128);
const nullableText = z.string().trim().min(1).max(128).nullish();

const limits = z
  .object({
    collar: z.string().nullable(),
    fatFinger: z.string().nullable(),
    slippageCap: z.string().nullable(),
    throttle: z.string().nullable(),
    circuitBreaker: z.string().nullable(),
  })
  .strict();

function fail(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  if (error instanceof AuthError) {
    throw new TRPCError({ code: error.code === 'mfa.required' ? 'UNAUTHORIZED' : 'FORBIDDEN', message: error.message, cause: error });
  }
  if (error instanceof TradeOpsError) {
    const code =
      error.code === 'order_not_found' ||
      error.code === 'position_not_found' ||
      error.code === 'export_not_found' ||
      error.code === 'market_not_found'
        ? 'NOT_FOUND'
        : 'BAD_REQUEST';
    throw new TRPCError({ code, message: error.message, cause: error });
  }
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Request failed', cause: error });
}

export function tradeOpsAdminRouter(admin?: TradeOpsAdmin) {
  const operator = scopedProcedure('admin:read');
  const operatorWrite = scopedProcedure('admin:write');
  const ready = (): TradeOpsAdmin => {
    if (!admin) {
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'trade_ops_admin_unconfigured',
      });
    }
    return admin;
  };
  return router({
    orders: router({
      massCancel: operatorWrite
        .input(
          z.object({
            market: nullableText,
            accountId: id.nullish(),
            reason,
            approvalId: z.string().trim().min(1).max(128),
            clientRequestId,
          }),
        )
        .mutation(({ ctx, input }) => ready().massCancel(ctx.principal, input).catch(fail)),
      get: operator
        .input(z.object({ orderId: id }).strict())
        .query(({ ctx, input }) => ready().getOrder(ctx.principal, input.orderId).catch(fail)),
      list: operator
        .input(
          z.object({
            status: z.string().min(1).max(40),
            market: id.nullish(),
            accountId: id.nullish(),
            from: z.string().nullish(),
            to: z.string().nullish(),
            cursor: z.string().nullish(),
            limit,
          }),
        )
        .query(({ ctx, input }) => ready().listOrders(ctx.principal, input).catch(fail)),
      reconcile: operatorWrite
        .input(z.object({ orderId: id, clientRequestId }).strict())
        .mutation(({ ctx, input }) => ready().reconcile(ctx.principal, input).catch(fail)),
      reconcileStatus: operator.query(({ ctx }) => ready().reconcileStatus(ctx.principal).catch(fail)),
      startReconcileSweep: operatorWrite
        .input(z.object({ clientRequestId }).strict())
        .mutation(({ ctx, input }) => ready().startReconcileSweep(ctx.principal, input).catch(fail)),
    }),
    risk: router({
      get: operator
        .input(z.object({ market: id }).strict())
        .query(({ ctx, input }) => ready().riskGet(ctx.principal, input.market).catch(fail)),
      history: operator
        .input(z.object({ market: id }).strict())
        .query(({ ctx, input }) => ready().riskHistory(ctx.principal, input.market).catch(fail)),
      set: operatorWrite
        .input(
          z.object({
            market: id,
            limits,
            expectedVersion: z.string().regex(/^(?:0|[1-9]\d*)$/),
            reason,
            approvalId: z.string().trim().min(1).max(128),
          }),
        )
        .mutation(({ ctx, input }) => ready().riskSet(ctx.principal, input).catch(fail)),
    }),
    positions: router({
      list: operator
        .input(z.object({ accountId: z.string().nullish(), market: id.nullish(), cursor: z.string().nullish(), limit }))
        .query(({ ctx, input }) => ready().listPositions(ctx.principal, input).catch(fail)),
      get: operator
        .input(z.object({ positionId: id }).strict())
        .query(({ ctx, input }) => ready().getPosition(ctx.principal, input.positionId).catch(fail)),
    }),
    futures: router({
      snapshot: operator
        .input(z.object({ market: id }).strict())
        .query(({ ctx, input }) => ready().futuresSnapshot(ctx.principal, input.market).catch(fail)),
    }),
    exports: router({
      create: operator
        .input(
          z.object({
            kind: z.enum(['orders', 'fills', 'positions']),
            filters: z.object({ market: id.nullish(), accountId: z.string().nullish() }).strict(),
            clientRequestId,
          }),
        )
        .mutation(({ ctx, input }) => ready().createExport(ctx.principal, input).catch(fail)),
      get: operator.input(z.object({ id }).strict()).query(({ ctx, input }) => ready().getExport(ctx.principal, input.id).catch(fail)),
      download: operator
        .input(z.object({ ref: z.string().min(1).max(512) }).strict())
        .mutation(({ ctx, input }) => ready().downloadExport(ctx.principal, input.ref).catch(fail)),
    }),
    audit: router({
      feed: operator
        .input(
          z.object({
            cursor: z.string().nullish(),
            kind: z.string().max(80).nullish(),
            accountId: z.string().nullish(),
            from: z.string().nullish(),
            to: z.string().nullish(),
            limit,
          }),
        )
        .query(({ ctx, input }) => ready().auditFeed(ctx.principal, input).catch(fail)),
    }),
    marketMaker: router({
      seedReport: operator
        .input(z.object({ market: id, from: z.string().nullish(), to: z.string().nullish() }))
        .query(({ ctx, input }) => ready().seedReport(ctx.principal, input).catch(fail)),
      setSeed: operatorWrite
        .input(z.object({ market: id, enabled: z.boolean(), approvalId: z.string().min(1).max(128), clientRequestId }))
        .mutation(({ ctx, input }) => ready().setSeed(ctx.principal, input).catch(fail)),
    }),
    markets: router({
      statusHistory: operator
        .input(z.object({ market: id, cursor: z.string().nullish(), limit }))
        .query(({ ctx, input }) => ready().statusHistory(ctx.principal, input).catch(fail)),
    }),
  });
}
