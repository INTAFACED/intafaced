import { z } from 'zod';
import { router, scopedProcedure, TRPCError, publicProcedure } from '@intafaced/contracts';
import { InsufficientFundsError } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import type { BankServices } from '../bank-service.js';
import { requireBankJobService } from '../ops-job-hmac.js';
import type { StepUpGate } from '../step-up/step-up-gate.js';
import { PersonalPayError } from './errors.js';
import { billPayStepUp, billRecurringStepUp, globalSendStepUp } from './step-up-fields.js';

/**
 * Customer doors for /pay/bills and /pay/global.
 *
 * Reads are `bank:read`. Money instructions are `bank:write`. Founder counts
 * are `admin:read` and are refused to a session that only holds bank scopes.
 * `runDue` is the svc-bank job, not a customer.
 */

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amount must be an unsigned decimal string (max 18dp)');
const idString = z.string().min(8).max(128);
const stepUpApprovalField = z.string().min(1).max(128).optional();
const limitField = z.number().int().min(1).max(100).optional();

const billView = z.object({
  id: z.string(),
  billerId: z.string(),
  reference: z.string(),
  amount: amountString,
  assetId: z.string(),
  fromSpaceId: z.string(),
  status: z.enum(['submitted', 'accepted', 'paid', 'failed', 'returned']),
  failureCode: z.string().nullable(),
  failureBlocker: z.string().nullable(),
  providerRef: z.string().nullable(),
  ledgerTxId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const recurringView = z.object({
  id: z.string(),
  billerId: z.string(),
  reference: z.string(),
  amount: amountString,
  assetId: z.string(),
  fromSpaceId: z.string(),
  cadence: z.enum(['weekly', 'monthly']),
  status: z.enum(['active', 'paused', 'cancelled', 'completed']),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  nextRunAt: z.string(),
});

const sendView = z.object({
  id: z.string(),
  fromSpaceId: z.string(),
  assetId: z.string(),
  amount: amountString,
  toCurrency: z.string(),
  recipientId: z.string(),
  country: z.string(),
  deliveryMethod: z.string(),
  status: z.enum(['submitted', 'held', 'sent', 'on_the_way', 'arrived', 'failed']),
  failureCode: z.string().nullable(),
  failureBlocker: z.string().nullable(),
  providerRef: z.string().nullable(),
  quoteRate: z.string().nullable(),
  quoteFee: z.string().nullable(),
  quoteFeeAsset: z.string().nullable(),
  quoteReceive: z.string().nullable(),
  quoteValidUntil: z.string().nullable(),
  quoteEta: z.string().nullable(),
  ledgerTxId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const holdState = z.enum(['requested', 'under_review', 'released']);
const operatorHoldView = z.object({
  id: z.string(),
  sendId: z.string(),
  state: holdState,
  reason: z.string(),
  heldBy: z.string(),
  infoRequest: z.string().nullable(),
  proof: z.object({ name: z.string(), type: z.string(), size: z.number(), sha256: z.string(), uploadedAt: z.string() }).nullable(),
  releasedBy: z.string().nullable(),
  createdAt: z.string(),
});
const customerHoldView = z.object({
  state: holdState,
  infoRequest: z.string().nullable(),
  proofUploaded: z.boolean(),
  proofLimits: z.object({ allowedTypes: z.array(z.string()), maxBytes: z.number() }).nullable(),
});

function guard<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err: unknown) => {
    if (err instanceof TRPCError) throw err;
    if (err instanceof PersonalPayError) {
      throw new TRPCError({ code: err.http, message: `${err.message} (${err.code})`, cause: err });
    }
    if (
      err instanceof BankError &&
      (err.code === 'bank.space_archived' || err.code === 'bank.space_locked' || err.code.startsWith('bank.step_up_'))
    ) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `${err.message} (${err.code})`, cause: err });
    }
    if (err instanceof InsufficientFundsError) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
    }
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Bank operation failed', cause: err });
  });
}

async function requireStepUp(
  stepUp: StepUpGate,
  principal: { userId: string; sid: string },
  binding: { actionType: Parameters<StepUpGate['require']>[0]['actionType']; fields: Record<string, string>; operationKey: string },
  approvalId: string | undefined,
): Promise<void> {
  await stepUp.require({
    userId: principal.userId,
    sessionId: principal.sid,
    actionType: binding.actionType,
    fields: binding.fields,
    operationKey: binding.operationKey,
    approvalId,
    replay: true,
  });
}

const jobProcedure = publicProcedure.use(({ ctx, next }) => {
  requireBankJobService(ctx.service);
  return next({ ctx });
});

export function createBillsRouter(bank: Pick<BankServices, 'bills' | 'spaces'>, stepUp: StepUpGate) {
  return router({
    billers: router({
      search: scopedProcedure('bank:read', { module: 'bank' })
        .input(z.object({ query: z.string().min(1).max(64), country: z.string().length(2).optional() }).strict())
        .output(z.array(z.object({ id: z.string(), name: z.string(), country: z.string(), category: z.string() })))
        .query(({ input }) => guard(() => bank.bills.search(input))),
    }),
    lookup: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ billerId: z.string().min(1).max(64), reference: z.string().min(1).max(64) }).strict())
      .output(z.object({ amountDue: amountString, dueDate: z.string(), payeeName: z.string(), currency: z.string() }))
      .query(({ input }) => guard(() => bank.bills.lookup(input))),
    pay: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            idempotencyKey: idString,
            billerId: z.string().min(1).max(64),
            reference: z.string().min(1).max(64),
            amount: amountString,
            fromSpaceId: z.string().uuid(),
            stepUpApprovalId: stepUpApprovalField,
          })
          .strict(),
      )
      .output(billView)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const space = await ownedSpace(bank, ctx.principal.userId, input.fromSpaceId);
          const binding = billPayStepUp({
            actor: ctx.principal.userId,
            idempotencyKey: input.idempotencyKey,
            billerId: input.billerId,
            reference: input.reference,
            fromSpaceId: input.fromSpaceId,
            assetId: space.assetId,
            amount: input.amount,
          });
          await requireStepUp(stepUp, ctx.principal, binding, input.stepUpApprovalId);
          return bank.bills.pay({ userId: ctx.principal.userId, ...input });
        }),
      ),
    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            limit: limitField,
            status: z.enum(['submitted', 'accepted', 'paid', 'failed', 'returned']).optional(),
            cursor: z.string().min(1).max(512).optional(),
          })
          .strict(),
      )
      .output(z.object({ items: z.array(billView), nextCursor: z.string().nullable() }))
      .query(({ ctx, input }) => guard(() => bank.bills.list({ userId: ctx.principal.userId, ...input }))),
    get: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ id: z.string().uuid() }).strict())
      .output(billView)
      .query(({ ctx, input }) => guard(() => bank.bills.get(ctx.principal.userId, input.id))),
    recurring: router({
      create: scopedProcedure('bank:write', { module: 'bank' })
        .input(
          z
            .object({
              idempotencyKey: idString,
              billerId: z.string().min(1).max(64),
              reference: z.string().min(1).max(64),
              amount: amountString,
              fromSpaceId: z.string().uuid(),
              cadence: z.enum(['weekly', 'monthly']),
              startsAt: z.string().datetime({ offset: true }),
              endsAt: z.string().datetime({ offset: true }).optional(),
              stepUpApprovalId: stepUpApprovalField,
            })
            .strict(),
        )
        .output(recurringView)
        .mutation(({ ctx, input }) =>
          guard(async () => {
            const space = await ownedSpace(bank, ctx.principal.userId, input.fromSpaceId);
            const binding = billRecurringStepUp({
              actor: ctx.principal.userId,
              idempotencyKey: input.idempotencyKey,
              billerId: input.billerId,
              reference: input.reference,
              fromSpaceId: input.fromSpaceId,
              assetId: space.assetId,
              amount: input.amount,
              cadence: input.cadence,
              startsAt: input.startsAt,
              endsAt: input.endsAt,
            });
            await requireStepUp(stepUp, ctx.principal, binding, input.stepUpApprovalId);
            return bank.bills.createRecurring({
              userId: ctx.principal.userId,
              idempotencyKey: input.idempotencyKey,
              billerId: input.billerId,
              reference: input.reference,
              amount: input.amount,
              fromSpaceId: input.fromSpaceId,
              cadence: input.cadence,
              startsAt: new Date(input.startsAt),
              endsAt: input.endsAt ? new Date(input.endsAt) : null,
            });
          }),
        ),
      pause: scopedProcedure('bank:write', { module: 'bank' })
        .input(z.object({ id: z.string().uuid() }).strict())
        .output(recurringView)
        .mutation(({ ctx, input }) => guard(() => bank.bills.pauseRecurring(ctx.principal.userId, input.id))),
      cancel: scopedProcedure('bank:write', { module: 'bank' })
        .input(z.object({ id: z.string().uuid() }).strict())
        .output(recurringView)
        .mutation(({ ctx, input }) => guard(() => bank.bills.cancelRecurring(ctx.principal.userId, input.id))),
      list: scopedProcedure('bank:read', { module: 'bank' })
        .input(z.object({ limit: limitField }).strict())
        .output(z.array(recurringView))
        .query(({ ctx, input }) => guard(() => bank.bills.listRecurring({ userId: ctx.principal.userId, limit: input.limit }))),
    }),
    runDue: jobProcedure
      .input(z.object({ limit: z.number().int().min(1).max(50) }).strict())
      .output(
        z.object({
          considered: z.number().int(),
          settled: z.number().int(),
          refused: z.number().int(),
          failures: z.array(z.object({ scheduleId: z.string(), code: z.string() })),
        }),
      )
      .mutation(({ input }) => guard(() => bank.bills.runDue(input.limit))),
    ops: router({
      summary: scopedProcedure('admin:read', { module: 'bank' })
        .output(
          z.object({
            asOf: z.string(),
            counts: z.object({ submitted: z.number(), accepted: z.number(), paid: z.number(), failed: z.number(), returned: z.number() }),
            volumes: z.array(z.object({ status: z.string(), assetId: z.string(), count: z.number(), amount: amountString })),
            rails: z.object({
              billerDirectory: z.enum(['unset', 'live']),
              lookup: z.enum(['unset', 'live']),
              payRail: z.enum(['unset', 'live']),
              blocker: z.literal('socket.psp-partners'),
            }),
          }),
        )
        .query(() => guard(() => bank.bills.opsSummary())),
      failed: scopedProcedure('admin:read', { module: 'bank' })
        .input(z.object({ limit: limitField, cursor: z.string().min(1).max(512).optional() }).strict())
        .output(z.object({ items: z.array(billView.extend({ userId: z.string() })), nextCursor: z.string().nullable() }))
        .query(({ input }) => guard(() => bank.bills.opsFailed(input))),
      get: scopedProcedure('admin:read', { module: 'bank' })
        .input(z.object({ id: z.string().uuid() }).strict())
        .output(billView.extend({ userId: z.string() }))
        .query(({ input }) => guard(() => bank.bills.opsGet(input.id))),
    }),
  });
}

export function createGlobalRouter(bank: Pick<BankServices, 'globalSend' | 'globalHolds' | 'spaces'>, stepUp: StepUpGate) {
  return router({
    corridors: router({
      list: scopedProcedure('bank:read', { module: 'bank' })
        .output(
          z.array(
            z.object({
              country: z.string(),
              currency: z.string(),
              deliveryMethods: z.array(z.string()),
              minAmount: z.string().nullable(),
              maxAmount: z.string().nullable(),
              cutOffTime: z.string().nullable(),
            }),
          ),
        )
        .query(() => guard(() => bank.globalSend.corridors())),
    }),
    recipients: router({
      validate: scopedProcedure('bank:read', { module: 'bank' })
        .input(z.object({ account: z.string().min(1).max(64), bic: z.string().max(11).optional() }).strict())
        .output(
          z.object({
            format: z.enum(['valid', 'invalid']),
            formatKind: z.enum(['iban', 'ifsc', 'account_number']).nullable(),
            normalized: z.string().nullable(),
            bicLookup: z.discriminatedUnion('status', [
              z.object({ status: z.literal('not_requested') }),
              z.object({ status: z.literal('invalid'), code: z.literal('bank.global_bic_format_invalid') }),
              z.object({
                status: z.literal('refused'),
                code: z.literal('bank.global_bic_directory_unset'),
                blocker: z.literal('socket.psp-partners'),
              }),
              z.object({ status: z.literal('unmatched') }),
              z.object({ status: z.literal('matched'), bic: z.string(), bankName: z.string() }),
            ]),
          }),
        )
        .query(({ input }) => guard(() => bank.globalSend.validateRecipient(input))),
      add: scopedProcedure('bank:write', { module: 'bank' })
        .input(
          z
            .object({
              idempotencyKey: idString,
              name: z.string().min(1).max(140),
              account: z.string().min(1).max(64),
              country: z.string().length(2),
              bic: z.string().max(11).optional(),
              label: z.string().max(64).optional(),
            })
            .strict(),
        )
        .output(
          z.object({
            id: z.string(),
            label: z.string().nullable(),
            name: z.string(),
            account: z.string(),
            accountKind: z.enum(['iban', 'ifsc', 'account_number']),
            bic: z.string().nullable(),
            country: z.string(),
            createdAt: z.string(),
          }),
        )
        .mutation(({ ctx, input }) => guard(() => bank.globalSend.addRecipient({ userId: ctx.principal.userId, ...input }))),
      list: scopedProcedure('bank:read', { module: 'bank' })
        .input(z.object({ limit: limitField }).strict())
        .output(
          z.array(
            z.object({
              id: z.string(),
              label: z.string().nullable(),
              name: z.string(),
              account: z.string(),
              accountKind: z.enum(['iban', 'ifsc', 'account_number']),
              bic: z.string().nullable(),
              country: z.string(),
              createdAt: z.string(),
            }),
          ),
        )
        .query(({ ctx, input }) => guard(() => bank.globalSend.listRecipients({ userId: ctx.principal.userId, limit: input.limit }))),
      remove: scopedProcedure('bank:write', { module: 'bank' })
        .input(z.object({ recipientId: z.string().uuid(), idempotencyKey: idString }).strict())
        .output(z.object({ removed: z.literal(true) }))
        .mutation(({ ctx, input }) => guard(() => bank.globalSend.removeRecipient({ userId: ctx.principal.userId, ...input }))),
    }),
    quote: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ asset: z.string().min(1).max(16), amount: amountString, toCurrency: z.string().min(3).max(8) }).strict())
      .output(
        z.object({
          rate: amountString,
          fee: amountString,
          feeAsset: z.string(),
          receiveAmount: amountString,
          validUntil: z.string(),
          eta: z.string(),
        }),
      )
      .query(({ input }) => guard(() => bank.globalSend.quote(input))),
    send: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            idempotencyKey: idString,
            fromSpaceId: z.string().uuid(),
            amount: amountString,
            toCurrency: z.string().min(3).max(8),
            recipientId: z.string().uuid(),
            country: z.string().length(2),
            deliveryMethod: z.string().min(1).max(64),
            compliance: z.record(z.string().max(64), z.string().max(200)).optional(),
            stepUpApprovalId: stepUpApprovalField,
          })
          .strict(),
      )
      .output(sendView)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const space = await ownedSpace(bank, ctx.principal.userId, input.fromSpaceId);
          const binding = globalSendStepUp({
            actor: ctx.principal.userId,
            idempotencyKey: input.idempotencyKey,
            fromSpaceId: input.fromSpaceId,
            assetId: space.assetId,
            amount: input.amount,
            toCurrency: input.toCurrency.trim().toUpperCase(),
            recipientId: input.recipientId,
            country: input.country.trim().toUpperCase(),
            deliveryMethod: input.deliveryMethod.trim(),
            compliance: input.compliance,
          });
          await requireStepUp(stepUp, ctx.principal, binding, input.stepUpApprovalId);
          return bank.globalSend.send({ userId: ctx.principal.userId, ...input });
        }),
      ),
    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ limit: limitField, cursor: z.string().min(1).max(512).optional() }).strict())
      .output(z.object({ items: z.array(sendView), nextCursor: z.string().nullable() }))
      .query(({ ctx, input }) => guard(() => bank.globalSend.list({ userId: ctx.principal.userId, ...input }))),
    get: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ id: z.string().uuid() }).strict())
      .output(sendView)
      .query(({ ctx, input }) => guard(() => bank.globalSend.get(ctx.principal.userId, input.id))),
    hold: router({
      get: scopedProcedure('bank:read', { module: 'bank' })
        .input(z.object({ id: z.string().uuid() }).strict())
        .output(customerHoldView)
        .query(({ ctx, input }) => guard(() => bank.globalHolds.forCustomer(ctx.principal.userId, input.id))),
      uploadProof: scopedProcedure('bank:write', { module: 'bank' })
        .input(
          z
            .object({
              id: z.string().uuid(),
              name: z.string().min(1).max(200),
              type: z.string().min(3).max(100),
              contentBase64: z.string().min(4).max(40_000_000),
            })
            .strict(),
        )
        .output(customerHoldView)
        .mutation(({ ctx, input }) =>
          guard(() =>
            bank.globalHolds.uploadProof({
              userId: ctx.principal.userId,
              sendId: input.id,
              name: input.name,
              type: input.type,
              contentBase64: input.contentBase64,
            }),
          ),
        ),
    }),
    ops: router({
      holds: scopedProcedure('admin:read', { module: 'bank' })
        .input(z.object({ limit: limitField }).strict())
        .output(z.array(operatorHoldView.extend({ send: sendView.extend({ userId: z.string() }) })))
        .query(({ input }) => guard(() => bank.globalHolds.queue(input))),
      hold: scopedProcedure('admin:compliance', { module: 'bank' })
        .input(
          z
            .object({
              sendId: z.string().uuid(),
              holdKey: idString,
              reason: z.string().min(1).max(500),
              infoRequest: z.string().min(1).max(1000).optional(),
            })
            .strict(),
        )
        .output(operatorHoldView)
        .mutation(({ ctx, input }) => guard(() => bank.globalHolds.hold({ ...input, operatorId: ctx.principal.userId }))),
      requestInfo: scopedProcedure('admin:compliance', { module: 'bank' })
        .input(z.object({ sendId: z.string().uuid(), infoRequest: z.string().min(1).max(1000) }).strict())
        .output(operatorHoldView)
        .mutation(({ input }) => guard(() => bank.globalHolds.requestInfo(input))),
      release: scopedProcedure('admin:compliance', { module: 'bank' })
        .input(z.object({ sendId: z.string().uuid() }).strict())
        .output(sendView)
        .mutation(({ ctx, input }) => guard(() => bank.globalHolds.release({ sendId: input.sendId, operatorId: ctx.principal.userId }))),
      linkReference: scopedProcedure('admin:compliance', { module: 'bank' })
        .input(z.object({ sendId: z.string().uuid(), reference: z.string().min(6).max(64) }).strict())
        .output(z.object({ linked: z.literal(true), send: sendView }))
        .mutation(({ ctx, input }) =>
          guard(() =>
            bank.globalHolds.linkReference({ sendId: input.sendId, reference: input.reference, operatorId: ctx.principal.userId }),
          ),
        ),
      proof: scopedProcedure('admin:compliance', { module: 'bank' })
        .input(z.object({ sendId: z.string().uuid() }).strict())
        .output(z.object({ name: z.string(), type: z.string(), contentBase64: z.string() }))
        .query(({ input }) => guard(() => bank.globalHolds.proofFor(input.sendId))),
      controls: scopedProcedure('admin:read', { module: 'bank' })
        .output(
          z.object({
            payeeControls: z.object({ state: z.enum(['unset', 'published']), blockedCount: z.number() }),
            exchangeAllowance: z.object({
              state: z.enum(['unset', 'published']),
              windowDays: z.number().nullable(),
              exchangeCount: z.number(),
            }),
            proofLimits: z.object({
              state: z.enum(['unset', 'published']),
              allowedTypes: z.array(z.string()),
              maxBytes: z.number().nullable(),
            }),
          }),
        )
        .query(() => ({
          payeeControls: bank.globalSend.payeeControlsStatus(),
          exchangeAllowance: bank.globalSend.exchangeAllowanceStatus(),
          proofLimits: bank.globalHolds.proofLimitsStatus(),
        })),
      summary: scopedProcedure('admin:read', { module: 'bank' })
        .output(
          z.object({
            asOf: z.string(),
            counts: z.object({
              submitted: z.number(),
              held: z.number(),
              sent: z.number(),
              on_the_way: z.number(),
              arrived: z.number(),
              failed: z.number(),
            }),
            volumes: z.array(z.object({ status: z.string(), assetId: z.string(), count: z.number(), amount: amountString })),
            rails: z.object({
              corridors: z.enum(['unset', 'live']),
              fx: z.enum(['unset', 'live']),
              payout: z.enum(['unset', 'live']),
              bic: z.enum(['unset', 'live']),
              travelRule: z.enum(['undecided', 'recorded']),
              blocker: z.literal('socket.psp-partners'),
            }),
          }),
        )
        .query(() => guard(() => bank.globalSend.opsSummary())),
      failed: scopedProcedure('admin:read', { module: 'bank' })
        .input(z.object({ limit: limitField }).strict())
        .output(z.array(sendView.extend({ userId: z.string() })))
        .query(({ input }) => guard(() => bank.globalSend.opsFailed(input))),
      get: scopedProcedure('admin:read', { module: 'bank' })
        .input(z.object({ id: z.string().uuid() }).strict())
        .output(sendView.extend({ userId: z.string() }))
        .query(({ input }) => guard(() => bank.globalSend.opsGet(input.id))),
    }),
  });
}

async function ownedSpace(bank: Pick<BankServices, 'spaces'>, userId: string, spaceId: string) {
  try {
    const space = await bank.spaces.get(spaceId);
    if (space.userId !== userId) throw new PersonalPayError('No such space.', 'bank.bills_space_not_found', 'NOT_FOUND');
    return space;
  } catch (err) {
    if (err instanceof PersonalPayError) throw err;
    if (err instanceof BankError && err.code === 'bank.space_not_found') {
      throw new PersonalPayError('No such space.', 'bank.bills_space_not_found', 'NOT_FOUND');
    }
    throw err;
  }
}
