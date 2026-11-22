/**
 * `trade.signals.*`: the person's chart alert webhooks (CB-bots-api-signal-01, J-copy-bots-otc-20). The alert intake
 * itself is the public REST route in signals/intake-rest.ts, authenticated by the webhook's own token.
 */
import { z } from 'zod';
import { AuthError } from '@intafaced/auth';
import { JurisdictionError, router, scopedProcedure, TRPCError } from '@intafaced/contracts/trpc';
import { TradeError } from '../spot/types.js';
import { answerKeys } from '../answer-keys.js';
import { SignalError, type SignalDesk, type SignalWebhookView } from './signal-desk.js';

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
  // Who may place at all (spot/place-eligibility.ts): refused as a signed-in order is, by its own code.
  if (error instanceof AuthError || error instanceof JurisdictionError)
    return new TRPCError({ code: 'FORBIDDEN', message: error.message, cause: error });
  if (error instanceof TradeError) return new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
  return error;
}

/**
 * The answer schemas: each names every key its handler answers with (`answerKeys`) and checks no more than the
 * handler's own type, so a reply leaves exactly as it did before the schema was added.
 */
const signalWebhookFields = {
  webhookId: z.string(),
  symbol: z.string(),
  venueOwner: z.string(),
  path: z.string(),
  tokenPrefix: z.string(),
  state: z.enum(['active', 'paused', 'ended']),
  createdAt: z.string(),
};

const signalWebhooksAnswer = z.array(z.object(signalWebhookFields));
answerKeys<SignalWebhookView[]>()(signalWebhooksAnswer);

/** The new webhook with its token, shown once; null on a repeat of the same request. */
const signalWebhookCreatedAnswer = z.object({ ...signalWebhookFields, token: z.string().nullable() });
answerKeys<Awaited<ReturnType<SignalDesk['create']>>>()(signalWebhookCreatedAnswer);

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
        .input(
          z
            .object({
              symbol: z.string().min(1).max(32),
              venueOwner: z.string().min(1).max(64),
              clientRequestId: z.string().min(1).max(120),
            })
            .strict(),
        )
        .output(signalWebhookCreatedAnswer)
        .mutation(({ ctx, input }) => call((d) => d.create(ctx.principal, input, ctx.region))),
      list: scopedProcedure('trade:read', { module: 'trade' })
        .output(signalWebhooksAnswer)
        .query(({ ctx }) => call((d) => d.list(ctx.principal))),
    }),
    intents: scopedProcedure('trade:read', { module: 'trade' })
      .input(z.object({ webhookId: z.string().min(1).max(64) }).strict())
      .query(({ ctx, input }) => call((d) => d.intents(ctx.principal, input.webhookId))),
  });
}
