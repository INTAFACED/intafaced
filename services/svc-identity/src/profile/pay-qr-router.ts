/**
 * `qr.mine` and `qr.resolve` (PP-send-request-11). `mine` signs the caller's own account id; `resolve` turns a scanned
 * payload into the payee preview Send shows. See pay-qr.ts for the payload and its refusals.
 */
import { z } from 'zod';
import { protectedProcedure, router, TRPCError } from '@intafaced/contracts';
import { PAY_QR_PAYLOAD_MAX, PayQrError, type PayQrActor, type PayQrService } from './pay-qr.js';

type Principal = { userId: string; kid?: string | null; sub_account?: string | null };

function actor(principal: Principal): PayQrActor {
  return { userId: principal.userId, apiKey: Boolean(principal.kid), subAccount: Boolean(principal.sub_account) };
}

function toTrpc(err: unknown): never {
  if (err instanceof PayQrError) {
    const code =
      err.code === 'identity.qr_key_unset'
        ? 'PRECONDITION_FAILED'
        : err.code === 'identity.delegated_refused'
          ? 'FORBIDDEN'
          : err.code === 'identity.qr_payee_unavailable'
            ? 'NOT_FOUND'
            : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message, cause: err });
  }
  throw err;
}

export function createPayQrRouter(service: PayQrService) {
  return router({
    qr: router({
      /** The caller's own signed pay code, for their QR code and payment link. */
      mine: protectedProcedure.output(z.object({ payload: z.string() })).query(async ({ ctx }) => {
        try {
          return await service.mine(actor(ctx.principal as Principal));
        } catch (err) {
          toTrpc(err);
        }
      }),

      /** Who a scanned code pays: their account id and handle, and whether it is the caller. */
      resolve: protectedProcedure
        .input(
          z.object({
            payload: z
              .string()
              .min(1)
              .max(PAY_QR_PAYLOAD_MAX * 2),
          }),
        )
        .output(z.object({ userId: z.string(), handle: z.string(), self: z.boolean() }))
        .query(async ({ ctx, input }) => {
          try {
            return await service.resolve(actor(ctx.principal as Principal), input.payload);
          } catch (err) {
            toTrpc(err);
          }
        }),
    }),
  });
}
