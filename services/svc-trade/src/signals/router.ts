/**
 * `trade.signals.*`: the person's chart alert webhooks (CB-bots-api-signal-01, J-copy-bots-otc-20). The alert intake
 * itself is the public REST route in signals/intake-rest.ts, authenticated by the webhook's own token.
 */
import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { TradeError } from '../spot/types.js';
import { SignalError, type SignalDesk } from './signal-desk.js';

function signalTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof SignalError) {
    const code =
      error.status === 404
        ? 'NOT_FOUND'
        : error.status === 412
          ? 'PRECONDITION_FAILED'
          : error.status === 401
            ? 'UNAUTHORIZED'
            : 'BAD_REQUEST';
    return new TRPCError({ code, message: error.message, cause: error });
  }
  if (error instanceof TradeError) return new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
  return error;
}

export function signalsRouter(desk?: SignalDesk) {
  async function call<T>(fn: (desk: SignalDesk) => Promise<T>): Promise<T> {
    try {
      if (!desk) throw new SignalError('Chart alert webhooks are not available', 'trade.signal_unavailable', 503);
      return await fn(desk);
    } catch (error) {
      throw signalTrpcError(error);
    }
  }
  return router({
    webhooks: router({
      create: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ symbol: z.string().min(1).max(32), clientRequestId: z.string().min(1).max(120) }).strict())
        .mutation(({ ctx, input }) => call((d) => d.create(ctx.principal, input))),
      list: scopedProcedure('trade:read', { module: 'trade' }).query(({ ctx }) => call((d) => d.list(ctx.principal))),
    }),
    intents: scopedProcedure('trade:read', { module: 'trade' })
      .input(z.object({ webhookId: z.string().min(1).max(64) }).strict())
      .query(({ ctx, input }) => call((d) => d.intents(ctx.principal, input.webhookId))),
  });
}
