import { z } from 'zod';
import { checkAccess, type KycTier } from '@intafaced/config';
import { JurisdictionError, router, scopedProcedure, protectedProcedure, TRPCError } from '@intafaced/contracts';
import { CREDENTIAL_NOT_ISSUED, readPoolConnection } from './connection.js';
import { publishedDifficulty } from './env.js';
import { MiningError } from './errors.js';
import { assertListLimit, assertWindowMinutes } from './list-limit.js';
import { readPoolOverview } from './overview.js';
import { readPoolTerms } from './pool-terms.js';
import { dialPool, ProbeRateLimit, runProbe, type Dial } from './probe.js';
import type { MiningReadStore } from './reads.js';

const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
const money = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);

export type MiningReads = Pick<
  MiningReadStore,
  'myWorkers' | 'setWorkerDifficulty' | 'listWorkers' | 'myShares' | 'opsShares' | 'opsWindows' | 'pending' | 'myPayouts'
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

/** mining-pool on the fiat plane. Same `checkAccess` arguments as `workers.mine`, and no extra scope. */
function refuseMiningPool(ctx: { readonly region: string; readonly principal: { readonly tier: KycTier } }): void {
  const decision = checkAccess({
    module: 'mining-pool',
    plane: 'fiat',
    region: ctx.region,
    kycTier: ctx.principal.tier,
  });
  if (!decision.allowed) {
    throw new TRPCError({ code: 'FORBIDDEN', message: decision.reason, cause: new JurisdictionError(decision) });
  }
}

export type MiningPublishDeps = {
  /** When set, readers use this map instead of `process.env` (tests). */
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly dial?: Dial;
  readonly limiter?: ProbeRateLimit;
};

/**
 * Signed reads for the customer Mining room and the founder Mining desk.
 * Own-account procedures require `ledger:read`. Operator procedures require
 * `admin:read`. Overview, connection and the reachability probe are signed-in
 * reads with no extra scope. After authentication they run the same mining-pool
 * fiat `checkAccess` as `workers.mine`, and refuse that decision before reading
 * or dialing. No `mining:*` scope is introduced here.
 */
export function createMiningRouter(
  reads: MiningReads,
  terms: () => ReturnType<typeof readPoolTerms> = () => readPoolTerms(),
  publish: MiningPublishDeps = {},
) {
  const customer = scopedProcedure('ledger:read', { module: 'mining-pool' });
  const operator = scopedProcedure('admin:read', { module: 'mining-pool' });
  // A rig setting is the account's own trading-side write; a read-only key cannot change it.
  const rigWriter = scopedProcedure('trade:write', { module: 'mining-pool' });
  const envOf = () => publish.env ?? process.env;
  const now = publish.now ?? Date.now;
  const dial = publish.dial ?? dialPool;
  const limiter = publish.limiter ?? new ProbeRateLimit();
  const signed = protectedProcedure.use(({ ctx, next }) => {
    refuseMiningPool(ctx);
    return next({ ctx });
  });
  return router({
    workers: router({
      mine: customer
        .input(
          z.object({
            windowMinutes: z.unknown().optional(),
            limit: z.unknown().optional(),
            cursor: z.string().max(512).optional(),
            name: z.string().max(64).optional(),
          }),
        )
        .output(
          z.object({
            asOf: z.string(),
            windowMinutes: z.number().int(),
            defaultDifficulty: decimal.nullable(),
            defaultDifficultyReason: z.enum(['mining.default_difficulty_unset', 'mining.default_difficulty_invalid']).nullable(),
            nextCursor: z.string().nullable(),
            workers: z.array(
              z
                .object({
                  id: z.string(),
                  name: z.string(),
                  createdAt: z.string(),
                  hashrate: decimal.nullable(),
                  hashrateReason: z.enum(['no_shares_in_window']).nullable(),
                  minDifficulty: decimal.nullable(),
                })
                .refine((row) => (row.hashrate === null) !== (row.hashrateReason === null)),
            ),
          }),
        )
        .query(async ({ ctx, input }) => {
          try {
            const windowMinutes = assertWindowMinutes(input.windowMinutes);
            const limit = input.limit === undefined ? undefined : assertListLimit(input.limit, 'mining.workers_list_limit_unset');
            const query = {
              ...(limit === undefined ? {} : { limit }),
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
              ...(input.name === undefined ? {} : { name: input.name }),
            };
            const roster = await reads.myWorkers(ctx.principal.userId, windowMinutes, query);
            const fallback = publishedDifficulty(envOf().MINING_DEFAULT_DIFFICULTY);
            return {
              ...roster,
              defaultDifficulty: fallback === null || fallback === 'invalid' ? null : fallback,
              defaultDifficultyReason:
                fallback === null
                  ? ('mining.default_difficulty_unset' as const)
                  : fallback === 'invalid'
                    ? ('mining.default_difficulty_invalid' as const)
                    : null,
            };
          } catch (err) {
            fail(err);
          }
        }),
      /**
       * The account's own minimum difficulty for one of its workers; null is automatic. Only a worker the caller's shares
       * created can be changed, and nothing here touches a share, a window or a payout.
       */
      setDifficulty: rigWriter
        .input(
          z.object({
            workerId: z.string().min(1).max(200),
            minDifficulty: z
              .string()
              .regex(/^[1-9]\d{0,37}$/)
              .nullable(),
          }),
        )
        .output(z.object({ id: z.string(), minDifficulty: decimal.nullable() }))
        .mutation(async ({ ctx, input }) => {
          try {
            return await reads.setWorkerDifficulty(
              ctx.principal.userId,
              input.workerId,
              input.minDifficulty === null ? null : BigInt(input.minDifficulty),
            );
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
    overview: signed
      .output(
        z.object({
          version: z.string().min(1),
          what: z.string().nullable(),
          coin: z.string().nullable(),
          hardware: z.string().nullable(),
          revenueSplit: z.string().nullable(),
          notSupported: z.string().nullable(),
        }),
      )
      .query(() => {
        try {
          return readPoolOverview(envOf());
        } catch (err) {
          fail(err);
        }
      }),
    connection: signed
      .output(
        z.object({
          host: z.string().min(1),
          port: z.string().regex(/^[1-9]\d{0,4}$/),
          secureUrl: z.string().nullable(),
          accountId: z.string().min(1),
          workerNamePattern: z.string().nullable(),
          credentialOffered: z.literal(false),
          credentialReason: z.literal(CREDENTIAL_NOT_ISSUED),
        }),
      )
      .query(({ ctx }) => {
        try {
          return readPoolConnection(envOf(), ctx.principal.userId);
        } catch (err) {
          fail(err);
        }
      }),
    probe: signed
      .output(
        z.object({
          result: z.enum(['reachable', 'refused', 'timed_out']),
          roundTripMs: z.string().regex(/^(0|[1-9]\d*)$/),
          viewpoint: z.literal('pool_network'),
        }),
      )
      .query(async ({ ctx }) => {
        try {
          return await runProbe({ env: envOf(), userId: ctx.principal.userId, nowMs: now(), limiter, dial });
        } catch (err) {
          fail(err);
        }
      }),
  });
}

export type MiningRouter = ReturnType<typeof createMiningRouter>;
