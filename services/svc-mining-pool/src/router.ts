import { TRPCError } from '@trpc/server';
import type { Context } from '@intafaced/contracts';
import { mountRecords, type RefusalOf } from '@intafaced/contracts/procedure-mount';
import { MINING_PROCEDURES } from '@intafaced/contracts/mining-procedures';
import { readPoolConnection } from './connection.js';
import { publishedDifficulty } from './env.js';
import { EMISSION_UNPUBLISHED } from './window-store.js';
import { MiningError } from './errors.js';
import { assertListLimit, assertWindowMinutes } from './list-limit.js';
import { readPoolOverview } from './overview.js';
import { readPoolTerms } from './pool-terms.js';
import { dialPool, ProbeRateLimit, runProbe, type Dial } from './probe.js';
import { POW_SPEC_UNSET, publishedPowSpec } from './pow.js';
import type { MiningReadStore } from './reads.js';

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
>;

export type MiningPublishDeps = {
  /** When set, readers use this map instead of `process.env` (tests). */
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly dial?: Dial;
  readonly limiter?: ProbeRateLimit;
};

/**
 * svc-mining-pool's one refusal reader, in its wire form. A `MiningError` leaves as PRECONDITION_FAILED (a bad cursor or
 * share range as BAD_REQUEST) with its own message; anything else unknown as `Request failed`. A TRPCError a handler already
 * shaped passes as it is.
 */
const miningRefusal: RefusalOf = (err) => {
  if (err instanceof TRPCError) return undefined;
  if (err instanceof MiningError) {
    const code = err.code === 'mining.cursor_invalid' || err.code === 'mining.share_range_invalid' ? 'BAD_REQUEST' : 'PRECONDITION_FAILED';
    return { code: err.code, error: new TRPCError({ code, message: err.message, cause: err }) };
  }
  return { code: 'mining.request_failed', error: new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Request failed', cause: err }) };
};

/**
 * The reads that handed back the store's promise without awaiting it never mapped what the store refused: whatever it
 * rejects with is sent as INTERNAL_SERVER_ERROR with its own message, as tRPC sends an unknown error. Kept as it is, bug
 * included, so the wire does not move with the mount. A check before the store (a list limit) still refuses by name.
 */
const unmapped = async <T>(read: () => Promise<T>): Promise<T> => {
  const pending = read(); // a check that throws before the store (a list limit) still refuses by name
  try {
    return await pending;
  } catch (err) {
    if (err instanceof TRPCError) throw err;
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: err });
  }
};

function refusal(code: string, message: string): never {
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message, cause: new MiningError(message, code) });
}

/** The signed caller. Every record here is guarded, so the guard has already refused a call without one. */
function userOf({ principal }: Context): string {
  if (!principal) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
  return principal.userId;
}

/**
 * Signed reads for the customer Mining room and the founder Mining desk, mounted from their records
 * (`@intafaced/contracts/mining-procedures`): this file holds only the handlers. Own-account calls need `ledger:read`, rig
 * settings `trade:write`, operator reads `admin:read`; overview, connection, proof of work and the reachability probe are
 * signed-in reads with no extra scope, behind the same mining-pool fiat jurisdiction check. `terms` is signed-in only.
 */
export function createMiningRouter(
  reads: MiningReads,
  terms: () => ReturnType<typeof readPoolTerms> = () => readPoolTerms(),
  publish: MiningPublishDeps = {},
) {
  const envOf = () => publish.env ?? process.env;
  const now = publish.now ?? Date.now;
  const dial = publish.dial ?? dialPool;
  const limiter = publish.limiter ?? new ProbeRateLimit();
  return mountRecords(
    MINING_PROCEDURES,
    {
      'mining.workers.mine': async ({ ctx, input }) => {
        const windowMinutes = assertWindowMinutes(input.windowMinutes);
        const limit = input.limit === undefined ? undefined : assertListLimit(input.limit, 'mining.workers_list_limit_unset');
        const query = {
          ...(limit === undefined ? {} : { limit }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.name === undefined ? {} : { name: input.name }),
        };
        const roster = await reads.myWorkers(userOf(ctx), windowMinutes, query);
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
      },
      /** Only a worker the caller's shares created can be changed; nothing here touches a share, a window or a payout. */
      'mining.workers.setDifficulty': ({ ctx, input }) =>
        reads.setWorkerDifficulty(userOf(ctx), input.workerId, input.minDifficulty === null ? null : BigInt(input.minDifficulty)),
      /** Saving the same mode again changes nothing; a change while the rig has shares in an open window refuses. */
      'mining.workers.setMode': ({ ctx, input }) => reads.setWorkerMode(userOf(ctx), input.name, input.mode),
      'mining.workers.soloCredit': () => refusal(EMISSION_UNPUBLISHED, 'Solo credit waits for the published reward source'),
      'mining.ops.workers': ({ input }) =>
        unmapped(() => reads.listWorkers(assertListLimit(input.limit, 'mining.workers_list_limit_unset'), input.cursor ?? null)),
      'mining.ops.shares': ({ input }) => unmapped(() => reads.opsShares(input)),
      'mining.ops.windows': () => unmapped(() => reads.opsWindows()),
      'mining.shares.mine': ({ ctx, input }) => unmapped(() => reads.myShares(userOf(ctx), input)),
      'mining.windows.pending': ({ ctx }) => unmapped(() => reads.pending(userOf(ctx))),
      'mining.payouts.mine': ({ ctx, input }) =>
        unmapped(() => reads.myPayouts(userOf(ctx), assertListLimit(input.limit, 'mining.payouts_list_limit_unset'), input.cursor ?? null)),
      // `terms` never mapped its errors at all.
      'mining.terms': () => unmapped(async () => terms()),
      'mining.overview': () => readPoolOverview(envOf()),
      'mining.minerSecret.status': ({ ctx }) => reads.minerSecretStatus(userOf(ctx)),
      'mining.minerSecret.issue': ({ ctx }) => reads.issueMinerSecret(userOf(ctx)),
      'mining.connection': ({ ctx }) => readPoolConnection(envOf(), userOf(ctx)),
      'mining.pow': () => {
        const spec = publishedPowSpec(envOf());
        if (spec === null) return { status: 'unset' as const, code: POW_SPEC_UNSET };
        return { status: 'published' as const, dimension: spec.dimension, targetBits: spec.targetBits, testnet: spec.testnet };
      },
      'mining.probe': ({ ctx }) => runProbe({ env: envOf(), userId: userOf(ctx), nowMs: now(), limiter, dial }),
    },
    miningRefusal,
  );
}

export type MiningRouter = ReturnType<typeof createMiningRouter>;
