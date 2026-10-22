/**
 * tRPC doors for trade signal webhooks (CB-bots-api-signal-01 PR 2), mounted as `signals` on the root router:
 * `signals.webhook.create` / `signals.webhook.list` (customer, `trade:write` / `trade:read`) and `signals.intake`
 * (svc-edge only, `serviceProcedureFor(TRADE_SIGNAL_INTAKE_CALLERS)`). Unwired, every door refuses SERVICE_UNAVAILABLE.
 */
import { z } from 'zod';
import {
  router,
  scopedProcedure,
  serviceProcedureFor,
  TRADE_SIGNAL_INTAKE_CALLERS,
  tradeSignalWebhookCreateInputSchema,
  tradeSignalWebhookCreateOutputSchema,
  tradeSignalWebhookListInputSchema,
  tradeSignalWebhookListOutputSchema,
  TRPCError,
} from '@intafaced/contracts';
import { TradeSignalError } from './signal-config.js';
import { SignalBodyError, type SignalWebhookService } from './signal-service.js';

export const signalIntakeInputSchema = z
  .object({
    webhookId: z.string().uuid(),
    token: z.string().min(1).max(256),
    /** The raw alert body as svc-edge received it. The cap is enforced inside with the owner value. */
    body: z.string(),
  })
  .strict();

export const signalIntakeOutputSchema = z
  .object({
    alertKey: z.string(),
    outcome: z.enum(['placed', 'refused']),
    orderId: z.string().nullable(),
    reason: z.string().nullable(),
    replay: z.boolean(),
  })
  .strict();

export function signalTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof TradeSignalError) {
    const code =
      err.code === 'trade.signal_token_invalid'
        ? 'UNAUTHORIZED'
        : err.code === 'trade.signal_stale'
          ? 'BAD_REQUEST'
          : 'SERVICE_UNAVAILABLE';
    return new TRPCError({ code, message: `${err.message} [${err.code}]`, cause: err });
  }
  if (err instanceof SignalBodyError) {
    const code =
      err.kind === 'too_large'
        ? 'PAYLOAD_TOO_LARGE'
        : err.kind === 'rate_limited'
          ? 'TOO_MANY_REQUESTS'
          : err.kind === 'place_unwired'
            ? 'SERVICE_UNAVAILABLE'
            : 'BAD_REQUEST';
    return new TRPCError({ code, message: err.message, cause: err });
  }
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Request failed', cause: err });
}

function unwired(): never {
  throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'signal webhooks are not wired on this service' });
}

export function signalsRouter(service?: SignalWebhookService) {
  return router({
    webhook: router({
      create: scopedProcedure('trade:write')
        .input(tradeSignalWebhookCreateInputSchema)
        .output(tradeSignalWebhookCreateOutputSchema)
        .mutation(async ({ ctx, input }) => {
          if (!service) unwired();
          try {
            return await service.create(ctx.principal.userId, input);
          } catch (err) {
            throw signalTrpcError(err);
          }
        }),
      list: scopedProcedure('trade:read')
        .input(tradeSignalWebhookListInputSchema)
        .output(tradeSignalWebhookListOutputSchema)
        .query(async ({ ctx }) => {
          if (!service) unwired();
          try {
            return await service.list(ctx.principal.userId);
          } catch (err) {
            throw signalTrpcError(err);
          }
        }),
    }),
    intake: serviceProcedureFor(TRADE_SIGNAL_INTAKE_CALLERS)
      .input(signalIntakeInputSchema)
      .output(signalIntakeOutputSchema)
      .mutation(async ({ input }) => {
        if (!service) unwired();
        try {
          return await service.intake(input);
        } catch (err) {
          throw signalTrpcError(err);
        }
      }),
  });
}
