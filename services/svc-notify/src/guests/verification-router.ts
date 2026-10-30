import {
  router,
  serviceProcedureFor,
  TRPCError,
  GUEST_VERIFICATION_CALLERS,
  guestVerificationEraseInputSchema,
  guestVerificationEraseReceiptSchema,
  guestVerificationGetInputSchema,
  guestVerificationReceiptSchema,
  guestVerificationSendInputSchema,
} from '@intafaced/contracts';
import { GuestVerificationError, type GuestVerificationService, type Producer } from './verification.js';

/**
 * `guestVerification.*`: svc-support only (`GUEST_VERIFICATION_CALLERS`), never the outreach guest route's producer. The
 * producer is the verified caller, so a caller sees and erases its own rows only.
 */
export function guestVerificationRouter(service?: GuestVerificationService) {
  const producer = serviceProcedureFor(GUEST_VERIFICATION_CALLERS);
  async function call<T>(
    caller: string | null | undefined,
    run: (service: GuestVerificationService, producer: Producer) => Promise<T>,
  ): Promise<T> {
    try {
      if (!service) throw new GuestVerificationError('guest.notification_unconfigured');
      if (caller !== 'svc-support') throw new TRPCError({ code: 'FORBIDDEN', message: 'Guest verification requires svc-support' });
      return await run(service, caller);
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      const typed = error instanceof GuestVerificationError ? error : new GuestVerificationError('guest.storage_unavailable');
      const code =
        typed.code === 'guest.request_conflict'
          ? 'CONFLICT'
          : typed.code === 'guest.request_erased'
            ? 'FORBIDDEN'
            : typed.code === 'guest.storage_unavailable' || typed.code === 'guest.notification_unconfigured'
              ? 'SERVICE_UNAVAILABLE'
              : 'PRECONDITION_FAILED';
      throw new TRPCError({ code, message: typed.code, cause: typed });
    }
  }
  return router({
    send: producer
      .input(guestVerificationSendInputSchema)
      .output(guestVerificationReceiptSchema)
      .mutation(({ ctx, input }) => call(ctx.service, (s, p) => s.send(p, input))),
    get: producer
      .input(guestVerificationGetInputSchema)
      .output(guestVerificationReceiptSchema.nullable())
      .mutation(({ ctx, input }) => call(ctx.service, (s, p) => s.get(p, input))),
    erase: producer
      .input(guestVerificationEraseInputSchema)
      .output(guestVerificationEraseReceiptSchema)
      .mutation(({ ctx, input }) => call(ctx.service, (s, p) => s.erase(p, input))),
  });
}
