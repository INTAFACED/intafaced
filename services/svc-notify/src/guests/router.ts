import {
  router,
  serviceProcedure,
  TRPCError,
  guestNotificationSendInputSchema,
  guestNotificationGetInputSchema,
  guestNotificationReceiptSchema,
  guestNotificationEraseInputSchema,
  guestNotificationEraseReceiptSchema,
} from '@intafaced/contracts';
import { GuestNotificationError, type GuestNotificationService } from './service.js';

export function guestNotificationsRouter(service?: GuestNotificationService) {
  const ops = serviceProcedure.use(({ ctx, next }) => {
    if (ctx.service !== 'svc-ops') throw new TRPCError({ code: 'FORBIDDEN', message: 'Guest notifications require the ops producer' });
    return next({ ctx });
  });
  async function call<T>(run: (service: GuestNotificationService) => Promise<T>): Promise<T> {
    try {
      if (!service) throw new GuestNotificationError('guest.notification_unconfigured');
      return await run(service);
    } catch (error) {
      const typed = error instanceof GuestNotificationError ? error : new GuestNotificationError('guest.storage_unavailable');
      let code: 'CONFLICT' | 'PRECONDITION_FAILED' | 'FORBIDDEN' | 'SERVICE_UNAVAILABLE' = 'SERVICE_UNAVAILABLE';
      if (typed.code === 'guest.request_conflict') code = 'CONFLICT';
      if (typed.code === 'guest.delivery_in_progress') code = 'PRECONDITION_FAILED';
      if (typed.code === 'guest.submission_erased') code = 'FORBIDDEN';
      throw new TRPCError({
        code,
        message: typed.code,
        cause: typed,
      });
    }
  }
  return router({
    send: ops
      .input(guestNotificationSendInputSchema)
      .output(guestNotificationReceiptSchema)
      .mutation(({ input }) => call((service) => service.send(input))),
    get: ops
      .input(guestNotificationGetInputSchema)
      .output(guestNotificationReceiptSchema.nullable())
      .mutation(({ input }) => call((service) => service.get(input))),
    eraseSubmission: ops
      .input(guestNotificationEraseInputSchema)
      .output(guestNotificationEraseReceiptSchema)
      .mutation(({ input }) => call((service) => service.eraseSubmission(input))),
  });
}
