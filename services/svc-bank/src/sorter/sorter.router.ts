import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { formatAmount } from '@intafaced/ledger-client';
import type { BankServices } from '../bank-service.js';
import { SORTER_MAX_LEGS, type IncomeSorter, type ListedSorter, type SorterRun } from './income-sorter.js';

/**
 * `bank.sorter.*` (BK-pots-03, J-bank-07 #4): the income sorter. A payment from another person is split across the
 * person's own named spaces by percentage, once; the rest stays in the account. Reading is `bank:read`; making and
 * cancelling are `bank:write`. While the owner has published no terms, the read says so and making one refuses
 * `bank.sorter_terms_unset`.
 */

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);

const sorterView = z.object({
  id: z.string(),
  assetId: z.string(),
  status: z.enum(['active', 'cancelled']),
  legs: z.array(z.object({ spaceId: z.string(), shareBp: z.number().int() })),
  createdAt: z.string(),
  cancelledAt: z.string().nullable(),
});

/** A live sorter on the list: each leg names its space and says whether it was archived since (its share then stays). */
const listedView = sorterView.extend({
  legs: z.array(z.object({ spaceId: z.string(), shareBp: z.number().int(), spaceName: z.string(), archived: z.boolean() })),
});

const runView = z.object({
  id: z.string(),
  creditTransferId: z.string(),
  creditTxId: z.string(),
  creditAmount: amountString,
  /** When the payment posted; `createdAt` is when it was sorted. */
  creditPostedAt: z.string(),
  /** Recorded and not split: under the bank's smallest sorted payment, or no terms stood. */
  skippedReason: z.enum(['below_minimum', 'terms_unset']).nullable(),
  createdAt: z.string(),
  legs: z.array(
    z.object({
      position: z.number().int(),
      spaceId: z.string(),
      amount: amountString,
      status: z.enum(['pending', 'settled', 'rejected']),
      ledgerTxId: z.string().nullable(),
      rejectionCode: z.string().nullable(),
    }),
  ),
});

const viewOf = (sorter: IncomeSorter) => ({
  id: sorter.id,
  assetId: sorter.assetId,
  status: sorter.status,
  legs: sorter.legs,
  createdAt: sorter.createdAt.toISOString(),
  cancelledAt: sorter.cancelledAt?.toISOString() ?? null,
});

const listedOf = (sorter: ListedSorter) => ({
  ...viewOf(sorter),
  legs: sorter.legs.map((leg) => ({
    ...leg,
    spaceName: sorter.spaces[leg.spaceId]?.name ?? '',
    archived: sorter.spaces[leg.spaceId]?.archived ?? false,
  })),
});

const runOf = (run: SorterRun) => ({
  id: run.id,
  creditTransferId: run.creditTransferId,
  creditTxId: run.creditTxId,
  creditAmount: formatAmount(run.creditAmount),
  creditPostedAt: run.creditPostedAt.toISOString(),
  skippedReason: run.skippedReason,
  createdAt: run.createdAt.toISOString(),
  legs: run.legs.map((leg) => ({
    position: leg.position,
    spaceId: leg.spaceId,
    amount: formatAmount(leg.amount),
    status: leg.status,
    ledgerTxId: leg.ledgerTxId,
    rejectionCode: leg.rejectionCode,
  })),
});

export function createSorterRouter(bank: BankServices, guard: Guard) {
  return router({
    /** The bank's terms for sorting, and the caller's live sorters (one per asset at most). */
    list: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z.object({
          terms: z.discriminatedUnion('state', [
            z.object({ state: z.literal('set'), minCredit: amountString }),
            z.object({ state: z.literal('not_set'), code: z.literal('bank.sorter_terms_unset') }),
          ]),
          sorters: z.array(listedView),
        }),
      )
      .query(({ ctx }) =>
        guard(async () => {
          const min = bank.sorter.minimumCredit();
          return {
            terms:
              min === null
                ? { state: 'not_set' as const, code: 'bank.sorter_terms_unset' as const }
                : { state: 'set' as const, minCredit: formatAmount(min) },
            sorters: (await bank.sorter.list(ctx.principal.userId)).map(listedOf),
          };
        }),
      ),

    /** What each sorted credit came to under one of the caller's sorters, newest first. */
    runs: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ sorterId: z.string().guid(), limit: z.number().int().min(1).max(50) }).strict())
      .output(z.array(runView))
      .query(({ ctx, input }) => guard(async () => (await bank.sorter.runs(ctx.principal.userId, input.sorterId, input.limit)).map(runOf))),

    /**
     * Make the sorter for one asset. `sorterId` is the client's request id, so a retry is the same sorter. Shares are
     * whole basis points; over 10000 in all refuses `bank.sorter_invalid`.
     */
    create: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            sorterId: z.string().guid(),
            assetId: z.string().trim().min(1).max(16),
            legs: z
              .array(z.object({ spaceId: z.string().guid(), shareBp: z.number().int() }).strict())
              .min(1)
              .max(SORTER_MAX_LEGS),
          })
          .strict(),
      )
      .output(sorterView)
      .mutation(({ ctx, input }) =>
        guard(async () =>
          viewOf(
            await bank.sorter.create({
              userId: ctx.principal.userId,
              sorterId: input.sorterId,
              assetId: input.assetId,
              legs: input.legs,
            }),
          ),
        ),
      ),

    /** Stop sorting. Credits already sorted stay where they went. */
    cancel: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ sorterId: z.string().guid() }).strict())
      .output(sorterView)
      .mutation(({ ctx, input }) => guard(async () => viewOf(await bank.sorter.cancel(ctx.principal.userId, input.sorterId)))),
  });
}
