import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { DD_COLLECTION_STATUSES, DD_FAILURE_FEE_UNSET } from './direct-debits.js';

/**
 * `bank.directDebits.*` (BK-xfer-11, J-bank-06 #4): the person's Direct Debit mandates. Reads are `bank:read`; block,
 * unblock and a refund request are `bank:write`. Support's refund queue is `admin:read`. Setting a mandate up and
 * presenting a collection are the scheme speaking: they are signed job doors (`/internal/jobs/dd-sim/*`), never here.
 */

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);
const mandateId = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);

const collectionView = z.object({
  id: z.string(),
  mandateId: z.string(),
  collectionId: z.string(),
  creditorName: z.string(),
  assetId: z.string(),
  amount: amountString,
  dueAt: z.string(),
  status: z.enum(DD_COLLECTION_STATUSES),
  failureCode: z.string().nullable(),
  ledgerTxId: z.string().nullable(),
  presentedAt: z.string(),
  settledAt: z.string().nullable(),
  failureFee: z.null(),
  failureFeeBlocker: z.literal(DD_FAILURE_FEE_UNSET).nullable(),
  refund: z.object({
    state: z.enum(['none', 'available', 'requested', 'closed', 'unset']),
    endsAt: z.string().nullable(),
    requestedAt: z.string().nullable(),
  }),
});

const mandateView = z.object({
  id: z.string(),
  creditorId: z.string(),
  creditorName: z.string(),
  reference: z.string(),
  assetId: z.string(),
  status: z.enum(['active', 'blocked']),
  blockedAt: z.string().nullable(),
  createdAt: z.string(),
  upcoming: z.array(collectionView),
});

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

export function createDirectDebitsRouter(bank: BankServices, guard: Guard) {
  return router({
    list: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z.object({
          scheme: z.object({
            status: z.enum(['unset', 'live']),
            standIn: z.string().nullable(),
            guaranteeDays: z.number().int().nullable(),
            blocker: z.literal('rail.bank').nullable(),
          }),
          mandates: z.array(mandateView),
          collections: z.array(collectionView),
        }),
      )
      .query(({ ctx }) => guard(() => bank.directDebits.list(ctx.principal.userId))),
    block: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ mandateId }).strict())
      .output(
        z.object({
          mandate: mandateView,
          rejected: z.array(z.string()),
          tooLate: z.array(z.object({ collectionId: z.string(), code: z.literal('bank.dd_too_late') })),
        }),
      )
      .mutation(({ ctx, input }) => guard(() => bank.directDebits.block({ userId: ctx.principal.userId, mandateId: input.mandateId }))),
    unblock: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ mandateId }).strict())
      .output(z.object({ mandate: mandateView }))
      .mutation(({ ctx, input }) => guard(() => bank.directDebits.unblock({ userId: ctx.principal.userId, mandateId: input.mandateId }))),
    requestRefund: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ collectionId: z.string().uuid(), reason: z.string().min(1).max(500) }).strict())
      .output(z.object({ collection: collectionView, created: z.boolean() }))
      .mutation(({ ctx, input }) =>
        guard(() =>
          bank.directDebits.requestRefund({ userId: ctx.principal.userId, collectionRowId: input.collectionId, reason: input.reason }),
        ),
      ),
    ops: router({
      /** Support's queue of refund requests, oldest first. */
      refunds: scopedProcedure('admin:read', { module: 'bank' })
        .input(z.object({ limit: z.number().int().min(1).max(100).optional() }).strict())
        .output(z.array(collectionView.extend({ userId: z.string(), reason: z.string() })))
        .query(({ input }) => guard(() => bank.directDebits.opsRefunds(input))),
    }),
  });
}
