/**
 * `qr.mine` and `qr.resolve` (PP-send-request-11), mounted from their records (`@intafaced/contracts/identity-handles`).
 * `mine` signs the caller's own account id; `resolve` turns a scanned payload into the payee preview Send shows. See
 * pay-qr.ts for the payload and its refusals.
 */
import { TRPCError } from '@intafaced/contracts/trpc';
import { IDENTITY_QR_MINE, IDENTITY_QR_RESOLVE, payQrRefusalStatus } from '@intafaced/contracts/identity-handles';
import { mountRecords, type RefusalOf } from '@intafaced/contracts/procedure-mount';
import { PayQrError, type PayQrActor, type PayQrService } from './pay-qr.js';

type Principal = { userId: string; kid?: string | null; sub_account?: string | null };

function actor(principal: Principal): PayQrActor {
  return { userId: principal.userId, apiKey: Boolean(principal.kid), subAccount: Boolean(principal.sub_account) };
}

/** A `PayQrError` leaves with the status its record names, its own message and itself as the cause. */
const payQrRefusal: RefusalOf = (err) =>
  err instanceof PayQrError
    ? { code: err.code, error: new TRPCError({ code: payQrRefusalStatus(err.code), message: err.message, cause: err }) }
    : undefined;

export function createPayQrRouter(service: PayQrService) {
  return mountRecords(
    [IDENTITY_QR_MINE, IDENTITY_QR_RESOLVE] as const,
    {
      'identity.qr.mine': ({ ctx }) => service.mine(actor(ctx.principal as Principal)),
      'identity.qr.resolve': ({ ctx, input }) => service.resolve(actor(ctx.principal as Principal), input.payload),
    },
    payQrRefusal,
  );
}
