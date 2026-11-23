import { z } from 'zod';
import { router, scopedProcedure, TRPCError, publicProcedure } from '@intafaced/contracts/trpc';
import {
  BANK_GLOBAL_CANCEL,
  BANK_GLOBAL_CORRIDORS_LIST,
  BANK_GLOBAL_HOLD_GET,
  BANK_GLOBAL_HOLD_UPLOAD_PROOF,
  BANK_GLOBAL_LIST,
  BANK_GLOBAL_PARTNER,
  BANK_GLOBAL_QUOTE,
  BANK_GLOBAL_RECALL,
  BANK_GLOBAL_RECEIPT,
  BANK_GLOBAL_RECIPIENTS_ADD,
  BANK_GLOBAL_RECIPIENTS_LIST,
  BANK_GLOBAL_RECIPIENTS_REMOVE,
  BANK_GLOBAL_RECIPIENTS_VALIDATE,
  BANK_GLOBAL_SEND,
  GLOBAL_HOLD_STATES,
  globalSendSchema,
} from '@intafaced/contracts/bank-global-procedures';
import { mountRecord, type RefusalOf } from '@intafaced/contracts/procedure-mount';
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

const holdState = z.enum(GLOBAL_HOLD_STATES);
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

/**
 * The refusal `guard` sent, read by its code: a personal-pay refusal or a bank refusal it passed on, for the records'
 * strict mount (`@intafaced/contracts/procedure-mount`).
 */
const personalPayRefusal: RefusalOf = (err) =>
  err instanceof TRPCError && (err.cause instanceof PersonalPayError || err.cause instanceof BankError)
    ? { code: err.cause.code, error: err }
    : undefined;

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
            fromSpaceId: z.string().guid(),
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
      .input(z.object({ id: z.string().guid() }).strict())
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
              fromSpaceId: z.string().guid(),
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
        .input(z.object({ id: z.string().guid() }).strict())
        .output(recurringView)
        .mutation(({ ctx, input }) => guard(() => bank.bills.pauseRecurring(ctx.principal.userId, input.id))),
      cancel: scopedProcedure('bank:write', { module: 'bank' })
        .input(z.object({ id: z.string().guid() }).strict())
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
        .input(z.object({ id: z.string().guid() }).strict())
        .output(billView.extend({ userId: z.string() }))
        .query(({ input }) => guard(() => bank.bills.opsGet(input.id))),
    }),
  });
}

export function createGlobalRouter(bank: Pick<BankServices, 'globalSend' | 'globalHolds' | 'spaces'>, stepUp: StepUpGate) {
  return router({
    /** Whether a TEST stand-in answers global sends on this deployment, and its label; null standIn means it does not. */
    partner: mountRecord(BANK_GLOBAL_PARTNER, () => bank.globalSend.partner(), personalPayRefusal),
    corridors: router({
      list: mountRecord(BANK_GLOBAL_CORRIDORS_LIST, () => guard(() => bank.globalSend.corridors()), personalPayRefusal),
    }),
    recipients: router({
      validate: mountRecord(
        BANK_GLOBAL_RECIPIENTS_VALIDATE,
        ({ input }) => guard(() => bank.globalSend.validateRecipient(input)),
        personalPayRefusal,
      ),
      add: mountRecord(
        BANK_GLOBAL_RECIPIENTS_ADD,
        ({ ctx, input }) => guard(() => bank.globalSend.addRecipient({ userId: ctx.principal.userId, ...input })),
        personalPayRefusal,
      ),
      list: mountRecord(
        BANK_GLOBAL_RECIPIENTS_LIST,
        ({ ctx, input }) => guard(() => bank.globalSend.listRecipients({ userId: ctx.principal.userId, limit: input.limit })),
        personalPayRefusal,
      ),
      remove: mountRecord(
        BANK_GLOBAL_RECIPIENTS_REMOVE,
        ({ ctx, input }) => guard(() => bank.globalSend.removeRecipient({ userId: ctx.principal.userId, ...input })),
        personalPayRefusal,
      ),
    }),
    /** Takes a quote and locks it: a write, since the lock is kept until the provider's valid-until. */
    quote: mountRecord(
      BANK_GLOBAL_QUOTE,
      ({ ctx, input }) => guard(() => bank.globalSend.quote({ userId: ctx.principal.userId, ...input })),
      personalPayRefusal,
    ),
    send: mountRecord(
      BANK_GLOBAL_SEND,
      ({ ctx, input }) =>
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
            quoteId: input.quoteId,
          });
          await requireStepUp(stepUp, ctx.principal, binding, input.stepUpApprovalId);
          return bank.globalSend.send({ userId: ctx.principal.userId, ...input });
        }),
      personalPayRefusal,
    ),
    list: mountRecord(
      BANK_GLOBAL_LIST,
      ({ ctx, input }) =>
        guard(async () => {
          // The owner's auto-cancel window is applied before the customer reads their sends.
          await bank.globalHolds.expireOverdue({ userId: ctx.principal.userId });
          return bank.globalSend.list({ userId: ctx.principal.userId, ...input });
        }),
      personalPayRefusal,
    ),
    get: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ id: z.string().guid() }).strict())
      .output(globalSendSchema)
      .query(({ ctx, input }) =>
        guard(async () => {
          await bank.globalSend.get(ctx.principal.userId, input.id);
          await bank.globalHolds.expireOverdue({ sendId: input.id });
          return bank.globalSend.get(ctx.principal.userId, input.id);
        }),
      ),
    /** Cancel a send while it is on hold with nothing posted (BK-xfer-08). Nothing moves, so no step-up. */
    cancel: mountRecord(
      BANK_GLOBAL_CANCEL,
      ({ ctx, input }) => guard(() => bank.globalHolds.cancel(ctx.principal.userId, input.id)),
      personalPayRefusal,
    ),
    /** Ask for a send that left to come back (wrong person or wrong details). Nothing moves, so no step-up. */
    recall: mountRecord(
      BANK_GLOBAL_RECALL,
      ({ ctx, input }) => guard(() => bank.globalSend.recall({ userId: ctx.principal.userId, ...input })),
      personalPayRefusal,
    ),
    /** The signed receipt of a send that left: its text, SHA-256, signature and ledger transaction id. */
    receipt: mountRecord(
      BANK_GLOBAL_RECEIPT,
      ({ ctx, input }) => guard(() => bank.globalSend.receipt(ctx.principal.userId, input.id)),
      personalPayRefusal,
    ),
    /** The owner's auto-cancel rule for a send on hold, as the tracker shows it. */
    autoCancelRule: scopedProcedure('bank:read', { module: 'bank' })
      .output(z.object({ state: z.enum(['unset', 'published']), hours: z.number().nullable() }).strict())
      .query(() => guard(async () => bank.globalHolds.autoCancelRule())),
    hold: router({
      get: mountRecord(
        BANK_GLOBAL_HOLD_GET,
        ({ ctx, input }) => guard(() => bank.globalHolds.forCustomer(ctx.principal.userId, input.id)),
        personalPayRefusal,
      ),
      uploadProof: mountRecord(
        BANK_GLOBAL_HOLD_UPLOAD_PROOF,
        ({ ctx, input }) =>
          guard(() =>
            bank.globalHolds.uploadProof({
              userId: ctx.principal.userId,
              sendId: input.id,
              name: input.name,
              type: input.type,
              contentBase64: input.contentBase64,
            }),
          ),
        personalPayRefusal,
      ),
    }),
    ops: router({
      /** The TEST stand-in's own record of a send it paid out (local stack only): what it converted, and how many times. */
      standInPayout: scopedProcedure('admin:read', { module: 'bank' })
        .input(z.object({ sendId: z.string().guid() }).strict())
        .output(
          z.object({
            sendId: z.string(),
            quoteId: z.string(),
            assetId: z.string(),
            amount: z.string(),
            toCurrency: z.string(),
            rate: z.string(),
            receiveAmount: z.string(),
            conversions: z.number().int(),
            calls: z.number().int(),
          }),
        )
        .query(({ input }) => guard(async () => bank.globalSend.standInPayout(input.sendId))),
      holds: scopedProcedure('admin:read', { module: 'bank' })
        .input(z.object({ limit: limitField }).strict())
        .output(z.array(operatorHoldView.extend({ send: globalSendSchema.extend({ userId: z.string() }) })))
        .query(({ input }) => guard(() => bank.globalHolds.queue(input))),
      hold: scopedProcedure('admin:compliance', { module: 'bank' })
        .input(
          z
            .object({
              sendId: z.string().guid(),
              holdKey: idString,
              reason: z.string().min(1).max(500),
              infoRequest: z.string().min(1).max(1000).optional(),
            })
            .strict(),
        )
        .output(operatorHoldView)
        .mutation(({ ctx, input }) => guard(() => bank.globalHolds.hold({ ...input, operatorId: ctx.principal.userId }))),
      requestInfo: scopedProcedure('admin:compliance', { module: 'bank' })
        .input(z.object({ sendId: z.string().guid(), infoRequest: z.string().min(1).max(1000) }).strict())
        .output(operatorHoldView)
        .mutation(({ input }) => guard(() => bank.globalHolds.requestInfo(input))),
      release: scopedProcedure('admin:compliance', { module: 'bank' })
        .input(z.object({ sendId: z.string().guid() }).strict())
        .output(globalSendSchema)
        .mutation(({ ctx, input }) => guard(() => bank.globalHolds.release({ sendId: input.sendId, operatorId: ctx.principal.userId }))),
      linkReference: scopedProcedure('admin:compliance', { module: 'bank' })
        .input(z.object({ sendId: z.string().guid(), reference: z.string().min(6).max(64) }).strict())
        .output(z.object({ linked: z.literal(true), send: globalSendSchema }))
        .mutation(({ ctx, input }) =>
          guard(() =>
            bank.globalHolds.linkReference({ sendId: input.sendId, reference: input.reference, operatorId: ctx.principal.userId }),
          ),
        ),
      proof: scopedProcedure('admin:compliance', { module: 'bank' })
        .input(z.object({ sendId: z.string().guid() }).strict())
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
              cancelled: z.number(),
              returned: z.number(),
              refunded: z.number(),
            }),
            volumes: z.array(z.object({ status: z.string(), assetId: z.string(), count: z.number(), amount: amountString })),
            rails: z.object({
              corridors: z.enum(['unset', 'live']),
              fx: z.enum(['unset', 'live']),
              payout: z.enum(['unset', 'live']),
              bic: z.enum(['unset', 'live']),
              travelRule: z.enum(['undecided', 'recorded']),
              blocker: z.literal('socket.psp-partners'),
              standIn: z.string().nullable(),
            }),
          }),
        )
        .query(() => guard(() => bank.globalSend.opsSummary())),
      failed: scopedProcedure('admin:read', { module: 'bank' })
        .input(z.object({ limit: limitField }).strict())
        .output(z.array(globalSendSchema.extend({ userId: z.string() })))
        .query(({ input }) => guard(() => bank.globalSend.opsFailed(input))),
      get: scopedProcedure('admin:read', { module: 'bank' })
        .input(z.object({ id: z.string().guid() }).strict())
        .output(globalSendSchema.extend({ userId: z.string() }))
        .query(({ input }) => guard(() => bank.globalSend.opsGet(input.id))),
      recalls: scopedProcedure('admin:read', { module: 'bank' })
        .input(z.object({ limit: limitField }).strict())
        .output(z.array(globalSendSchema.extend({ userId: z.string() })))
        .query(({ input }) => guard(() => bank.globalSend.opsRecalls(input))),
      /** The rail sent a send back: record it with the rail's reference. Nothing posts. */
      recordReturn: scopedProcedure('admin:compliance', { module: 'bank' })
        .input(z.object({ sendId: z.string().guid(), returnRef: z.string().min(1).max(128) }).strict())
        .output(globalSendSchema.extend({ userId: z.string() }))
        .mutation(({ ctx, input }) => guard(() => bank.globalSend.recordReturn({ ...input, operatorId: ctx.principal.userId }))),
      /** Refund a returned send to its sender, once, by a different operator from the one who recorded the return. */
      refundReturn: scopedProcedure('admin:compliance', { module: 'bank' })
        .input(z.object({ sendId: z.string().guid() }).strict())
        .output(globalSendSchema.extend({ userId: z.string() }))
        .mutation(({ ctx, input }) =>
          guard(() => bank.globalSend.refundReturn({ sendId: input.sendId, operatorId: ctx.principal.userId })),
        ),
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
