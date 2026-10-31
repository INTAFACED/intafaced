import { z } from 'zod';
import { checkAccess, type KycTier } from '@intafaced/config';
import { JurisdictionError, router, scopedProcedure, protectedProcedure, TRPCError } from '@intafaced/contracts';
import { readPoolConnection } from './connection.js';
import { DIFFICULTY, publishedDifficulty } from './env.js';
import { EMISSION_UNPUBLISHED, WORKER_NAME } from './window-store.js';
import { MiningError } from './errors.js';
import { assertListLimit, assertWindowMinutes } from './list-limit.js';
import { readPoolOverview } from './overview.js';
import { readPoolTerms } from './pool-terms.js';
import { dialPool, ProbeRateLimit, runProbe, type Dial } from './probe.js';
import { POW_SPEC_UNSET, publishedPowSpec } from './pow.js';
import type { MiningReadStore } from './reads.js';
import {
  ALERT_LIMIT,
  ALERT_LIMIT_INVALID,
  ALERT_LIMIT_UNSET,
  alertShareBpsOf,
  alertTrailingMinutesOf,
  MAINTENANCE_BATCH_MAX,
  quietSecondsOf,
  QUIET_INTERVAL_INVALID,
  QUIET_INTERVAL_UNSET,
} from './worker-state.js';

const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
const money = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);

export type MiningReads = Pick<
  MiningReadStore,
  | 'myWorkers'
  | 'setWorkerDifficulty'
  | 'setWorkerMode'
  | 'listWorkers'
  | 'myShares'
  | 'opsShares'
  | 'opsWindows'
  | 'pending'
  | 'myPayouts'
  | 'minerSecretStatus'
  | 'issueMinerSecret'
  | 'workerOne'
  | 'workerStateChanges'
  | 'setWorkerMaintenance'
  | 'workerMaintenance'
  | 'setWorkerAlertLimit'
  | 'workerRosterStates'
>;

const BAD_INPUT = new Set(['mining.cursor_invalid', 'mining.share_range_invalid', ALERT_LIMIT_INVALID, 'mining.maintenance_batch_invalid']);
const WORKER_ID = z.string().min(1).max(200);
const connectivity = z.enum(['online', 'offline']);
const workerState = z.enum(['active', 'offline', 'maintenance']);
const maintenanceRows = z.object({ asOf: z.string(), rows: z.array(z.object({ workerId: z.string(), since: z.string() })) });

function fail(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof MiningError) {
    const code = BAD_INPUT.has(err.code) ? 'BAD_REQUEST' : 'PRECONDITION_FAILED';
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
  soloCount: z.number().int().nonnegative(),
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
                  mode: z.enum(['pooled', 'solo']),
                  state: workerState.nullable(),
                  stateReason: z.enum([QUIET_INTERVAL_UNSET, QUIET_INTERVAL_INVALID]).nullable(),
                })
                .refine((row) => (row.hashrate === null) !== (row.hashrateReason === null))
                // A reason names a blank or bad quiet interval, so it comes only with no state.
                .refine((row) => row.stateReason === null || row.state === null),
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
            // The badge: maintenance always; active or offline only when the owner published a quiet interval.
            const quiet = quietSecondsOf(envOf());
            const states = await reads.workerRosterStates(
              ctx.principal.userId,
              roster.workers.map((worker) => worker.id),
              typeof quiet === 'number' ? quiet : null,
            );
            return {
              ...roster,
              workers: roster.workers.map((worker) => {
                const state = states.get(worker.id)?.state ?? null;
                // The unset or invalid code only when the interval really is; a worker the badge read did not see has
                // no state and no false reason.
                return { ...worker, state, stateReason: state === null && typeof quiet !== 'number' ? quiet : null };
              }),
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
            minDifficulty: z.string().regex(DIFFICULTY).nullable(),
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
      /**
       * Pooled or solo for one of the caller's own rigs, by name. Saving the same mode again changes nothing; a change while
       * the rig has shares in an open window refuses `mining.mode_change_in_window`. Solo work never joins the PPLNS window.
       */
      setMode: rigWriter
        .input(z.object({ name: z.string().regex(WORKER_NAME), mode: z.enum(['pooled', 'solo']) }))
        .output(z.object({ id: z.string(), name: z.string(), mode: z.enum(['pooled', 'solo']) }))
        .mutation(async ({ ctx, input }) => {
          try {
            return await reads.setWorkerMode(ctx.principal.userId, input.name, input.mode);
          } catch (err) {
            fail(err);
          }
        }),
      /**
       * One of the caller's own workers (another account's is `mining.worker_not_found`): hashing (an accepted share in
       * the window), connectivity (online while the newest accepted share is younger than `MINING_WORKER_QUIET_SECONDS`),
       * its state (maintenance, else offline when quiet, else active) and its alert limit. A blank quiet interval refuses
       * `mining.quiet_interval_unset`. The read writes nothing: only the evaluator records an online/offline change, at its
       * next pass, and nothing is recorded while it is off. An automatic alert limit is a share of the worker's weight over
       * the owner's fixed trailing period (`MINING_WORKER_ALERT_TRAILING_MINUTES`), never this read's window.
       */
      one: customer
        .input(z.object({ workerId: WORKER_ID, windowMinutes: z.unknown().optional() }))
        .output(
          z
            .object({
              asOf: z.string(),
              id: z.string(),
              name: z.string(),
              windowMinutes: z.number().int(),
              hashing: z.enum(['hashing', 'idle']),
              hashrate: decimal.nullable(),
              hashrateReason: z.enum(['no_shares_in_window']).nullable(),
              connectivity,
              lastShareAt: z.string().nullable(),
              state: workerState,
              quietSeconds: z.number().int().positive(),
              alertLimitMode: z.enum(['automatic', 'manual']).nullable(),
              alertLimit: z
                .string()
                .regex(/^(0|[1-9]\d*)(\.\d+)?$/)
                .nullable(),
              alertLimitReason: z.enum([ALERT_LIMIT_UNSET, 'no_shares_in_window']).nullable(),
              maintenanceSince: z.string().nullable(),
            })
            .refine((row) => (row.alertLimit === null) !== (row.alertLimitReason === null)),
        )
        .query(async ({ ctx, input }) => {
          try {
            const windowMinutes = assertWindowMinutes(input.windowMinutes);
            const quiet = quietSecondsOf(envOf());
            if (typeof quiet !== 'number') refusal(quiet, 'The pool has no published quiet interval');
            return await reads.workerOne(ctx.principal.userId, input.workerId, windowMinutes, {
              quietSeconds: quiet,
              alertShareBps: alertShareBpsOf(envOf()),
              alertTrailingMinutes: alertTrailingMinutesOf(envOf()),
            });
          } catch (err) {
            fail(err);
          }
        }),
      /** The recorded online/offline changes of one of the caller's own workers, newest first, and the evaluator's last look. */
      stateChanges: customer
        .input(z.object({ workerId: WORKER_ID }))
        .output(
          z.object({
            asOf: z.string(),
            evaluatedAt: z.string().nullable(),
            rows: z.array(z.object({ workerId: z.string(), from: connectivity, to: connectivity, at: z.string() })),
          }),
        )
        .query(async ({ ctx, input }) => {
          try {
            return await reads.workerStateChanges(ctx.principal.userId, input.workerId);
          } catch (err) {
            fail(err);
          }
        }),
      /**
       * Puts 1 to 50 of the caller's own workers in maintenance, or takes them out. Any id that is not the caller's refuses
       * the whole call (`mining.worker_not_found`). One row per worker; asking again keeps the first `since`. A worker in
       * maintenance gets no offline row.
       */
      setMaintenance: rigWriter
        .input(z.object({ workerIds: z.array(WORKER_ID).min(1).max(MAINTENANCE_BATCH_MAX), on: z.boolean() }))
        .output(maintenanceRows)
        .mutation(async ({ ctx, input }) => {
          try {
            return await reads.setWorkerMaintenance(ctx.principal.userId, input.workerIds, input.on);
          } catch (err) {
            fail(err);
          }
        }),
      maintenance: customer.output(maintenanceRows).query(async ({ ctx }) => {
        try {
          return await reads.workerMaintenance(ctx.principal.userId);
        } catch (err) {
          fail(err);
        }
      }),
      /**
       * The account's own alert limit for one of its workers: `automatic` (the owner's published share of the worker's
       * accepted weight over the owner's trailing period), `manual` with a value above zero, or null to clear the choice. Neither is a default.
       */
      setAlertLimit: rigWriter
        .input(
          z.object({
            workerId: WORKER_ID,
            mode: z.enum(['automatic', 'manual']).nullable(),
            limit: z.string().regex(ALERT_LIMIT).nullable().optional(),
          }),
        )
        .output(z.object({ workerId: z.string(), mode: z.enum(['automatic', 'manual']).nullable(), manualLimit: decimal.nullable() }))
        .mutation(async ({ ctx, input }) => {
          try {
            return await reads.setWorkerAlertLimit(ctx.principal.userId, input.workerId, input.mode, input.limit ?? null);
          } catch (err) {
            fail(err);
          }
        }),
      /**
       * A solo rig's credit: refused with the same code the payout job gives a window of solo work, since solo credit
       * waits for the token's published reward source as pooled credit does.
       */
      soloCredit: customer.query(() => {
        refusal(EMISSION_UNPUBLISHED, 'Solo credit waits for the published reward source');
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
                status: z.enum(['open', 'paid', 'no_credit']),
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
    /**
     * The caller's own miner secret, which the miner door asks for on `mining.authorize`. `status` says when the current
     * one was issued (never the secret). `issue` makes a new one, replacing the old, and returns it this once; only its
     * SHA-256 is kept. Issuing is a rig setting, so it needs `trade:write` as `workers.setMode` does.
     */
    minerSecret: router({
      status: customer.output(z.object({ issuedAt: z.string().nullable() })).query(async ({ ctx }) => {
        try {
          return await reads.minerSecretStatus(ctx.principal.userId);
        } catch (err) {
          fail(err);
        }
      }),
      issue: rigWriter.output(z.object({ secret: z.string(), issuedAt: z.string() })).mutation(async ({ ctx }) => {
        try {
          return await reads.issueMinerSecret(ctx.principal.userId);
        } catch (err) {
          fail(err);
        }
      }),
    }),
    connection: signed
      .output(
        z.object({
          host: z.string().min(1),
          port: z.string().regex(/^[1-9]\d{0,4}$/),
          secureUrl: z.string().nullable(),
          accountId: z.string().min(1),
          workerNamePattern: z.string().nullable(),
        }),
      )
      .query(({ ctx }) => {
        try {
          return readPoolConnection(envOf(), ctx.principal.userId);
        } catch (err) {
          fail(err);
        }
      }),
    /**
     * The pool's proof-of-work parameters as published: a TEST testnet set, or blank (`mining.pow_spec_unset`). A mainnet
     * set is never served (`audit.external`).
     */
    pow: signed
      .output(
        z.discriminatedUnion('status', [
          z.object({
            status: z.literal('published'),
            dimension: z.number().int(),
            targetBits: z.number().int(),
            testnet: z.literal(true),
          }),
          z.object({ status: z.literal('unset'), code: z.literal(POW_SPEC_UNSET) }),
        ]),
      )
      .query(() => {
        try {
          const spec = publishedPowSpec(envOf());
          if (spec === null) return { status: 'unset' as const, code: POW_SPEC_UNSET };
          return { status: 'published' as const, dimension: spec.dimension, targetBits: spec.targetBits, testnet: spec.testnet };
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
