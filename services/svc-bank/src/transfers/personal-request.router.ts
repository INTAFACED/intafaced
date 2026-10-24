import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import type { BankServices } from '../bank-service.js';

/**
 * `bank.personalRequest.*` — ask a person to pay you.
 *
 * The signed-in user is the payee. `payerUserId` is who is asked. Paying is
 * `transfers.toUser` with `requestId`, which settles exactly one open request.
 */

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);
const requestStatus = z.enum(['open', 'paid', 'declined', 'cancelled', 'expired']);

const requestView = z.object({
  requestId: z.string().guid(),
  payeeUserId: z.string(),
  payerUserId: z.string(),
  payeeHandle: z.string().nullable(),
  payerHandle: z.string().nullable(),
  assetId: z.string(),
  amount: amountString,
  note: z.string().nullable(),
  expiresAt: z.string().datetime(),
  status: requestStatus,
  ledgerTxId: z.string().nullable(),
  createdAt: z.string().datetime(),
  notice: z.object({ delivered: z.boolean(), blocker: z.string().nullable() }),
});

export function createPersonalRequestRouter(bank: Pick<BankServices, 'personalPay'>, guard: <T>(fn: () => Promise<T>) => Promise<T>) {
  return router({
    create: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          payerUserId: z.string().guid(),
          assetId: z.string().min(1).max(16),
          amount: amountString,
          note: z.string().max(140).optional(),
          expiresAt: z.string().datetime({ offset: true }),
          idempotencyKey: z.string().min(8).max(64),
        }),
      )
      .output(requestView)
      .mutation(({ ctx, input }) =>
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
      ),

    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          direction: z.enum(['incoming', 'outgoing']),
          status: requestStatus.optional(),
          limit: z.number().int().min(1).max(100).optional(),
        }),
      )
      .output(z.array(requestView))
      .query(({ ctx, input }) =>
        guard(() =>
          bank.personalPay.listRequests({
            actorUserId: ctx.principal.userId,
            direction: input.direction,
            status: input.status,
            limit: input.limit,
          }),
        ),
      ),

    get: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ requestId: z.string().guid() }))
      .output(requestView)
      .query(({ ctx, input }) => guard(() => bank.personalPay.getRequest(ctx.principal.userId, input.requestId))),

    cancel: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ requestId: z.string().guid() }))
      .output(requestView)
      .mutation(({ ctx, input }) => guard(() => bank.personalPay.cancelRequest(ctx.principal.userId, input.requestId))),

    decline: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ requestId: z.string().guid() }))
      .output(requestView)
      .mutation(({ ctx, input }) => guard(() => bank.personalPay.declineRequest(ctx.principal.userId, input.requestId))),

    remind: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ requestId: z.string().guid(), idempotencyKey: z.string().min(8).max(64) }))
      .output(requestView)
      .mutation(({ ctx, input }) =>
        guard(() => bank.personalPay.remindRequest(ctx.principal.userId, input.requestId, input.idempotencyKey)),
      ),
  });
}
