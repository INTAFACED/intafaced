import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { throwBankProcedure } from '../bank-procedure.js';
import { BankError } from '../errors.js';
import { ActivityCursorInvalidError } from './activity-cursor.js';
import { ACTIVITY_KINDS } from './activity-kind.js';
import {
  ACTIVITY_DEFAULT_LIMIT,
  ACTIVITY_MAX_LIMIT,
  ActivityLookupBoundedError,
  ActivityAccountUnknownError,
  ActivityNotFoundError,
  ActivityRangeError,
  ActivitySortBoundedError,
  ActivityTaxYearUnsetError,
  ActivityUnavailableError,
} from './activity-service.js';

/**
 * `bank.activity.list` (UI-SPEC U5b) — the signed-in user's merged money history.
 *
 * Self-only: the owner is `ctx.principal.userId`. There is no input that names a
 * user, an owner or a Space, and `.strict()` refuses a smuggled one instead of
 * stripping it. In its own file so `router.ts` carries one import and one mount line.
 */

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);

const plainWords = z.string().refine((value) => !/[\u0000-\u001F]/.test(value), 'text has a control character');

const activityListInput = z
  .object({
    limit: z.number().int().min(1).max(ACTIVITY_MAX_LIMIT).default(ACTIVITY_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(16_384).optional(),
    assetId: z.string().min(1).max(16).optional(),
    kind: z.array(z.enum(ACTIVITY_KINDS)).min(1).max(ACTIVITY_KINDS.length).optional(),
    direction: z.enum(['in', 'out']).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    q: z.string().trim().min(1).max(80).optional(),
    minAmount: amountString.optional(),
    maxAmount: amountString.optional(),
    /** Oldest first or newest first (the default). */
    sort: z.enum(['asc', 'desc']).optional(),
    /** `main` for the account itself, or the id of one named Space. */
    accountId: z.union([z.literal('main'), z.string().uuid()]).optional(),
    /** A UTC calendar year. */
    year: z.number().int().min(1970).max(2200).optional(),
    /** A tax year. Its start date is an owner value that is not set, so this refuses `portfolio.tax_year_start_unset`. */
    taxYear: z.number().int().min(1970).max(2200).optional(),
    /** Part of a withdrawal address. Lines with no recorded address never match. */
    address: z.string().trim().min(4).max(128).optional(),
  })
  .strict();

const activityItem = z.object({
  id: z.string(),
  kind: z.enum(ACTIVITY_KINDS),
  direction: z.enum(['in', 'out']),
  asset: z.string(),
  amount: amountString,
  postedAt: z.string().datetime(),
  txId: z.string(),
  counterparty: z.object({ handle: z.string() }).nullable(),
  spaceName: z.string().nullable(),
  /** Present only when the ledger links the line to the user's own trade order. Omitted otherwise. */
  orderId: z.string().min(1).max(128).optional(),
  /** True on the line that brought in an asset the customer bought. Omitted on every other line. */
  purchase: z.literal(true).optional(),
  /** Transfer note both parties can read. Omitted when the transfer had none. */
  note: z.string().min(1).max(140).optional(),
  /** Payment reference both parties can read. */
  reference: z.string().min(1).max(64).optional(),
  /** This caller's private note. */
  privateNote: z.string().max(500).optional(),
  dispute: z.object({ id: z.string().uuid(), status: z.literal('open'), reason: z.string().max(500) }).optional(),
  /** The crypto address a withdrawal went to, when one was recorded. Omitted on every other line. */
  address: z.string().min(1).max(256).optional(),
});

const activityListOutput = z.object({ items: z.array(activityItem), nextCursor: z.string().nullable() });

function activityFailure(err: unknown): never {
  if (err instanceof ActivityCursorInvalidError || err instanceof ActivityRangeError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  if (err instanceof ActivityTaxYearUnsetError || err instanceof ActivitySortBoundedError) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `${err.message} (${err.code})`, cause: err });
  }
  if (err instanceof ActivityAccountUnknownError)
    throw new TRPCError({ code: 'NOT_FOUND', message: `${err.message} (${err.code})`, cause: err });
  if (err instanceof ActivityNotFoundError) throw new TRPCError({ code: 'NOT_FOUND', message: `${err.message} (${err.code})`, cause: err });
  if (err instanceof ActivityLookupBoundedError) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `${err.message} (${err.code})`, cause: err });
  }
  if (err instanceof ActivityUnavailableError) {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Activity is not available right now. Try again in a minute.',
      cause: err,
    });
  }
  if (err instanceof BankError) throwBankProcedure(err);
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong. Please try again.', cause: err });
}

const activityDetail = z.object({
  item: activityItem,
  lines: z.array(activityItem),
  complete: z.boolean(),
  /** Where the history of the asset bought in this activity is: `/coin/<asset>`. Null unless a trade line brought that asset in. */
  assetPage: z.string().nullable(),
});

/**
 * The asset page for a purchase: the asset the first purchase line brought in. A sale, a futures settlement and an
 * escrow refund carry no purchase line, so they have no page to link to.
 */
export function assetPageOf(lines: ReadonlyArray<{ purchase?: true; asset: string }>): string | null {
  const bought = lines.find((line) => line.purchase === true);
  return bought && /^[A-Za-z0-9_-]{1,16}$/.test(bought.asset) ? `/coin/${encodeURIComponent(bought.asset)}` : null;
}

export function createActivityRouter(bank: Pick<BankServices, 'activity' | 'activityRecords'>) {
  return router({
    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(activityListInput)
      .output(activityListOutput)
      .query(async ({ ctx, input }) => {
        try {
          return await bank.activity.list(ctx.principal.userId, input);
        } catch (err) {
          activityFailure(err);
        }
      }),

    /**
     * One line, plus the other lines of the same ledger transaction.
     * `order:<orderId>` returns the lines the ledger links to that order.
     */
    get: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ id: z.string().min(1).max(512) }).strict())
      .output(activityDetail)
      .query(async ({ ctx, input }) => {
        try {
          const found = await bank.activity.get(ctx.principal.userId, input.id);
          return { ...found, assetPage: assetPageOf(found.lines.length > 0 ? found.lines : [found.item]) };
        } catch (err) {
          activityFailure(err);
        }
      }),

    note: router({
      set: scopedProcedure('bank:write', { module: 'bank' })
        .input(
          z
            .object({
              id: z.string().min(1).max(512),
              text: plainWords.pipe(z.string().min(1).max(500)),
              commandId: z.string().min(8).max(64),
            })
            .strict(),
        )
        .output(z.object({ activityId: z.string(), text: z.string(), updatedAt: z.string().datetime() }))
        .mutation(async ({ ctx, input }) => {
          try {
            if (input.id.startsWith('order:')) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'A note is attached to one activity line (bank.activity_line_required)',
              });
            }
            await bank.activity.get(ctx.principal.userId, input.id);
            return await bank.activityRecords.setNote(ctx.principal.userId, {
              activityId: input.id,
              text: input.text,
              commandId: input.commandId,
            });
          } catch (err) {
            activityFailure(err);
          }
        }),
    }),

    dispute: router({
      open: scopedProcedure('bank:write', { module: 'bank' })
        .input(
          z
            .object({
              id: z.string().min(1).max(512),
              reason: plainWords.pipe(z.string().min(1).max(500)),
              disputeId: z.string().uuid(),
            })
            .strict(),
        )
        .output(
          z.object({
            disputeId: z.string().uuid(),
            activityId: z.string(),
            status: z.literal('open'),
            reason: z.string(),
            createdAt: z.string().datetime(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            if (input.id.startsWith('order:')) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'A dispute is opened on one activity line (bank.activity_line_required)',
              });
            }
            await bank.activity.get(ctx.principal.userId, input.id);
            return await bank.activityRecords.openDispute(ctx.principal.userId, {
              activityId: input.id,
              reason: input.reason,
              disputeId: input.disputeId,
            });
          } catch (err) {
            activityFailure(err);
          }
        }),
    }),
  });
}
