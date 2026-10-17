import { z } from 'zod';
import { router, scopedProcedure, protectedProcedure, TRPCError } from '@intafaced/contracts';
import { MiningError } from './errors.js';
import { assertListLimit, assertWindowMinutes } from './list-limit.js';
import { readPoolTerms } from './pool-terms.js';
import type { MiningReadStore } from './reads.js';

const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
const money = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);

export type MiningReads = Pick<
  MiningReadStore,
  'myWorkers' | 'listWorkers' | 'myShares' | 'opsShares' | 'opsWindows' | 'pending' | 'myPayouts'
>;

function fail(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof MiningError) {
    const code = err.code === 'mining.cursor_invalid' || err.code === 'mining.share_range_invalid' ? 'BAD_REQUEST' : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: err.message, cause: err });
  }
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Request failed', cause: err });
}

const shareFilter = z.object({
  windowId: z.string().max(200).optional(),
  from: z.string().max(80).optional(),
  to: z.string().max(80).optional(),
});

const shareWindow = z.object({
  windowId: z.string(),
  acceptedCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  acceptedWeight: decimal.nullable(),
});

const shareReport = z.object({ asOf: z.string(), windows: z.array(shareWindow) });

function refusal(code: string, message: string): never {
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message, cause: new MiningError(message, code) });
}

/**
 * Signed reads for the customer Rewards room and the founder Mining desk.
 * Own-account procedures require `ledger:read`. Operator procedures require
 * `admin:read`. No `mining:*` scope is introduced here.
 */
export function createMiningRouter(reads: MiningReads, terms: () => ReturnType<typeof readPoolTerms> = () => readPoolTerms()) {
  const customer = scopedProcedure('ledger:read', { module: 'mining-pool' });
  const operator = scopedProcedure('admin:read', { module: 'mining-pool' });
  return router({
    workers: router({
      mine: customer
        .input(z.object({ windowMinutes: z.unknown().optional() }))
        .output(
          z.object({
            asOf: z.string(),
            windowMinutes: z.number().int(),
            workers: z.array(
              z
                .object({
                  id: z.string(),
                  name: z.string(),
                  createdAt: z.string(),
                  hashrate: decimal.nullable(),
                  hashrateReason: z.enum(['no_shares_in_window']).nullable(),
                })
                .refine((row) => (row.hashrate === null) !== (row.hashrateReason === null)),
            ),
          }),
        )
        .query(({ ctx, input }) => {
          try {
            const windowMinutes = assertWindowMinutes(input.windowMinutes);
            return reads.myWorkers(ctx.principal.userId, windowMinutes);
          } catch (err) {
            fail(err);
          }
        }),
      register: customer.mutation(() => {
        refusal('mining.worker_registration_scope_unset', 'Worker registration is refused until a write scope is chosen');
      }),
    }),
    ops: router({
      workers: operator
        .input(z.object({ limit: z.unknown().optional(), cursor: z.string().max(512).optional() }))
        .output(
          z.object({
            asOf: z.string(),
            workers: z.array(z.object({ id: z.string(), userId: z.string(), name: z.string(), createdAt: z.string() })),
            nextCursor: z.string().nullable(),
          }),
        )
        .query(({ input }) => {
          try {
            const limit = assertListLimit(input.limit, 'mining.workers_list_limit_unset');
            return reads.listWorkers(limit, input.cursor ?? null);
          } catch (err) {
            fail(err);
          }
        }),
      shares: operator
        .input(shareFilter)
        .output(shareReport)
        .query(({ input }) => {
          try {
            return reads.opsShares(input);
          } catch (err) {
            fail(err);
          }
        }),
      windows: operator
        .output(
          z.object({
            asOf: z.string(),
            windows: z.array(
              z.object({
                windowId: z.string(),
                assetId: z.string(),
                status: z.enum(['open', 'paid']),
                reward: money.nullable(),
                feeBps: z.number().int().nullable(),
                shareCount: z.number().int().nonnegative(),
                totalWeight: decimal.nullable(),
                paidAt: z.string().nullable(),
              }),
            ),
          }),
        )
        .query(() => {
          try {
            return reads.opsWindows();
          } catch (err) {
            fail(err);
          }
        }),
    }),
    shares: router({
      mine: customer
        .input(shareFilter)
        .output(shareReport)
        .query(({ ctx, input }) => {
          try {
            return reads.myShares(ctx.principal.userId, input);
          } catch (err) {
            fail(err);
          }
        }),
    }),
    windows: router({
      pending: customer
        .output(
          z.object({
            asOf: z.string(),
            windows: z.array(
              z.object({
                windowId: z.string(),
                assetId: z.string(),
                callerWeight: decimal,
                totalWeight: decimal.nullable(),
                reward: money.nullable(),
                feeBps: z.number().int().nullable(),
                estimate: z.object({ estimate: z.literal(true), estimatedGross: money }).nullable(),
              }),
            ),
          }),
        )
        .query(({ ctx }) => {
          try {
            return reads.pending(ctx.principal.userId);
          } catch (err) {
            fail(err);
          }
        }),
    }),
    payouts: router({
      mine: customer
        .input(z.object({ limit: z.unknown().optional(), cursor: z.string().max(512).optional() }))
        .output(
          z.object({
            asOf: z.string(),
            nextCursor: z.string().nullable(),
            payouts: z.array(
              z.object({
                windowId: z.string(),
                minerId: z.string(),
                assetId: z.string(),
                amount: money.nullable(),
                amountReason: z.string().nullable(),
                paidAt: z.string().nullable(),
                ledgerTransactionId: z.string().nullable(),
                ledgerReason: z.enum(['mining.ledger_unavailable', 'mining.ledger_tx_unrecorded']).nullable(),
              }),
            ),
          }),
        )
        .query(({ ctx, input }) => {
          try {
            const limit = assertListLimit(input.limit, 'mining.payouts_list_limit_unset');
            return reads.myPayouts(ctx.principal.userId, limit, input.cursor ?? null);
          } catch (err) {
            fail(err);
          }
        }),
    }),
    terms: protectedProcedure
      .output(
        z.object({
          feeBps: z.number().int().min(0).max(9999).nullable(),
          feeReason: z.enum(['fee_unconfigured']).nullable(),
          windowSize: z.number().int().positive().nullable(),
          windowSizeReason: z.enum(['window_size_unconfigured']).nullable(),
        }),
      )
      .query(() => terms()),
  });
}

export type MiningRouter = ReturnType<typeof createMiningRouter>;
