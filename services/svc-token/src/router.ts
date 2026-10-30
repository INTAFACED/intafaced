import { z } from 'zod';
import { router, publicProcedure, protectedProcedure, scopedProcedure, anyScopeProcedure, TRPCError } from '@intafaced/contracts';
import { InsufficientFundsError, LedgerError, formatAmount, parseAmount } from '@intafaced/ledger-client';
import { hasScope } from '@intafaced/auth';
import {
  ActionApprovalConsumeError,
  consumeTokenApproval,
  unwiredApprovalConsumer,
  type ActionApprovalConsumer,
} from './action-approval-consume.js';
import { DualControlError, requireDualControl } from './dual-control.js';
import {
  TokenError,
  feeDiscountLadderToPublish,
  previewStakeTerms,
  type BuybackRunResult,
  type TokenService,
  type YieldRunResult,
} from './token-service.js';
import { publishedStakeTiers, stakingAssetPublication } from './terms.js';
import { requireTokenJobService } from './job-hmac.js';
import { DELEGATION_BLOCKER, refuseDelegation, unavailableDelegation } from './delegation.js';
import { userCopy } from './user-copy.js';
import { BALLOT_BPS, MAX_CHOICES, VOTING_TYPES, type ChoiceTally } from './ballot-tally.js';
import type { SnapshotSeal } from './governance-vote.js';
import { voteMessage } from './vote-signature.js';
import { feeDiscountSchedulePayload } from './economics/staking.js';
import { createLaunchRouter, type LaunchRouterOptions } from './launch/router.js';
import type { LaunchService } from './launch/launch-service.js';

/** The founders' approval that publishes the fee-decay schedule; the router binds the ladder and the version it replaces. */
export const FEE_DISCOUNT_PUBLISH_ACTION = 'token.fee_discount.publish';

/**
 * svc-token API surface.
 *
 * Hot path for other services remains GET /internal/stake/:userId (index.ts).
 * This router mounts under /trpc for edge/principal-aware callers.
 *
 * Mutations: `token:stake` (users stake/unstake/vote), HMAC job twins
 * (`mintEpoch` / `yield.runWindow` / `buyback.runWindow` as svc-token),
 * `admin:treasury` (operator `distributeRevenue` / `recordBuyback` — MFA via
 * INTERACTIVE_ONLY, then identity-issued action-bound approval. Typed-in
 * `confirmOperatorId` is not authority; missing approval ids refuse.
 * HMAC jobs are not this door).
 *
 * WHAT IS AND IS NOT AUTOMATIC ON THIS ROUTER. Staking and emissions are live
 * end to end. The three §4.3 economy surfaces are not, and are §13 sockets in
 * tooling/tracker/features.mjs rather than shipped features:
 *
 *   token.yield      Weekly job `yield.runWindow` / POST /internal/yield/run-window
 *                    reads houseFees via ledger-client and calls distributeRevenue.
 *                    Job input is `{ windowId }` only — never caller-typed amounts.
 *                    Unset/off, or blank `YIELD_DISTRIBUTION_CRON_HOURS`, is
 *                    `token.yield_job_unset` (never git-default 168). Operator
 *                    `distributeRevenue` remains a treasury mutation.
 *   token.buyback    Live job `buyback.runWindow` / POST /internal/buyback/run-window
 *                    sizes spend via `buybackBudget(houseFees)`, then an internal
 *                    HMAC place (USER REST `/api/v1/orders` is unpublished here).
 *                    Job input is `{ runId, revenueWindow }` only — never
 *                    caller-typed `tokensBought`. Empty book is
 *                    `token.buyback_book_empty`. Unset/off is
 *                    `token.buyback_job_unset`. Operator `recordBuyback`
 *                    remains a treasury mutation and still refuses unmoved.
 *   token.governance `closeProposal` writes passed|rejected from owner env bps.
 *                    Blank TOKEN_GOVERNANCE_QUORUM_BPS / THRESHOLD_BPS refuses
 *                    `token.governance_quorum_unset`. Grant/listing close does
 *                    not execute (`token.governance_execute_unwired`).
 *   token.delegation `delegate` refuses `token.delegation_unavailable` with
 *                    blocker `no_chain_service` (no chain service and no
 *                    on-chain delegate registry). Nothing is written.
 *                    `delegation` reads a null delegatee and that blocker.
 *   token.treasury   `burned` is the `burnedSupply` balance. Lifetime
 *                    `minted`, `bought`, `toRewards` and `distributed` sum
 *                    closed mints, settled buybacks and paid yield rows.
 *                    `lastBuyback` is the latest settled run, or null.
 *                    No rows on those sums is null. No price. No new recipe.
 *
 * Say so wherever these are described. An operator mutation is not a flywheel.
 */

/** Money crosses the wire as a decimal string. Always. Never a number. */
const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amount must be an unsigned decimal string (max 18dp)');

const stakeTier = z.enum(['flex', 'm3', 'm12']);

const stakeOutput = z.object({
  id: z.string().guid(),
  userId: z.string().guid(),
  amount: amountString,
  tier: stakeTier,
  startedAt: z.string(),
  unlocksAt: z.string().nullable(),
  status: z.enum(['pending', 'active', 'unstaking', 'closed']),
});

/**
 * Page size is optional so an omit reaches the named refuse
 * (`token.history_list_limit_unset`) instead of a Zod "Required".
 * Blank is not 50. Cursor omit is the first page.
 */
const historyInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .default({});

const payoutHistoryOutput = z.object({
  items: z.array(
    z.object({
      windowId: z.string(),
      amount: amountString.nullable(),
      assetId: z.string().nullable(),
      ledgerTxId: z.string().nullable(),
      reason: z.literal('ledger_tx_unread').nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

const proposalKind = z.enum(['listing', 'fee_param', 'curriculum', 'grant']);
const proposalStatus = z.enum(['draft', 'open', 'passed', 'rejected', 'executed', 'cancelled', 'closed_ranked']);
const voteChoice = z.enum(['for', 'against', 'abstain']);
const votingType = z.enum(VOTING_TYPES);
const choiceIndex = z
  .number()
  .int()
  .min(0)
  .max(MAX_CHOICES - 1);
/** A non-basic ballot (MC-token-03). The service checks it against the proposal's type and choices. */
const ballotWire = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('abstain') }).strict(),
  z.object({ kind: z.literal('pick'), choices: z.array(choiceIndex).min(1).max(MAX_CHOICES) }).strict(),
  z
    .object({
      kind: z.literal('split'),
      parts: z
        .array(z.object({ choice: choiceIndex, bps: z.number().int().min(1).max(BALLOT_BPS) }).strict())
        .min(1)
        .max(MAX_CHOICES),
    })
    .strict(),
]);
const snapshotOutput = z.object({ count: z.number().int().nonnegative(), total: z.string(), hash: z.string() });
const choiceTallyOutput = z.object({
  totals: z.array(z.string()),
  abstainWeight: z.string(),
  participatingWeight: z.string(),
  voterCount: z.number().int().nonnegative(),
  ranking: z.array(z.number().int().nonnegative()),
  rounds: z.array(z.array(z.string())).nullable(),
});

/** Stored id `gov:proposal:<space>:<author>:<n>`. Not a client uuid. */
const proposalIdWire = z.string().min(1).max(512);

const proposalCountsOutput = z.object({
  votes: z.number().int().nonnegative(),
  for: z.number().int().nonnegative(),
  against: z.number().int().nonnegative(),
  abstain: z.number().int().nonnegative(),
});

const proposalOutput = z.object({
  id: proposalIdWire,
  kind: proposalKind,
  body: z.record(z.string(), z.unknown()),
  status: proposalStatus,
  opensAt: z.string(),
  closesAt: z.string(),
  createdAt: z.string(),
  title: z.string().nullable(),
  bodyMd: z.string().nullable(),
  discussionLink: z.string().nullable(),
  businessKey: z.string().nullable(),
  authorId: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  votingType,
  choices: z.array(z.string()).nullable(),
  snapshot: snapshotOutput.nullable(),
  ranking: z.array(z.number().int().nonnegative()).nullable(),
  counts: proposalCountsOutput,
});

const proposalAccessCode = z.enum([
  'token.proposer_rule_unset',
  'token.proposal_limit_unset',
  'token.proposal_not_allowed',
  'token.proposal_limit_reached',
]);

const tallyOutput = z.object({
  forWeight: z.string(),
  againstWeight: z.string(),
  abstainWeight: z.string(),
  totalWeight: z.string(),
  voterCount: z.number().int().nonnegative(),
});

export interface TokenRouterOptions {
  /**
   * Kill-switch for minting. When false every mint procedure fails closed —
   * inflation cannot be un-minted (§4.3 / EMISSIONS_ENABLED).
   */
  emissionsEnabled?: boolean;
  /**
   * Weekly yield aggregation. When omitted, `yield.runWindow` refuses
   * `token.yield_job_unset`. Callback MUST NOT accept `sources`.
   */
  runYieldWindow?: (input: { windowId: string }) => Promise<YieldRunResult>;
  /**
   * Buyback market-buy job. When omitted, `buyback.runWindow` refuses
   * `token.buyback_job_unset`. Callback MUST NOT accept `tokensBought`.
   */
  runBuybackWindow?: (input: { runId: string; revenueWindow: { from: Date; to: Date } }) => Promise<BuybackRunResult>;
  /**
   * Whether the buyback job has every setting it needs and its trade place is
   * published. Read by `buybackRuns` only, which also needs the rate set before
   * it says "set", so "job not set" is honest.
   * Default false: an unknown state never reads as running.
   */
  buybackJobSet?: boolean;
  /**
   * Identity consume for operator treasury mutates. Default unwired — blank
   * IDENTITY_URL must refuse, never invent a second person.
   */
  approvals?: ActionApprovalConsumer;
  /** `token.launch.*` (J-more-catalogue-11). Omitted in tests that do not touch launches. */
  launch?: { service: LaunchService } & Omit<LaunchRouterOptions, 'approvals'>;
}

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof DualControlError || err instanceof ActionApprovalConsumeError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
  }
  if (err instanceof InsufficientFundsError || err instanceof LedgerError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: userCopy(err.code), cause: err });
  }
  if (err instanceof TokenError) {
    const message = err.code === 'token.params_unset' ? userCopy(err.code, err.config ? { config: err.config } : {}) : userCopy(err.code);
    switch (err.code) {
      case 'token.proposal_not_found':
      case 'token.stake_not_found':
        return new TRPCError({ code: 'NOT_FOUND', message, cause: err });
      case 'token.proposal_not_allowed':
      case 'token.already_voted':
        return new TRPCError({ code: 'FORBIDDEN', message, cause: err });
      // 429: the request is fine, the epoch clock is not ready. The service's own
      // message says how long to wait (database clock, no secrets), so it is passed
      // through instead of the dotted-key copy.
      case 'token.epoch_too_early':
        return new TRPCError({ code: 'TOO_MANY_REQUESTS', message: err.message, cause: err });
      // 409: the request is well-formed, but the revenue window (or the run id)
      // is already spoken for. This is the refusal that used to arrive as a raw
      // PG 23505 — an opaque INTERNAL_SERVER_ERROR, *after* the burn had already
      // posted irreversibly.
      case 'token.buyback_window_overlap':
      case 'token.buyback_run_conflict':
      case 'token.fee_discount_stale':
        return new TRPCError({ code: 'CONFLICT', message, cause: err });
      // The ladder's own error names the step that is wrong; the copy alone would not tell the owner which.
      case 'token.fee_discount_invalid':
        return new TRPCError({ code: 'BAD_REQUEST', message: `${message} ${err.message}`, cause: err });
      case 'token.buyback_window_invalid':
      case 'token.buyback_revenue_invalid':
      case 'token.buyback_tokens_unmoved':
      case 'token.buyback_book_empty':
        return new TRPCError({ code: 'BAD_REQUEST', message, cause: err });
      case 'token.stake_id_required':
      case 'token.stake_locked':
      case 'token.stake_closed':
      case 'token.stake_conflict':
      case 'token.stake_claim_missing':
      case 'token.epoch_closed':
      case 'token.supply_exhausted':
      case 'token.nothing_to_distribute':
      case 'token.yield_source_underfunded':
      case 'token.params_missing':
      case 'token.params_invalid':
        return new TRPCError({ code: 'BAD_REQUEST', message, cause: err });
      case 'token.params_unset':
      case 'token.yield_job_unset':
      case 'token.buyback_job_unset':
      case 'token.governance_quorum_unset':
      case 'token.governance_snapshot_missing':
      case 'token.governance_execute_unwired':
      case 'token.delegation_unavailable':
      case 'token.treasury_figure_unreadable':
      case 'token.vote_history_unreadable':
      case 'token.proposal_list_limit_unset':
      case 'token.proposer_rule_unset':
      case 'token.proposal_limit_unset':
      case 'token.proposal_limit_reached':
      case 'token.proposal_not_editable':
      case 'token.stakes_list_limit_unset':
      case 'token.history_list_limit_unset':
      case 'token.emission_schedule_count_unset':
      case 'token.staking_asset_unpublished':
      case 'token.stake_ledger_mismatch':
      case 'token.vote_rule_unset':
      case 'token.signed_vote_unavailable':
        return new TRPCError({ code: 'PRECONDITION_FAILED', message, cause: err });
      case 'token.stake_tier_unknown':
      case 'token.stake_amount_invalid':
      case 'token.history_cursor_invalid':
      case 'token.delegation_delegatee_unset':
      case 'token.delegation_delegatee_invalid':
      case 'token.proposal_title_invalid':
      case 'token.proposal_handle_invalid':
      case 'token.ballot_invalid':
      case 'token.voting_type_unsupported':
      case 'token.vote_signature_required':
      case 'token.vote_signature_invalid':
      case 'token.vote_rule_not_met':
        return new TRPCError({ code: 'BAD_REQUEST', message, cause: err });
      default:
        return new TRPCError({ code: 'BAD_REQUEST', message, cause: err });
    }
  }
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: userCopy('error.generic'), cause: err });
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toTrpcError(err);
  }
}

function assertSelf(principalUserId: string | undefined, ownerId: string): void {
  if (principalUserId !== ownerId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: userCopy('error.forbidden') });
  }
}

function stakeToWire(s: {
  id: string;
  userId: string;
  amount: bigint;
  tier: 'flex' | 'm3' | 'm12';
  startedAt: Date;
  unlocksAt: Date | null;
  status: 'pending' | 'active' | 'unstaking' | 'closed';
}) {
  return {
    id: s.id,
    userId: s.userId,
    amount: formatAmount(s.amount),
    tier: s.tier,
    startedAt: s.startedAt.toISOString(),
    unlocksAt: s.unlocksAt?.toISOString() ?? null,
    status: s.status,
  };
}

function proposalToWire(p: {
  id: string;
  kind: z.infer<typeof proposalKind>;
  body: Record<string, unknown>;
  status: z.infer<typeof proposalStatus>;
  opensAt: Date;
  closesAt: Date;
  createdAt: Date;
  title: string | null;
  bodyMd: string | null;
  discussionLink: string | null;
  businessKey: string | null;
  authorId: string | null;
  revision: number;
  votingType: z.infer<typeof votingType>;
  choices: string[] | null;
  snapshot: SnapshotSeal | null;
  ranking: number[] | null;
  counts: { votes: number; for: number; against: number; abstain: number };
}) {
  return {
    id: p.id,
    kind: p.kind,
    body: p.body,
    status: p.status,
    opensAt: p.opensAt.toISOString(),
    closesAt: p.closesAt.toISOString(),
    createdAt: p.createdAt.toISOString(),
    title: p.title,
    bodyMd: p.bodyMd,
    discussionLink: p.discussionLink,
    businessKey: p.businessKey,
    authorId: p.authorId,
    revision: p.revision,
    votingType: p.votingType,
    choices: p.choices,
    snapshot: p.snapshot ? { count: p.snapshot.count, total: formatAmount(p.snapshot.total), hash: p.snapshot.hash } : null,
    ranking: p.ranking,
    counts: p.counts,
  };
}

function choiceTallyToWire(t: ChoiceTally | null) {
  if (!t) return null;
  return {
    totals: t.totals.map(formatAmount),
    abstainWeight: formatAmount(t.abstainWeight),
    participatingWeight: formatAmount(t.participatingWeight),
    voterCount: t.voterCount,
    ranking: t.ranking,
    rounds: t.rounds ? t.rounds.map((round) => round.map(formatAmount)) : null,
  };
}

/** `<utf8ByteLength>:<value>\n` — field text cannot be read as the next pair. */
function frameField(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}\n`;
}

function stableJoined(pairs: ReadonlyArray<readonly [string, string]>): string {
  return [...pairs]
    .map(([key, value]) => `${frameField(key)}${frameField(value)}`)
    .sort()
    .join('');
}

export function createTokenRouter(token: TokenService, options: TokenRouterOptions = {}) {
  const emissionsEnabled = options.emissionsEnabled ?? true;
  const runYieldWindow = options.runYieldWindow;
  const runBuybackWindow = options.runBuybackWindow;
  const buybackJobSet = options.buybackJobSet ?? false;
  const approvals = options.approvals ?? unwiredApprovalConsumer();

  /** HTTP job twin: HMAC as svc-token. Session admin:treasury is 401 unsigned. */
  const jobProcedure = publicProcedure.use(({ ctx, next }) => {
    requireTokenJobService(ctx.service);
    return next({ ctx });
  });

  return router({
    health: publicProcedure
      .output(z.object({ ok: z.boolean(), service: z.literal('svc-token') }))
      .query(() => ({ ok: true, service: 'svc-token' as const })),

    // Self-only on the interactive surface. Cross-user stake is HMAC-only:
    // GET /internal/stake/:userId (L2-IDOR-STAKE).
    stakeOf: scopedProcedure('token:read', { module: 'token' })
      .input(z.object({}).optional())
      .output(z.object({ staked: z.string() }))
      .query(async ({ ctx }) =>
        guard(async () => {
          const userId = ctx.principal.userId;
          if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
          const staked = await token.stakeOf(userId);
          // formatAmount — never Amount.toString(). The scaled bigint string
          // (e.g. 10000 IFC → "10000000000000000000000") is what #1100 sealed
          // out of the S2S gate; the tRPC surface must not re-open that 10^18
          // fail-open for any edge client that parseAmounts the field.
          return { staked: formatAmount(staked) };
        }),
      ),

    accessOf: scopedProcedure('token:read', { module: 'token' })
      .input(z.object({}).optional())
      .output(
        z.object({
          staked: z.string(),
          tier: z.string(),
          feeDiscountBps: z.number().int(),
        }),
      )
      .query(async ({ ctx }) =>
        guard(async () => {
          const userId = ctx.principal.userId;
          if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
          const access = await token.accessOf(userId);
          return {
            staked: formatAmount(access.staked),
            tier: access.tier.name,
            feeDiscountBps: access.feeDiscountBps,
          };
        }),
      ),

    terms: scopedProcedure('token:read', { module: 'token' })
      .output(
        z.object({
          tiers: z.array(
            z.object({
              name: stakeTier,
              label: z.string(),
              lockDays: z.number().int().nonnegative(),
              multiplierBps: z.number().int().nonnegative(),
              minimumStake: z.null(),
              minimumStakeReason: z.literal('stake_minimum_unpublished'),
            }),
          ),
          stakingAsset: z.discriminatedUnion('published', [
            z.object({ published: z.literal(true), assetId: z.string().min(1) }),
            z.object({
              published: z.literal(false),
              assetId: z.null(),
              reason: z.literal('staking_asset_unpublished'),
            }),
          ]),
        }),
      )
      .query(() => ({
        tiers: publishedStakeTiers(),
        stakingAsset: stakingAssetPublication(),
      })),

    stakePreview: scopedProcedure('token:read', { module: 'token' })
      .input(z.object({ amount: amountString, tier: z.string().min(1).max(32) }))
      .output(
        z.object({
          tier: stakeTier,
          unlocksAt: z.string().nullable(),
          multiplierBps: z.number().int().nonnegative(),
          effectiveWeight: amountString,
        }),
      )
      .query(({ input }) =>
        guard(async () => {
          const amount = parseAmount(input.amount);
          return previewStakeTerms({
            amount,
            tier: input.tier,
            at: new Date(),
            stakingAssetPublished: stakingAssetPublication().published,
          });
        }),
      ),

    unstakePreview: scopedProcedure('token:read', { module: 'token' })
      .input(z.object({ stakeId: z.string().guid() }))
      .output(
        z.object({
          status: z.enum(['locked_until', 'ready', 'closing', 'pending', 'closed']),
          unlocksAt: z.string().nullable(),
          amount: amountString,
          afterUnlock: z.literal('full_principal').nullable(),
          refusal: z.enum(['token.stake_locked', 'token.stake_closed']).nullable(),
        }),
      )
      .query(({ ctx, input }) =>
        guard(async () => {
          const userId = ctx.principal.userId;
          if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
          return token.previewUnstake(input.stakeId, userId);
        }),
      ),

    // ── Staking (live path) ────────────────────────────────────────────────
    // Jurisdiction matrix on every custodial mutation (L2-TOKEN-JURIS).

    stake: scopedProcedure('token:stake', { module: 'token' })
      .input(
        z.object({
          amount: amountString,
          tier: stakeTier,
          stakeId: z.string().guid(),
        }),
      )
      .output(stakeOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const userId = ctx.principal.userId;
          if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });

          const amount = parseAmount(input.amount);
          if (amount <= 0n) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'Stake amount must be positive' });
          }

          const stake = await token.stake({
            userId,
            amount,
            tier: input.tier,
            stakeId: input.stakeId,
          });
          return stakeToWire(stake);
        }),
      ),

    unstake: scopedProcedure('token:stake', { module: 'token' })
      .input(z.object({ stakeId: z.string().guid() }))
      .output(stakeOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const userId = ctx.principal.userId;
          if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });

          const existing = await token.getStake(input.stakeId);
          if (!existing) throw new TokenError(`Stake ${input.stakeId} not found`, 'token.stake_not_found');
          assertSelf(userId, existing.userId);

          const stake = await token.unstake(input.stakeId);
          return stakeToWire(stake);
        }),
      ),

    listStakes: scopedProcedure('token:read', { module: 'token' })
      .input(
        z
          .object({
            status: z.enum(['active', 'closed', 'pending', 'all']).default('active'),
            /**
             * Page size. Optional here so omit reaches the service named
             * refuse (`token.stakes_list_limit_unset`) instead of a Zod
             * "Required" that looks like a typo. Blank is not 50; pass 50
             * explicitly when that is the page you want.
             */
            limit: z.number().int().min(1).max(200).optional(),
          })
          .default({ status: 'active' }),
      )
      .output(z.array(stakeOutput))
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const userId = ctx.principal.userId;
          if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
          const stakes = await token.listStakes(userId, input.status, input.limit);
          return stakes.map(stakeToWire);
        }),
      ),

    // ── Emissions ──────────────────────────────────────────────────────────

    mintEpoch: jobProcedure
      .input(z.object({ epoch: z.number().int().nonnegative().optional() }).default({}))
      .output(z.object({ epoch: z.number().int(), minted: amountString }))
      .mutation(async ({ input }) =>
        guard(async () => {
          if (!emissionsEnabled) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'Emissions are disabled (EMISSIONS_ENABLED=false)',
            });
          }
          const result = input.epoch === undefined ? await token.mintNextEpoch() : await token.mintEpoch(input.epoch);
          return { epoch: result.epoch, minted: formatAmount(result.minted) };
        }),
      ),

    nextEmissionEpoch: scopedProcedure('token:read')
      .output(z.object({ epoch: z.number().int().nonnegative() }))
      .query(async () => guard(async () => ({ epoch: await token.nextEmissionEpoch() }))),

    emissionSchedule: scopedProcedure('token:read', { module: 'token' })
      .input(z.object({ count: z.number().int().min(1).max(200).optional() }).default({}))
      .output(
        z.object({
          params: z
            .object({
              initialEpochReward: amountString,
              halvingIntervalEpochs: z.number().int().positive(),
              maxSupply: amountString,
            })
            .nullable(),
          epochs: z
            .array(
              z.object({
                epoch: z.number().int().nonnegative(),
                reward: amountString,
              }),
            )
            .nullable(),
          missing: z.string().nullable(),
          reason: z.enum(['token.params_unset', 'token.params_missing', 'token.params_invalid']).nullable(),
        }),
      )
      .query(({ input }) => guard(async () => token.emissionSchedule(input.count))),

    yieldHistory: scopedProcedure('token:read', { module: 'token' })
      .input(historyInput)
      .output(payoutHistoryOutput)
      .query(({ ctx, input }) =>
        guard(async () => {
          const userId = ctx.principal.userId;
          if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
          return token.yieldHistory(userId, input.limit, input.cursor);
        }),
      ),

    revenueShareHistory: scopedProcedure('token:read', { module: 'token' })
      .input(historyInput)
      .output(payoutHistoryOutput)
      .query(({ ctx, input }) =>
        guard(async () => {
          const userId = ctx.principal.userId;
          if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
          return token.revenueShareHistory(userId, input.limit, input.cursor);
        }),
      ),

    myVotes: scopedProcedure('token:read', { module: 'token' })
      .input(historyInput)
      .output(
        z.object({
          items: z.array(
            z
              .object({
                proposalId: proposalIdWire,
                title: z.string().nullable(),
                titleReason: z.literal('proposal_title_unset').nullable(),
                votingType,
                weight: amountString,
                castAt: z.string(),
              })
              // Exactly one of a basic choice or a stored ballot, as the table holds it.
              .and(z.union([z.object({ choice: voteChoice, ballot: z.null() }), z.object({ choice: z.null(), ballot: ballotWire })])),
          ),
          nextCursor: z.string().nullable(),
        }),
      )
      .query(({ ctx, input }) =>
        guard(async () => {
          const userId = ctx.principal.userId;
          if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
          return token.myVotes(userId, input.limit, input.cursor);
        }),
      ),

    // ── Yield aggregation job + operator settlement + burn ────────────────
    // `yield.runWindow` is the §4.3 weekly job: `{ windowId }` only, amounts
    // from ledger.balance(houseFees). Unset/off → token.yield_job_unset.
    // `distributeRevenue` stays a treasury mutation that still binds first-
    // claim amounts to live houseFees (`token.yield_source_underfunded`).
    // Buyback live job: `{ runId, revenueWindow }` only. Fill from placeOrder.

    buyback: router({
      runWindow: jobProcedure
        .input(
          z
            .object({
              runId: z.string().guid(),
              revenueWindow: z.object({
                from: z.string().datetime({ offset: true }),
                to: z.string().datetime({ offset: true }),
              }),
            })
            .strict(),
        )
        .output(
          z.object({
            runId: z.string().guid(),
            tokensBought: amountString,
            burned: amountString,
            toRewards: amountString,
          }),
        )
        .mutation(async ({ input }) =>
          guard(async () => {
            if (!runBuybackWindow) {
              throw new TokenError('Buyback market-buy job is unset (BUYBACK_JOB_ENABLED=false)', 'token.buyback_job_unset');
            }
            const from = new Date(input.revenueWindow.from);
            const to = new Date(input.revenueWindow.to);
            if (!(from.getTime() < to.getTime())) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'revenueWindow.from must be strictly before revenueWindow.to',
              });
            }
            const result = await runBuybackWindow({ runId: input.runId, revenueWindow: { from, to } });
            return {
              runId: result.runId,
              tokensBought: formatAmount(result.tokensBought),
              burned: formatAmount(result.burned),
              toRewards: formatAmount(result.toRewards),
            };
          }),
        ),
    }),

    yield: router({
      runWindow: jobProcedure
        .input(z.object({ windowId: z.string().min(1).max(128) }).strict())
        .output(
          z.object({
            windowId: z.string(),
            distributed: amountString,
            recipients: z.number().int().nonnegative(),
            skipped: z.number().int().nonnegative(),
            alreadyPaid: z.number().int().nonnegative(),
          }),
        )
        .mutation(async ({ input }) =>
          guard(async () => {
            if (!runYieldWindow) {
              throw new TokenError('Yield aggregation job is unset (YIELD_JOB_ENABLED=false)', 'token.yield_job_unset');
            }
            const result = await runYieldWindow({ windowId: input.windowId });
            return {
              windowId: result.windowId,
              distributed: formatAmount(result.distributed),
              recipients: result.recipients,
              skipped: result.skipped,
              alreadyPaid: result.alreadyPaid,
            };
          }),
        ),
    }),

    distributeRevenue: scopedProcedure('admin:treasury')
      .input(
        z.object({
          windowId: z.string().min(1).max(128),
          sources: z
            .array(
              z.object({
                module: z.string().min(1).max(64),
                amount: amountString,
              }),
            )
            .min(1),
          /**
           * Typed-in second name is not approval. Nullish so MFA runs first;
           * missing/blank refuse `action_approval.missing`, not a schema dump.
           */
          confirmOperatorId: z.string().max(128).nullish(),
          approvalId: z.string().max(128).nullish(),
          operationId: z.string().max(128).nullish(),
        }),
      )
      .output(
        z.object({
          windowId: z.string(),
          /** Value moved BY THIS CALL. A re-run that posts nothing reports 0. */
          distributed: amountString,
          recipients: z.number().int().nonnegative(),
          skipped: z.number().int().nonnegative(),
          /**
           * Planned payouts this call found already posted — the operator's only
           * way to tell "this window was already settled" from "this window has
           * just paid out again", which the previous shape could not express.
           */
          alreadyPaid: z.number().int().nonnegative(),
          confirmOperatorId: z.string(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const consumed = await consumeTokenApproval(
            approvals,
            input,
            'token.revenue.distribute',
            {
              windowId: input.windowId,
              sources: stableJoined(input.sources.map((s) => [s.module, s.amount] as const)),
            },
            input.windowId,
          );
          const confirmOperatorId = requireDualControl(ctx.principal.userId, consumed.approverId);
          const result = await token.distributeRevenue({
            windowId: input.windowId,
            sources: input.sources.map((s) => ({ module: s.module, amount: parseAmount(s.amount) })),
          });
          return {
            windowId: result.windowId,
            distributed: formatAmount(result.distributed),
            recipients: result.recipients,
            skipped: result.skipped,
            alreadyPaid: result.alreadyPaid,
            confirmOperatorId,
          };
        }),
      ),

    /**
     * The published fee-decay schedule (§4.3): stake thresholds to fee discount bps, the ladder `accessOf` reads.
     * `get` answers the stored row (null while blank) and its version to any token reader, since it prices their fees,
     * and to the operators who publish it. It is the published price list, not account data, so it carries no module
     * gate (an operator session has no KYC tier).
     * `publish` is the owner's door until governance executes `fee_param` proposals: two founders approve exactly this
     * ladder over exactly the version it replaces (`token.fee_discount.publish`), and the proposer writes it.
     */
    feeDiscount: router({
      get: anyScopeProcedure(['token:read', 'admin:read'])
        .output(z.object({ schedule: z.unknown(), version: z.string() }))
        .query(() => guard(() => token.feeDiscountScheduleRow())),
      publish: scopedProcedure('admin:write')
        .input(
          z.object({
            schedule: z
              .object({
                basis: z.literal('staked'),
                tiers: z
                  .array(z.object({ minStake: z.string().min(1).max(64), discountBps: z.number().int() }).strict())
                  .min(1)
                  .max(32),
              })
              .strict(),
            expectedVersion: z.string().min(1).max(80),
            approvalId: z.string().max(128).nullish(),
            operationId: z.string().max(128).nullish(),
          }),
        )
        .output(
          z.object({
            schedule: z.object({
              basis: z.literal('staked'),
              tiers: z.array(z.object({ minStake: z.string(), discountBps: z.number().int() })),
            }),
            version: z.string(),
            previousVersion: z.string(),
            confirmOperatorId: z.string(),
          }),
        )
        .mutation(({ ctx, input }) =>
          guard(async () => {
            // Refuse a ladder the door would refuse, or a version already replaced, before the founders' approval is
            // spent on it. The write checks the version again under its lock.
            feeDiscountLadderToPublish(input.schedule);
            const stored = await token.feeDiscountScheduleRow();
            if (stored.version !== input.expectedVersion) {
              throw new TokenError(
                `expectedVersion ${input.expectedVersion} is stale; the stored schedule is ${stored.version}`,
                'token.fee_discount_stale',
              );
            }
            const consumed = await consumeTokenApproval(
              approvals,
              input,
              FEE_DISCOUNT_PUBLISH_ACTION,
              { schedule: feeDiscountSchedulePayload(input.schedule), expectedVersion: input.expectedVersion },
              input.expectedVersion,
            );
            const confirmOperatorId = requireDualControl(ctx.principal.userId, consumed.approverId);
            const result = await token.publishFeeDiscountSchedule({ schedule: input.schedule, expectedVersion: input.expectedVersion });
            return { ...result, confirmOperatorId };
          }),
        ),
    }),

    recordBuyback: scopedProcedure('admin:treasury')
      .input(
        z.object({
          runId: z.string().guid(),
          /** Half-open `[from, to)` — `to` belongs to the next window (0002). */
          revenueWindow: z.object({
            from: z.string().datetime({ offset: true }),
            to: z.string().datetime({ offset: true }),
          }),
          /**
           * assetId → revenue collected, as decimal strings.
           *
           * Was `z.record(z.string(), z.string())`, which accepted any string at all and
           * wrote it straight to jsonb: `{"IFC":"not-a-number","USDT":"-999"}`
           * stored cleanly. This is the audit record of what the run was sized
           * against, so an unparseable figure here cannot be reconciled against
           * the ledger later — the one thing the column is for. `amountString`
           * is the same unsigned-decimal money-law shape every other amount on
           * this router uses; the service re-validates and canonicalises.
           */
          revenueTotal: z.record(z.string(), amountString),
          tokensBought: amountString,
          /**
           * Typed-in second name is not approval. HMAC `buyback.runWindow`
           * is not this door.
           */
          confirmOperatorId: z.string().max(128).nullish(),
          approvalId: z.string().max(128).nullish(),
          operationId: z.string().max(128).nullish(),
        }),
      )
      .output(
        z.object({
          runId: z.string().guid(),
          burned: amountString,
          toRewards: amountString,
          confirmOperatorId: z.string(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const from = new Date(input.revenueWindow.from);
          const to = new Date(input.revenueWindow.to);
          if (!(from.getTime() < to.getTime())) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'revenueWindow.from must be strictly before revenueWindow.to',
            });
          }
          const consumed = await consumeTokenApproval(
            approvals,
            input,
            'token.buyback.record',
            {
              runId: input.runId,
              from: input.revenueWindow.from,
              to: input.revenueWindow.to,
              tokensBought: input.tokensBought,
              revenueTotal: stableJoined(Object.entries(input.revenueTotal)),
            },
            input.runId,
          );
          const confirmOperatorId = requireDualControl(ctx.principal.userId, consumed.approverId);
          const result = await token.recordBuyback({
            runId: input.runId,
            revenueWindow: { from, to },
            revenueTotal: input.revenueTotal,
            tokensBought: parseAmount(input.tokensBought),
          });
          return {
            runId: result.runId,
            burned: formatAmount(result.burned),
            toRewards: formatAmount(result.toRewards),
            confirmOperatorId,
          };
        }),
      ),

    /**
     * Caller's own delegation. Always a null delegatee: there is no chain
     * service and no on-chain delegate registry (`no_chain_service`).
     * Not a lookup of someone else.
     */
    delegation: scopedProcedure('token:read', { module: 'token' })
      .output(
        z.object({
          delegateeUserId: z.null(),
          blocker: z.literal(DELEGATION_BLOCKER),
        }),
      )
      .query(({ ctx }) => {
        if (!ctx.principal.userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
        return unavailableDelegation();
      }),

    /**
     * Set a delegate. Blank target is `token.delegation_delegatee_unset`.
     * A non-member id is `token.delegation_delegatee_invalid`.
     * Any member id, including the caller, is `token.delegation_unavailable`
     * with blocker `no_chain_service`. No row, no vote-weight change.
     */
    delegate: scopedProcedure('token:stake', { module: 'token' })
      .input(z.object({ delegateeUserId: z.string().max(128).nullish() }).strict())
      .mutation(({ ctx, input }) => {
        if (!ctx.principal.userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
        return guard(async () => {
          refuseDelegation(input.delegateeUserId);
        });
      }),

    /**
     * `burned` is `burnedSupply`. The other sums are rows this service stored.
     * Null on those sums, and a null `lastBuyback`, means no rows, not zero.
     * Does not price the token and does not post a new recipe.
     */
    treasury: scopedProcedure('token:read', { module: 'token' })
      .output(
        z.object({
          minted: amountString.nullable(),
          burned: amountString,
          bought: amountString.nullable(),
          toRewards: amountString.nullable(),
          distributed: amountString.nullable(),
          lastBuyback: z
            .object({
              bought: amountString,
              burned: amountString,
              toRewards: amountString,
              executedAt: z.string().datetime({ offset: true }),
            })
            .nullable(),
        }),
      )
      .query(({ ctx }) => {
        if (!ctx.principal.userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
        return guard(() => token.treasuryView());
      }),

    buybackRuns: scopedProcedure('token:read', { module: 'token' })
      .input(z.object({ limit: z.number().int().min(1).max(200) }))
      .output(
        z.object({
          job: z.enum(['set', 'unset']),
          runs: z.array(
            z.object({
              id: z.string().min(1),
              bought: amountString,
              burned: amountString,
              toRewards: amountString,
              executedAt: z.string().datetime({ offset: true }),
              windowFrom: z.string().datetime({ offset: true }),
              windowTo: z.string().datetime({ offset: true }),
            }),
          ),
          rate: z
            .object({
              buybackBps: z.number().int().min(0).max(10_000),
              burnSplitBps: z.number().int().min(0).max(10_000),
            })
            .nullable(),
          missing: z.string().nullable(),
          reason: z.enum(['token.params_unset', 'token.params_missing', 'token.params_invalid']).nullable(),
        }),
      )
      .query(({ ctx, input }) => {
        if (!ctx.principal.userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
        return guard(async () => {
          const read = await token.buybackRuns(input.limit);
          return { job: buybackJobSet && read.rate ? ('set' as const) : ('unset' as const), ...read };
        });
      }),

    burnedSupply: scopedProcedure('token:read')
      .output(z.object({ burned: amountString }))
      .query(async () =>
        guard(async () => ({
          burned: formatAmount(await token.burnedSupply()),
        })),
      ),

    // ── Governance — ballots + close tally (§4.3) ──────────────────────────
    //
    // `closeProposal` writes passed|rejected from the tally vs owner env bps.
    // Blank env → token.governance_quorum_unset. Grant/listing do not execute
    // (token.governance_execute_unwired). No executeProposal.

    createProposal: protectedProcedure
      .input(
        z.object({
          kind: proposalKind,
          body: z.record(z.string(), z.unknown()).default({}),
          opensAt: z.string().datetime({ offset: true }).optional(),
          closesAt: z.string().datetime({ offset: true }).optional(),
          handle: z.string().optional(),
          title: z.string().optional(),
          bodyMd: z.string().optional(),
          discussionLink: z.string().optional(),
          /** `basic` when omitted. Any other type needs 2 to 20 choices. */
          votingType: votingType.optional(),
          choices: z.array(z.string().max(1000)).max(MAX_CHOICES).optional(),
        }),
      )
      .output(proposalOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const userId = ctx.principal.userId;
          if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });

          const asAdmin = hasScope(ctx.principal.scopes, 'admin:write') || hasScope(ctx.principal.scopes, 'admin:treasury');
          if (!asAdmin && !hasScope(ctx.principal.scopes, 'token:stake')) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'createProposal requires token:stake or admin:write',
            });
          }

          const proposal = await token.createProposal({
            kind: input.kind,
            body: input.body,
            createdBy: userId,
            asAdmin,
            opensAt: input.opensAt ? new Date(input.opensAt) : undefined,
            closesAt: input.closesAt ? new Date(input.closesAt) : undefined,
            handle: input.handle,
            title: input.title,
            bodyMd: input.bodyMd,
            discussionLink: input.discussionLink,
            votingType: input.votingType,
            choices: input.choices,
          });
          return proposalToWire(proposal);
        }),
      ),

    castVote: scopedProcedure('token:stake', { module: 'token' })
      .input(
        z.object({
          proposalId: proposalIdWire,
          /** For/against/abstain on a basic proposal; abstain on any type. */
          choice: voteChoice.optional(),
          ballot: ballotWire.optional(),
          /**
           * A linked wallet's EIP-191 signature over the vote's message (`voteMessage`). Missing refuses
           * `token.vote_signature_required`; identity checks the signer.
           */
          signature: z
            .string()
            .regex(/^0x[0-9a-fA-F]{130}$/)
            .optional(),
        }),
      )
      .output(
        z.object({
          id: z.string().guid(),
          proposalId: proposalIdWire,
          userId: z.string().guid(),
          weight: z.string(),
          choice: voteChoice.nullable(),
          ballot: ballotWire.nullable(),
          castAt: z.string(),
          signedBy: z.string(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const userId = ctx.principal.userId;
          if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });

          const vote = await token.castVote({
            proposalId: input.proposalId,
            userId,
            choice: input.choice,
            ballot: input.ballot,
            signature: input.signature,
          });
          return {
            id: vote.id,
            proposalId: vote.proposalId,
            userId: vote.userId,
            weight: formatAmount(vote.weight),
            choice: vote.choice,
            ballot: vote.ballot,
            castAt: vote.castAt.toISOString(),
            signedBy: vote.signedBy,
          };
        }),
      ),

    /**
     * The exact text the signed account's wallet signs for this vote (`voteMessage`), so the browser signs the bytes the
     * service checks. Reads nothing and stores nothing; castVote validates the vote itself.
     */
    voteMessage: scopedProcedure('token:read', { module: 'token' })
      .input(z.object({ proposalId: proposalIdWire, choice: voteChoice.optional(), ballot: ballotWire.optional() }))
      .output(z.object({ message: z.string() }))
      .query(({ ctx, input }) => {
        const userId = ctx.principal.userId;
        if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
        return { message: voteMessage({ proposalId: input.proposalId, userId, choice: input.choice, ballot: input.ballot }) };
      }),

    listProposals: scopedProcedure('token:read')
      .input(
        z
          .object({
            status: proposalStatus.optional(),
            kind: proposalKind.optional(),
            /**
             * Page size. Optional here so omit reaches the service named
             * refuse (`token.proposal_list_limit_unset`) instead of a Zod
             * "Required" that looks like a typo. Blank is not 50; pass 50
             * explicitly when that is the page you want.
             */
            limit: z.number().int().min(1).max(200).optional(),
            q: z.string().optional(),
          })
          .default({}),
      )
      .output(z.array(proposalOutput))
      .query(async ({ input }) =>
        guard(async () => {
          const rows = await token.listProposals(input);
          return rows.map(proposalToWire);
        }),
      ),

    getProposal: scopedProcedure('token:read')
      .input(z.object({ proposalId: proposalIdWire }))
      .output(proposalOutput.extend({ tally: tallyOutput, choiceTally: choiceTallyOutput.nullable() }))
      .query(async ({ input }) =>
        guard(async () => {
          const detail = await token.getProposal(input.proposalId);
          return {
            ...proposalToWire(detail),
            choiceTally: choiceTallyToWire(detail.choiceTally),
            tally: {
              forWeight: formatAmount(detail.tally.forWeight),
              againstWeight: formatAmount(detail.tally.againstWeight),
              abstainWeight: formatAmount(detail.tally.abstainWeight),
              totalWeight: formatAmount(detail.tally.totalWeight),
              voterCount: detail.tally.voterCount,
            },
          };
        }),
      ),

    closeProposal: scopedProcedure('token:stake', { module: 'token' })
      .input(z.object({ proposalId: proposalIdWire }))
      .output(
        proposalOutput.extend({
          tally: tallyOutput,
          choiceTally: choiceTallyOutput.nullable(),
          execute: z.literal('token.governance_execute_unwired').nullable(),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          const closed = await token.closeProposal({ proposalId: input.proposalId });
          return {
            ...proposalToWire(closed),
            choiceTally: choiceTallyToWire(closed.choiceTally),
            tally: {
              forWeight: formatAmount(closed.tally.forWeight),
              againstWeight: formatAmount(closed.tally.againstWeight),
              abstainWeight: formatAmount(closed.tally.abstainWeight),
              totalWeight: formatAmount(closed.tally.totalWeight),
              voterCount: closed.tally.voterCount,
            },
            execute: closed.execute,
          };
        }),
      ),

    /**
     * The signed account's voting power (MC-token-03): the stored snapshot of
     * one proposal, and every stored snapshot newest first. Zero carries its
     * reason. A list without a page size refuses `token.history_list_limit_unset`.
     */
    votingPower: router({
      ofProposal: scopedProcedure('token:read', { module: 'token' })
        .input(z.object({ proposalId: proposalIdWire }))
        .output(
          z.object({
            proposalId: proposalIdWire,
            power: z.string(),
            reason: z.enum(['no_stake_at_creation', 'not_measured']).nullable(),
            takenAt: z.string().nullable(),
            /** Who may vote: the minimum power, or the typed code every vote is refused with. */
            rule: z.object({ minPower: z.string().nullable(), code: z.string().nullable() }),
            /**
             * Every vote is signed. `available: false` with its code when no identity is configured; when true,
             * whether the account has a linked wallet is identity's answer at cast time.
             */
            signing: z.object({
              required: z.literal(true),
              available: z.boolean(),
              code: z.literal('token.signed_vote_unavailable').nullable(),
            }),
          }),
        )
        .query(async ({ ctx, input }) =>
          guard(async () => {
            const userId = ctx.principal.userId;
            if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
            const power = await token.proposalPower(input.proposalId, userId);
            return {
              ...power,
              power: formatAmount(power.power),
              takenAt: power.takenAt?.toISOString() ?? null,
              rule: { minPower: power.rule.minPower === null ? null : formatAmount(power.rule.minPower), code: power.rule.code },
              signing: token.signedVotesConfigured()
                ? { required: true as const, available: true, code: null }
                : { required: true as const, available: false, code: 'token.signed_vote_unavailable' as const },
            };
          }),
        ),
      history: scopedProcedure('token:read', { module: 'token' })
        .input(z.object({ limit: z.number().int().min(1).max(200).optional() }).default({}))
        .output(z.array(z.object({ proposalId: proposalIdWire, title: z.string().nullable(), takenAt: z.string(), power: z.string() })))
        .query(async ({ ctx, input }) =>
          guard(async () => {
            const userId = ctx.principal.userId;
            if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
            const rows = await token.votingPowerHistory(userId, input.limit);
            return rows.map((row) => ({ ...row, takenAt: row.takenAt.toISOString(), power: formatAmount(row.power) }));
          }),
        ),
    }),

    editProposal: protectedProcedure
      .input(
        z.object({
          proposalId: proposalIdWire,
          title: z.string().optional(),
          bodyMd: z.string().optional(),
          discussionLink: z.string().optional(),
          body: z.record(z.string(), z.unknown()).optional(),
          opensAt: z.string().datetime({ offset: true }).optional(),
          closesAt: z.string().datetime({ offset: true }).optional(),
        }),
      )
      .output(proposalOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const userId = ctx.principal.userId;
          if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
          const asAdmin = hasScope(ctx.principal.scopes, 'admin:write') || hasScope(ctx.principal.scopes, 'admin:treasury');
          if (!asAdmin && !hasScope(ctx.principal.scopes, 'token:stake')) {
            throw new TRPCError({ code: 'FORBIDDEN', message: 'editProposal requires token:stake or admin:write' });
          }
          const proposal = await token.editProposal({
            proposalId: input.proposalId,
            authorId: userId,
            title: input.title,
            bodyMd: input.bodyMd,
            discussionLink: input.discussionLink,
            body: input.body,
            opensAt: input.opensAt ? new Date(input.opensAt) : undefined,
            closesAt: input.closesAt ? new Date(input.closesAt) : undefined,
          });
          return proposalToWire(proposal);
        }),
      ),

    followSpace: scopedProcedure('token:read', { module: 'token' })
      .input(z.object({ following: z.boolean() }))
      .output(z.object({ spaceId: z.string(), following: z.boolean() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const userId = ctx.principal.userId;
          if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
          return token.followSpace(userId, input.following);
        }),
      ),

    governanceHome: scopedProcedure('token:read', { module: 'token' })
      .output(
        z.object({
          spaceId: z.string(),
          following: z.boolean(),
          proposal: z.object({
            code: proposalAccessCode.nullable(),
            minStake: amountString.nullable(),
          }),
        }),
      )
      .query(async ({ ctx }) =>
        guard(async () => {
          const userId = ctx.principal.userId;
          if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
          const asAdmin = hasScope(ctx.principal.scopes, 'admin:write') || hasScope(ctx.principal.scopes, 'admin:treasury');
          return token.governanceHome(userId, asAdmin);
        }),
      ),
    ...(options.launch ? { launch: createLaunchRouter(options.launch.service, { ...options.launch, approvals }) } : {}),
  });
}

export type TokenRouter = ReturnType<typeof createTokenRouter>;
