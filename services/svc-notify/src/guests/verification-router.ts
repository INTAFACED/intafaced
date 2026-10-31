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
 * `guestVerification.*`: svc-support only. `serviceProcedureFor(GUEST_VERIFICATION_CALLERS)` admits no other caller, so the
 * producer every row is tagged with is svc-support, and it sees and erases its own rows only.
 */
export function guestVerificationRouter(service?: GuestVerificationService) {
  const producer = serviceProcedureFor(GUEST_VERIFICATION_CALLERS);
  const PRODUCER: Producer = 'svc-support';
  async function call<T>(run: (service: GuestVerificationService, producer: Producer) => Promise<T>): Promise<T> {
    try {
      if (!service) throw new GuestVerificationError('guest.notification_unconfigured');
      return await run(service, PRODUCER);
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
      .mutation(({ input }) => call((s, p) => s.send(p, input))),
    get: producer
      .input(guestVerificationGetInputSchema)
      .output(guestVerificationReceiptSchema.nullable())
      .mutation(({ input }) => call((s, p) => s.get(p, input))),
    erase: producer
      .input(guestVerificationEraseInputSchema)
      .output(guestVerificationEraseReceiptSchema)
      .mutation(({ input }) => call((s, p) => s.erase(p, input))),
  });
}
