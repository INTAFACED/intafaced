import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { activityFailure } from '../activity/activity.router.js';
import { assertSelf } from '../assert-self.js';
import { plainNote, plainReference } from '../transfers/personal-pay.js';
import {
  createTransferBinding,
  scheduleBinding,
  scheduleEditBinding,
  scheduleToUserBinding,
  toUserBinding,
} from '../step-up/money-out-fields.js';
import { amountString, gateDestination, hideDestinationDetail, stepUpApprovalField } from './shared.js';
import { guard } from './errors.js';
import type { BankRouterContext } from './context.js';

export function createTransfersRouter(c: BankRouterContext) {
  const { bank, stepUpEnforced, requireStepUp } = c;
  return router({
    /**
     * The caller's own transfer history: money sent to or received from another person, and moves between their own
     * accounts. It is the activity feed narrowed to those kinds, so it has the same sources, paging and ownership
     * rules and no second list of its own. Every line is a posted ledger entry, so every line is `completed`; a failed
     * or skipped standing-order run is read with `transfers.executions`.
     */
    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(200).optional(),
            cursor: z.string().min(1).max(16_384).optional(),
            assetId: z.string().min(1).max(16).optional(),
            from: z.string().datetime({ offset: true }).optional(),
            to: z.string().datetime({ offset: true }).optional(),
          })
          .strict()
          .optional(),
      )
      .output(
        z.object({
          items: z.array(
            z.object({
              id: z.string(),
              txId: z.string(),
              kind: z.enum(['transfer_in', 'transfer_out', 'space_move']),
              direction: z.enum(['in', 'out']),
              asset: z.string(),
              amount: amountString,
              postedAt: z.string().datetime(),
              status: z.literal('completed'),
              counterparty: z.object({ handle: z.string() }).nullable(),
              spaceName: z.string().nullable(),
              note: z.string().optional(),
              reference: z.string().optional(),
            }),
          ),
          nextCursor: z.string().nullable(),
        }),
      )
      .query(async ({ ctx, input }) => {
        try {
          const page = await bank.activity.list(ctx.principal.userId, {
            ...input,
            kind: ['transfer_in', 'transfer_out', 'space_move'],
          });
          return {
            items: page.items.map((item) => ({
              id: item.id,
              txId: item.txId,
              kind: item.kind as 'transfer_in' | 'transfer_out' | 'space_move',
              direction: item.direction,
              asset: item.asset,
              amount: item.amount,
              postedAt: item.postedAt,
              status: 'completed' as const,
              counterparty: item.counterparty,
              spaceName: item.spaceName,
              ...(item.note ? { note: item.note } : {}),
              ...(item.reference ? { reference: item.reference } : {}),
            })),
            nextCursor: page.nextCursor,
          };
        } catch (err) {
          activityFailure(err);
        }
      }),

    /**
     * `transferId` is supplied by the client so a retried request is the same
     * transfer, not a second one (§5: idempotency keys are business keys).
     */
    create: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          transferId: z.string().min(8).max(64),
          fromSpaceId: z.string().guid(),
          toSpaceId: z.string().guid(),
          amount: amountString,
          note: z
            .string()
            .min(1)
            .max(140)
            .refine((value) => !/[\u0000-\u001F]/.test(value), 'note has a control character')
            .optional(),
          reference: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[\x20-\x7E]+$/)
            .optional(),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(z.object({ ledgerTxId: z.string(), amount: amountString }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const from = await bank.spaces.get(input.fromSpaceId);

          /**
           * ONLY THE `from` SIDE IS OWNER-CHECKED, AND THAT IS DELIBERATE.
           *
           * A transfer takes value out of `from` and puts it into `to`. The
           * side that can lose something is the debit, and it is checked here,
           * so this is not a hole: nobody can move money out of an account that
           * is not theirs.
           *
           * The credit side is NOT checked because paying somebody else is the
           * product. `bank-service.test.ts` pins that a transfer "moves value
           * between two different users spaces", and a check here would delete
           * that feature rather than secure it. An operation naming two objects
           * authorises against both OR carries a written reason for the
           * exemption at the call site; this paragraph is that reason, and it
           * exists so the next reader does not have to work out from an absence
           * whether the omission was a decision or an oversight.
           *
           * What the missing check DID cost was disclosure, not safety — see
           * `gateDestination`, which is the half that was actually missing.
           */
          assertSelf(ctx.principal.userId, from.userId);

          // Money to somebody else's space needs a step-up. A move between the caller's OWN spaces never
          // does. An unknown destination is treated as foreign, so this cannot tell a stranger which ids exist.
          if (stepUpEnforced) {
            const to = await bank.spaces.find(input.toSpaceId);
            if (to === null || to.userId !== ctx.principal.userId) {
              await requireStepUp(
                ctx.principal,
                createTransferBinding({
                  actor: ctx.principal.userId,
                  transferId: input.transferId,
                  fromSpaceId: input.fromSpaceId,
                  toSpaceId: input.toSpaceId,
                  assetId: from.assetId,
                  amount: input.amount,
                  note: input.note,
                  reference: input.reference,
                }),
                input.stepUpApprovalId,
              );
            }
          }

          const gate = await gateDestination(bank, ctx.principal.userId, from, input.toSpaceId);

          const result = await bank.transfers
            .transfer({
              transferId: input.transferId,
              fromSpaceId: input.fromSpaceId,
              toSpaceId: input.toSpaceId,
              amount: parseAmount(input.amount),
              note: input.note ?? null,
              reference: input.reference ?? null,
            })
            .catch(async (err: unknown) => {
              const shown = gate.mayDescribe ? err : hideDestinationDetail(err);
              // RC-wallet-09: the debit side is the caller's own space (assertSelf above), so these are the caller's own figures.
              throw await bank.spendFigures.refusal(shown, ctx.principal.userId, from.assetId);
            });
          return { ledgerTxId: result.ledgerTxId, amount: result.amount };
        }),
      ),

    toUser: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          transferId: z.string().min(8).max(64),
          fromSpaceId: z.string().guid(),
          toUserId: z.string().min(1).max(64),
          amount: amountString,
          /** Recipient-visible plain text. Omitted means no note. */
          note: z.string().max(140).optional(),
          /** Printable payment reference. Omitted means none. */
          reference: z.string().max(64).optional(),
          /** Settles this open payment request. One payment, one request. */
          requestId: z.string().guid().optional(),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(
        z.object({
          ledgerTxId: z.string(),
          amount: amountString,
          note: z.string().nullable(),
          reference: z.string().nullable(),
          requestId: z.string().guid().nullable(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const from = await bank.spaces.get(input.fromSpaceId);
          assertSelf(ctx.principal.userId, from.userId);
          const note = plainNote(input.note) ?? undefined;
          const reference = plainReference(input.reference) ?? undefined;
          if (stepUpEnforced && input.toUserId !== ctx.principal.userId) {
            await requireStepUp(
              ctx.principal,
              toUserBinding({
                actor: ctx.principal.userId,
                transferId: input.transferId,
                fromSpaceId: input.fromSpaceId,
                toUserId: input.toUserId,
                assetId: from.assetId,
                amount: input.amount,
                ...(note ? { note } : {}),
                ...(reference ? { reference } : {}),
                ...(input.requestId ? { requestId: input.requestId } : {}),
              }),
              input.stepUpApprovalId,
            );
          }
          const result = await bank.personalPay.send({
            actorUserId: ctx.principal.userId,
            transferId: input.transferId,
            fromSpaceId: input.fromSpaceId,
            toUserId: input.toUserId,
            amount: parseAmount(input.amount),
            note,
            reference,
            requestId: input.requestId ?? null,
          });
          return {
            ledgerTxId: result.ledgerTxId,
            amount: result.amount,
            note: result.note,
            reference: result.reference,
            requestId: result.requestId,
          };
        }),
      ),

    /** Receipt for one personal send. Parties only. A stranger gets the same not-found as a missing id. */
    get: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ ledgerTxId: z.string().min(1).max(128) }))
      .output(
        z.object({
          ledgerTxId: z.string(),
          transferId: z.string(),
          createdAt: z.string().datetime(),
          fromHandle: z.string().nullable(),
          toHandle: z.string().nullable(),
          handlesBlocker: z.string().nullable(),
          fee: z.null(),
          status: z.literal('posted'),
          amount: amountString,
          assetId: z.string(),
          note: z.string().nullable(),
          reference: z.string().nullable(),
        }),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const row = await bank.personalPay.get(ctx.principal.userId, input.ledgerTxId);
          return {
            ledgerTxId: row.ledgerTxId,
            transferId: row.transferId,
            createdAt: row.createdAt,
            fromHandle: row.fromHandle,
            toHandle: row.toHandle,
            handlesBlocker: row.handlesBlocker,
            fee: row.fee,
            status: row.status,
            amount: row.amount,
            assetId: row.assetId,
            note: row.note,
            reference: row.reference,
          };
        }),
      ),

    /**
     * Limits and fee for a personal send, before the review step.
     * Refuses when nothing is published. Never fills a zero fee or a default cap.
     */
    quote: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ assetId: z.string().min(1).max(16), amount: amountString }))
      .output(
        z.object({
          assetId: z.string(),
          amount: amountString,
          perTransferLimit: amountString,
          dailyLimit: amountString,
          spentToday: amountString,
          fee: amountString,
          feeBlocker: z.string().nullable(),
          withinPerTransfer: z.boolean(),
          withinDaily: z.boolean(),
        }),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => bank.personalPay.quote(ctx.principal.userId, input.assetId, parseAmount(input.amount))),
      ),

    scheduleToUser: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          fromSpaceId: z.string().guid(),
          toUserId: z.string().min(1).max(64),
          amount: amountString,
          cadence: z.enum(['daily', 'weekly', 'monthly', 'once']),
          startsAt: z.string().datetime({ offset: true }),
          endsAt: z.string().datetime({ offset: true }).optional(),
          scheduleId: z.string().guid(),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(z.object({ id: z.string(), nextRunAt: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const from = await bank.spaces.get(input.fromSpaceId);
          assertSelf(ctx.principal.userId, from.userId);
          // Approval happens at creation, and again for an edit of the amount or end (updateSchedule). The payee
          // never changes, and the order runs without a session, so execution, pause and resume need none (cancel
          // and pause are protective).
          if (stepUpEnforced && input.toUserId !== ctx.principal.userId) {
            await requireStepUp(
              ctx.principal,
              scheduleToUserBinding({
                actor: ctx.principal.userId,
                scheduleId: input.scheduleId,
                fromSpaceId: input.fromSpaceId,
                toUserId: input.toUserId,
                assetId: from.assetId,
                amount: input.amount,
                cadence: input.cadence,
                startsAt: input.startsAt,
                endsAt: input.endsAt,
              }),
              input.stepUpApprovalId,
            );
          }
          const schedule = await bank.transfers.scheduleToUser({
            userId: ctx.principal.userId,
            fromSpaceId: input.fromSpaceId,
            toUserId: input.toUserId,
            amount: parseAmount(input.amount),
            cadence: input.cadence,
            startsAt: new Date(input.startsAt),
            endsAt: input.endsAt ? new Date(input.endsAt) : null,
            scheduleId: input.scheduleId,
          });
          return { id: schedule.id, nextRunAt: schedule.nextRunAt.toISOString() };
        }),
      ),

    schedule: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          fromSpaceId: z.string().guid(),
          toSpaceId: z.string().guid(),
          amount: amountString,
          cadence: z.enum(['daily', 'weekly', 'monthly', 'once']),
          startsAt: z.string().datetime({ offset: true }),
          endsAt: z.string().datetime({ offset: true }).optional(),
          scheduleId: z.string().guid(),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(z.object({ id: z.string(), nextRunAt: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const from = await bank.spaces.get(input.fromSpaceId);
          // Same exemption, same reason as `transfers.create` above: the debit
          // side is the side that can lose value, and a standing order to
          // another user is the same product feature on a timer.
          assertSelf(ctx.principal.userId, from.userId);

          // A standing order to another person is approved at creation; an unknown destination counts as foreign.
          if (stepUpEnforced) {
            const to = await bank.spaces.find(input.toSpaceId);
            if (to === null || to.userId !== ctx.principal.userId) {
              await requireStepUp(
                ctx.principal,
                scheduleBinding({
                  actor: ctx.principal.userId,
                  scheduleId: input.scheduleId,
                  fromSpaceId: input.fromSpaceId,
                  toSpaceId: input.toSpaceId,
                  assetId: from.assetId,
                  amount: input.amount,
                  cadence: input.cadence,
                  startsAt: input.startsAt,
                  endsAt: input.endsAt,
                }),
                input.stepUpApprovalId,
              );
            }
          }

          // Same gate too, and it matters MORE here. A one-off transfer asks the
          // question once; a standing order that could be created against a
          // stranger's space and then have its asset mismatch reported back
          // turns the oracle into one a caller can leave running.
          const gate = await gateDestination(bank, ctx.principal.userId, from, input.toSpaceId);

          const schedule = await bank.transfers
            .schedule({
              userId: ctx.principal.userId,
              fromSpaceId: input.fromSpaceId,
              toSpaceId: input.toSpaceId,
              amount: parseAmount(input.amount),
              cadence: input.cadence,
              startsAt: new Date(input.startsAt),
              endsAt: input.endsAt ? new Date(input.endsAt) : null,
              scheduleId: input.scheduleId,
            })
            .catch((err: unknown) => {
              throw gate.mayDescribe ? err : hideDestinationDetail(err);
            });
          return { id: schedule.id, nextRunAt: schedule.nextRunAt.toISOString() };
        }),
      ),

    listSchedules: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            /**
             * Page size. Optional so omit reaches `bank.schedules_list_limit_unset`
             * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
             */
            limit: z.number().int().min(1).max(200).optional(),
            /** Only the orders paying into this one of the caller's own spaces (BK-pots-02). */
            toSpaceId: z.string().guid().optional(),
          })
          .optional(),
      )
      .output(
        z.array(
          z.object({
            id: z.string(),
            assetId: z.string(),
            amount: amountString,
            cadence: z.string(),
            startsAt: z.string(),
            endsAt: z.string().nullable(),
            nextRunAt: z.string(),
            status: z.string(),
            /** The revision an edit must name. */
            revision: z.number().int(),
            /** The caller's own space the order pays from. */
            fromSpaceId: z.string(),
            /** The caller's own space it pays into, or null when it pays another person. */
            toSpaceId: z.string().nullable(),
          }),
        ),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const schedules = await bank.transfers.listSchedules(
            ctx.principal.userId,
            input?.limit,
            input?.toSpaceId ? { toSpaceId: input.toSpaceId } : {},
          );
          return schedules.map((s) => ({
            id: s.id,
            assetId: s.assetId,
            amount: formatAmount(s.amount),
            cadence: s.cadence,
            startsAt: s.startsAt.toISOString(),
            endsAt: s.endsAt?.toISOString() ?? null,
            nextRunAt: s.nextRunAt.toISOString(),
            status: s.status,
            revision: s.revision,
            fromSpaceId: s.fromSpaceId,
            toSpaceId: s.ownToSpaceId,
          }));
        }),
      ),

    /**
     * Change a standing order's amount or end date (BK-xfer-10). The caller names the revision it read; an edit at a
     * revision that is no longer current refuses `bank.schedule_revision_conflict`. The recipient, cadence and start do
     * not change. Inside the owner-set cutoff before the next run it refuses `bank.schedule_cutoff`, and while the cutoff
     * is not published, `bank.schedule_edit_cutoff_unset`. Nothing is posted.
     */
    updateSchedule: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            scheduleId: z.string().guid(),
            revision: z.number().int().min(1),
            amount: amountString,
            /** The new last date, or null for "until cancelled". Required, so leaving it out never clears an end. */
            endsAt: z.string().datetime({ offset: true }).nullable(),
            stepUpApprovalId: stepUpApprovalField,
          })
          .strict(),
      )
      .output(
        z.object({
          id: z.string(),
          revision: z.number().int(),
          amount: amountString,
          endsAt: z.string().nullable(),
          nextRunAt: z.string(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          // Ownership before the write, as `cancel` does.
          const schedule = await bank.transfers.getSchedule(input.scheduleId);
          assertSelf(ctx.principal.userId, schedule.userId);
          if (stepUpEnforced) {
            const to = await bank.spaces.find(schedule.toSpaceId);
            if (to === null || to.userId !== ctx.principal.userId) {
              await requireStepUp(
                ctx.principal,
                scheduleEditBinding({
                  actor: ctx.principal.userId,
                  scheduleId: schedule.id,
                  fromSpaceId: schedule.fromSpaceId,
                  toSpaceId: schedule.toSpaceId,
                  assetId: schedule.assetId,
                  amount: input.amount,
                  cadence: schedule.cadence,
                  startsAt: schedule.startsAt.toISOString(),
                  endsAt: input.endsAt ?? undefined,
                  revision: input.revision,
                }),
                input.stepUpApprovalId,
              );
            }
          }
          const updated = await bank.transfers.updateSchedule({
            scheduleId: input.scheduleId,
            userId: ctx.principal.userId,
            revision: input.revision,
            amount: parseAmount(input.amount),
            endsAt: input.endsAt === null ? null : new Date(input.endsAt),
          });
          return {
            id: updated.id,
            revision: updated.revision,
            amount: formatAmount(updated.amount),
            endsAt: updated.endsAt?.toISOString() ?? null,
            nextRunAt: updated.nextRunAt.toISOString(),
          };
        }),
      ),

    /** What actually ran, and why anything did not. The user's answer to "where is my rent". */
    executions: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          scheduleId: z.string().guid(),
          /**
           * Page size. Optional so omit reaches `bank.executions_list_limit_unset`
           * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
           */
          limit: z.number().int().min(1).max(200).optional(),
        }),
      )
      .output(
        z.array(
          z.object({
            occurrence: z.number().int(),
            amount: amountString,
            status: z.string(),
            ledgerTxId: z.string().nullable(),
            rejectionCode: z.string().nullable(),
          }),
        ),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          // `bank:read` answers "may this principal read bank data". It never
          // answered "whose", and without the next two lines this returned
          // another user's transfer history, amounts and rejection codes
          // included, to anyone holding the scope and a schedule id.
          const schedule = await bank.transfers.getSchedule(input.scheduleId);
          assertSelf(ctx.principal.userId, schedule.userId);
          return bank.transfers.executions(input.scheduleId, input.limit);
        }),
      ),

    cancel: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ scheduleId: z.string().guid() }))
      .output(z.object({ cancelled: z.literal(true) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          // The ownership check runs BEFORE the cancel, not as a filter on its
          // result: `cancelSchedule` is an UPDATE, and a check made afterwards
          // would refuse a caller whose write had already landed.
          const schedule = await bank.transfers.getSchedule(input.scheduleId);
          assertSelf(ctx.principal.userId, schedule.userId);
          await bank.transfers.cancelSchedule(input.scheduleId);
          return { cancelled: true as const };
        }),
      ),

    /**
     * Hold a standing order. The reversible half of `cancel`.
     *
     * Same ownership ordering as `cancel`, for the same reason written there.
     */
    pause: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ scheduleId: z.string().guid() }))
      .output(z.object({ status: z.string(), nextRunAt: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const schedule = await bank.transfers.getSchedule(input.scheduleId);
          assertSelf(ctx.principal.userId, schedule.userId);
          const paused = await bank.transfers.pauseSchedule(input.scheduleId);
          return { status: paused.status, nextRunAt: paused.nextRunAt.toISOString() };
        }),
      ),

    /**
     * Start a paused standing order again.
     *
     * `skipped` is in the OUTPUT, not just the record, because resuming does not
     * settle up. A client that renders `status: 'active'` and nothing else lets a
     * user believe the missed months are still coming; they are not, and the
     * moment to say so is the moment they ask for it. See `resumeSchedule` for
     * why skipping is the safe direction.
     */
    resume: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ scheduleId: z.string().guid() }))
      .output(
        z.object({
          status: z.string(),
          nextRunAt: z.string(),
          /** Occurrences that came due while paused and will never fire. */
          skipped: z.array(z.number().int()),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const schedule = await bank.transfers.getSchedule(input.scheduleId);
          assertSelf(ctx.principal.userId, schedule.userId);
          const report = await bank.transfers.resumeSchedule(input.scheduleId);
          return {
            status: report.schedule.status,
            nextRunAt: report.schedule.nextRunAt.toISOString(),
            skipped: [...report.skipped],
          };
        }),
      ),
  });
}
