import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { ActivityCursorInvalidError } from './activity-cursor.js';
import { ACTIVITY_KINDS } from './activity-kind.js';
import { ACTIVITY_DEFAULT_LIMIT, ACTIVITY_MAX_LIMIT, ActivityUnavailableError } from './activity-service.js';

/**
 * `bank.activity.list` (UI-SPEC U5b) — the signed-in user's merged money history.
 *
 * Self-only: the owner is `ctx.principal.userId`. There is no input that names a
 * user, an owner or a Space, and `.strict()` refuses a smuggled one instead of
 * stripping it. In its own file so `router.ts` carries one import and one mount line.
 */

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);

const activityListInput = z
  .object({
    limit: z.number().int().min(1).max(ACTIVITY_MAX_LIMIT).default(ACTIVITY_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(16_384).optional(),
    assetId: z.string().min(1).max(16).optional(),
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
});

const activityListOutput = z.object({ items: z.array(activityItem), nextCursor: z.string().nullable() });

export function createActivityRouter(bank: Pick<BankServices, 'activity'>) {
  return router({
    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(activityListInput)
      .output(activityListOutput)
      .query(async ({ ctx, input }) => {
        try {
          return await bank.activity.list(ctx.principal.userId, input);
        } catch (err) {
          if (err instanceof ActivityCursorInvalidError) throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
          if (err instanceof ActivityUnavailableError) {
            throw new TRPCError({
              code: 'SERVICE_UNAVAILABLE',
              message: 'Activity is not available right now. Try again in a minute.',
              cause: err,
            });
          }
          // Not ours to describe: nothing from the book or the database reaches the caller.
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong. Please try again.', cause: err });
        }
      }),
  });
}
