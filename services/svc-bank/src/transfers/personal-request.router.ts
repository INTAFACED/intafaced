import { router } from '@intafaced/contracts/trpc';
import {
  BANK_PERSONAL_REQUEST_CANCEL,
  BANK_PERSONAL_REQUEST_CREATE,
  BANK_PERSONAL_REQUEST_DECLINE,
  BANK_PERSONAL_REQUEST_GET,
  BANK_PERSONAL_REQUEST_LIST,
  BANK_PERSONAL_REQUEST_REMIND,
  BANK_PERSONAL_REQUEST_REMINDERS,
  BANK_PERSONAL_REQUEST_REPORT,
  BANK_PERSONAL_REQUEST_SAFETY,
} from '@intafaced/contracts/bank-personal-request-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { parseAmount } from '@intafaced/ledger-client';
import type { BankServices } from '../bank-service.js';
import { bankRefusal } from '../router/errors.js';

/**
 * `bank.personalRequest.*` — ask a person to pay you, mounted from its records
 * (`@intafaced/contracts/bank-personal-request-procedures`).
 *
 * The signed-in user is the payee. `payerUserId` is who is asked. Paying is
 * `transfers.toUser` with `requestId`, which settles exactly one open request.
 */
export function createPersonalRequestRouter(bank: Pick<BankServices, 'personalPay'>, guard: <T>(fn: () => Promise<T>) => Promise<T>) {
  return router({
    create: mountRecord(
      BANK_PERSONAL_REQUEST_CREATE,
      ({ ctx, input }) =>
        guard(() =>
          bank.personalPay.createRequest({
            payeeUserId: ctx.principal.userId,
            payerUserId: input.payerUserId,
            assetId: input.assetId,
            amount: parseAmount(input.amount),
            note: input.note,
            expiresAt: new Date(input.expiresAt),
            idempotencyKey: input.idempotencyKey,
          }),
        ),
      bankRefusal,
    ),

    list: mountRecord(
      BANK_PERSONAL_REQUEST_LIST,
      ({ ctx, input }) =>
        guard(() =>
          bank.personalPay.listRequests({
            actorUserId: ctx.principal.userId,
            direction: input.direction,
            status: input.status,
            limit: input.limit,
          }),
        ),
      bankRefusal,
    ),

    get: mountRecord(
      BANK_PERSONAL_REQUEST_GET,
      ({ ctx, input }) => guard(() => bank.personalPay.getRequest(ctx.principal.userId, input.requestId)),
      bankRefusal,
    ),

    cancel: mountRecord(
      BANK_PERSONAL_REQUEST_CANCEL,
      ({ ctx, input }) => guard(() => bank.personalPay.cancelRequest(ctx.principal.userId, input.requestId)),
      bankRefusal,
    ),

    decline: mountRecord(
      BANK_PERSONAL_REQUEST_DECLINE,
      ({ ctx, input }) => guard(() => bank.personalPay.declineRequest(ctx.principal.userId, input.requestId)),
      bankRefusal,
    ),

    remind: mountRecord(
      BANK_PERSONAL_REQUEST_REMIND,
      ({ ctx, input }) => guard(() => bank.personalPay.remindRequest(ctx.principal.userId, input.requestId, input.idempotencyKey)),
      bankRefusal,
    ),

    /** The asker's reminders in the owner's window and when the next may go (PP-send-request-13). */
    reminders: mountRecord(
      BANK_PERSONAL_REQUEST_REMINDERS,
      ({ ctx, input }) => guard(() => bank.personalPay.reminders(ctx.principal.userId, input.requestId)),
      bankRefusal,
    ),

    /**
     * The person asked declines, reports the request (`report:<requestId>`) and, when asked, blocks the asker
     * (`block:<userId>:<askerId>`). The asker only ever reads Declined (PP-send-request-13).
     */
    report: mountRecord(
      BANK_PERSONAL_REQUEST_REPORT,
      ({ ctx, input }) =>
        guard(() => bank.personalPay.reportRequest(ctx.principal.userId, input.requestId, { reason: input.reason, block: input.block })),
      bankRefusal,
    ),

    /** The payer's own report and block on a request, or null. The asker gets not-found. */
    safety: mountRecord(
      BANK_PERSONAL_REQUEST_SAFETY,
      ({ ctx, input }) => guard(() => bank.personalPay.requestSafety(ctx.principal.userId, input.requestId)),
      bankRefusal,
    ),
  });
}
