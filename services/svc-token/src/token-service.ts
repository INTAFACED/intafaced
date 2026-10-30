import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import type { EventBus } from '@intafaced/events';
import {
  formatAmount,
  parseAmount,
  recipes,
  rewardsEngine,
  burnAccount,
  houseFees,
  tokenStakeAccount,
  InsufficientFundsError,
  MoneyError,
  type Amount,
  type LedgerClient,
} from '@intafaced/ledger-client';
import {
  STAKE_TIERS,
  accessTierFor,
  feeDiscountBps,
  isUnlocked,
  feeDiscountScheduleBlank,
  feeDiscountScheduleVersion,
  parseFeeDiscountSchedule,
  publishableFeeDiscountSchedule,
  stakeWeight,
  unlockDate,
  type FeeDiscountSchedule,
  type PublishedFeeDiscountSchedule,
  type StakeTier,
} from './economics/staking.js';
import { distributeYield, splitBuyback, type BuybackParams } from './economics/buyback.js';
import { cumulativeEmission, epochReward, type EmissionParams } from './economics/emission.js';
import { withMoneySpan } from './tracing.js';
import {
  BALLOT_BPS,
  BallotError,
  MAX_CHOICES,
  assertVotingType,
  normalizeChoices,
  parseStoredBallot,
  tallyChoices,
  validateBallot,
  type Ballot,
  type ChoiceTally,
  type VotingType,
} from './ballot-tally.js';
import {
  parseVoteRule,
  readPowerHistory,
  readProposalPower,
  readSealedSnapshot,
  SIGNED_VOTE_UNAVAILABLE,
  sealFromRow,
  sealSnapshot,
  type PowerHistoryEntry,
  type ProposalPower,
  type SnapshotSeal,
} from './governance-vote.js';
import { GOVERNANCE_EXECUTE_UNWIRED, GOVERNANCE_QUORUM_UNSET, decideProposalOutcome, executeUnwiredFor } from './governance-close.js';
import { voteMessage, type VoteSignaturePort } from './vote-signature.js';
import {
  cancelGovernanceProposal,
  governanceRoleOf,
  governanceRoles,
  governanceSettingsHistory,
  precheckGovernanceRole,
  precheckGovernanceSettings,
  proposalWindow,
  readGovernanceSettings,
  setGovernanceRole,
  setGovernanceSettings,
  type GovernanceRole,
  type GovernanceRoleRow,
  type GovernanceSettings,
} from './governance-settings.js';
import {
  reportBuybackRuns,
  reportLastBuyback,
  reportTreasury,
  type BuybackRunRow,
  type BuybackRunView,
  type LastBuybackRow,
  type TokenTreasuryView,
  type TreasurySums,
} from './treasury-view.js';
import {
  assessProposalAccess,
  editGovernanceDraft,
  insertGovernanceProposal,
  listGovernanceProposals,
  loadProposalRow,
  openDueDrafts,
  proposalCard,
  readGovernanceSpace,
  setGovernanceFollow,
  type ProposalAccess,
} from './governance-home.js';

/**
 * svc-token — THE NATIVE ECONOMY (§4.3).
 *
 * Doctrine §0.6 applies here more than anywhere: this service holds NO
 * balances. `stakes` records who staked what and when; the value itself lives
 * in the ledger's `stake` accounts. That separation is what makes "how much IFC
 * is staked" answerable two independent ways — from this table and from the
 * ledger — which is exactly the property a reconciliation job needs.
 */

export class TokenError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'token.stake_not_found'
      | 'token.stake_locked'
      | 'token.stake_closed'
      | 'token.stake_conflict'
      /**
       * Caller-stable retry key missing. Omit used to mint crypto.randomUUID so
       * a retried HTTP stake without a client id opened a second stake.
       */
      | 'token.stake_id_required'
      /**
       * Ledger post landed (or may have) but the pending claim row is gone —
       * post-without-claim. Caller must not invent a second stakeId; reconcile
       * or retry is the recovery path, not a silent "active" return.
       */
      | 'token.stake_claim_missing'
      /**
       * Active row amount ≠ ledger `tokenStakeAccount` balance. Access, fee
       * discount, and yield weight must not be granted off a table that is
       * not the book.
       */
      | 'token.stake_ledger_mismatch'
      | 'token.epoch_closed'
      /**
       * A NEW epoch was requested sooner than one epoch length (`EMISSIONS_EPOCH_MS`,
       * default 1 day) after the previous epoch was claimed. Resuming an already
       * claimed, unclosed epoch is never refused with this. `retryAfterMs` says
       * how long to wait.
       */
      | 'token.epoch_too_early'
      | 'token.supply_exhausted'
      | 'token.nothing_to_distribute'
      /**
       * Operator named a fee-source amount larger than the houseFees balance
       * for that module (audit T-03 residual). Refuse before claim/sweep so
       * the plan total cannot exceed value that can actually move.
       */
      | 'token.yield_source_underfunded'
      /**
       * A window id that is already planned, re-run naming a different revenue
       * total. The frozen plan and the new figure cannot both be right, and
       * guessing which one the operator meant is not this service's call.
       */
      | 'token.yield_window_mismatch'
      /**
       * Weekly aggregation job unset / off (`YIELD_JOB_ENABLED=false`), blank
       * `YIELD_DISTRIBUTION_CRON_HOURS` (never invent 168), or a caller tried
       * to type `sources[].amount`. The job reads houseFees.
       */
      | 'token.yield_job_unset'
      /**
       * Auto-tick interval unset. Blank / missing / non-integer / below 1000
       * refuses when auto-tick is on — never invent 86400000 (1 day).
       * Explicit `86400000` is owner-present.
       */
      | 'token.emissions_tick_unset'
      // Buyback refusals. Every one of these must fire BEFORE the burn posts —
      // the burn is irreversible, so a refusal that arrives after it is not a
      // refusal (0002 / token-economics ADR).
      | 'token.buyback_window_overlap'
      | 'token.buyback_window_invalid'
      | 'token.buyback_run_conflict'
      | 'token.buyback_revenue_invalid'
      /**
       * Operator-typed `tokensBought` never moved on the ledger. No existing
       * recipe books a market-buy into the rewards engine; settling would
       * write a DB-only buy (and a fee-funded burn is not a buy).
       */
      | 'token.buyback_tokens_unmoved'
      /**
       * Live buyback job unset / off (`BUYBACK_JOB_ENABLED=false`), unpublished
       * internal HMAC place (USER REST `/api/v1/orders` is the wrong door), or
       * a caller tried to type `tokensBought`.
       */
      | 'token.buyback_job_unset'
      /**
       * IOC market-buy found no resting asks (or filled qty 0). Named empty,
       * never an invented mid.
       */
      | 'token.buyback_book_empty'
      | 'token.params_missing'
      | 'token.params_invalid'
      /**
       * A token_params column the action needs is null or blank. The name of
       * that column is `config`. Never filled in from a compiled default.
       */
      | 'token.params_unset'
      /**
       * The owner's fee-decay publish named a version that is no longer the stored one: someone published in between.
       * Nothing is written; read the schedule again and approve the new change.
       */
      | 'token.fee_discount_stale'
      /** The ladder the owner proposed is not one the publish door accepts (shape, order, ceiling). Nothing is written. */
      | 'token.fee_discount_invalid'
      | 'token.proposal_not_found'
      | 'token.proposal_not_open'
      | 'token.proposal_window'
      | 'token.proposal_not_allowed'
      | 'token.already_voted'
      | 'token.no_voting_weight'
      /**
       * listProposals page size unset. Blank / non-finite / <1 refuses.
       * Never invent 50.
       */
      | 'token.proposal_list_limit_unset'
      /**
       * listStakes page size unset. Blank / non-finite / <1 refuses.
       * Never invent 50.
       */
      | 'token.stakes_list_limit_unset'
      /**
       * Close refused because TOKEN_GOVERNANCE_QUORUM_BPS and/or
       * TOKEN_GOVERNANCE_THRESHOLD_BPS is blank. Never invent a bar.
       */
      | 'token.governance_quorum_unset'
      /**
       * A ballot has no eligible-stake snapshot from cast time. Close must not
       * substitute a live pot sum, and must not treat the missing figure as
       * zero — zero eligible stake makes the quorum comparison vacuously true.
       */
      | 'token.governance_snapshot_missing'
      /**
       * Grant / listing close tallied but did not execute. Value does not move.
       */
      | 'token.governance_execute_unwired'
      /** `TOKEN_ASSET_ID` is only the env.ts default. A preview must not price an unpublished asset. */
      | 'token.staking_asset_unpublished'
      /** Tier is not one of flex / m3 / m12. */
      | 'token.stake_tier_unknown'
      /** Stake amount is zero or negative. The stake path refuses the same. */
      | 'token.stake_amount_invalid'
      /** History page size unset. Blank / non-finite / <1 refuses. Never invent 50. */
      | 'token.history_list_limit_unset'
      /** Opaque history cursor did not decode. */
      | 'token.history_cursor_invalid'
      /** How many future epochs to project. Blank refuses. Never invent a length. */
      | 'token.emission_schedule_count_unset'
      /**
       * A payout row has no matching ledger transaction, or the transaction
       * disagrees with the stored id. The table amount is not a substitute.
       */
      | 'token.ledger_tx_unread'
      /** Delegate target omitted or blank. Not stored as a self-delegation. */
      | 'token.delegation_delegatee_unset'
      /** Target is not a member id. A chain address is not accepted in its place. */
      | 'token.delegation_delegatee_invalid'
      /**
       * No chain service and no on-chain delegate registry (`no_chain_service`).
       * Nothing is written, including when the target is the caller.
       * `blocker` names that protocol blocker.
       */
      | 'token.delegation_unavailable'
      /**
       * A treasury total was blank, negative, or paired with a count that
       * does not match. Not replaced with zero.
       */
      | 'token.treasury_figure_unreadable'
      | 'token.vote_history_unreadable'
      /** Stored proposer rule is blank. Never fall back to a compiled stake tier. */
      | 'token.proposer_rule_unset'
      /** Per-period proposal cap or its period is blank. Never invent a window. */
      | 'token.proposal_limit_unset'
      /** The author is already at the published cap for this period. */
      | 'token.proposal_limit_reached'
      /** An open (or later) proposal is not edited. Only a draft is. */
      | 'token.proposal_not_editable'
      /** Title was sent and it is empty. Omitting the title is the legacy create. */
      | 'token.proposal_title_invalid'
      /** Stored request handle missing or not usable. The proposal id is not a client uuid. */
      | 'token.proposal_handle_invalid'
      /** A ballot does not fit its proposal's voting type or choice list (MC-token-03). Nothing is stored. */
      | 'token.ballot_invalid'
      /** A voting type this service does not tally. */
      | 'token.voting_type_unsupported'
      /** Who may vote is blank (`TOKEN_VOTE_RULE`). Never a default. */
      | 'token.vote_rule_unset'
      /** The account's power at the proposal's snapshot is below the published vote rule. */
      | 'token.vote_rule_not_met'
      /** A signed vote cannot be checked: identity is unreachable or unset, or the account has no linked wallet or may not act. Nothing is stored. */
      | 'token.signed_vote_unavailable'
      /** A vote arrived without a wallet signature. Unsigned votes are refused (OWNER 108). Nothing is stored. */
      | 'token.vote_signature_required'
      /** The signature is unreadable or not from a wallet linked to the account. Nothing is stored. */
      | 'token.vote_signature_invalid'
      /** Neither proposal time was given and the governance voting delay or period is not set. Never a compiled default. */
      | 'token.proposal_window_unset'
      /** The account's governance role does not allow this. */
      | 'token.permission_denied'
      /** Not a governance role, the account already has it, or the account would grant its own role. */
      | 'token.role_invalid'
      /** The role moved since the revision the founders approved. Nothing is written. */
      | 'token.role_stale'
      /** A voting delay or period outside what the settings door stores. */
      | 'token.settings_invalid'
      /** The settings moved since the revision the founders approved. Nothing is written. */
      | 'token.settings_stale'
      /** A cancel without a reason of 12 to 500 characters. */
      | 'token.cancel_reason_invalid'
      /** Only a draft or open proposal is cancelled. */
      | 'token.proposal_not_cancellable',
    /** Set on `token.epoch_too_early`: how long until a new epoch may start, from the database clock. */
    readonly retryAfterMs?: number,
    /** Set on `token.params_unset`: the blank `token_params` column. Not a value. */
    readonly config?: string,
    /** Set on `token.delegation_unavailable`: the protocol blocker. Not a sentence. */
    readonly blocker?: 'no_chain_service',
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

/** Owner-published listProposals page size. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertProposalListLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new TokenError('Proposal list limit is unset', 'token.proposal_list_limit_unset');
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new TokenError('Proposal list limit is unset', 'token.proposal_list_limit_unset');
  }
  return Math.min(200, n);
}

/** Owner-published listStakes page size. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertStakesListLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new TokenError('Stake list limit is unset', 'token.stakes_list_limit_unset');
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new TokenError('Stake list limit is unset', 'token.stakes_list_limit_unset');
  }
  return Math.min(200, n);
}

/** Page size for owner history reads. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertHistoryListLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new TokenError('History list limit is unset', 'token.history_list_limit_unset');
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new TokenError('History list limit is unset', 'token.history_list_limit_unset');
  }
  return Math.min(200, n);
}

/** How many epochs `emissionSchedule` projects. Blank refuses. Never invent a length. */
export function assertEmissionScheduleCount(count: number | undefined): number {
  if (count === undefined || typeof count !== 'number' || !Number.isFinite(count)) {
    throw new TokenError('Emission schedule length is unset', 'token.emission_schedule_count_unset');
  }
  const n = Math.floor(count);
  if (n < 1) {
    throw new TokenError('Emission schedule length is unset', 'token.emission_schedule_count_unset');
  }
  return Math.min(200, n);
}

const HISTORY_CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export interface HistoryCursor {
  readonly at: string;
  readonly key: string;
}

/** Opaque keyset cursor. `at` is the database microsecond timestamp, not a JS Date. */
export function encodeHistoryCursor(at: string, key: string): string {
  return Buffer.from(JSON.stringify({ v: 1, at, key }), 'utf8').toString('base64url');
}

export function decodeHistoryCursor(raw: string): HistoryCursor {
  if (raw.length < 1 || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new TokenError('History cursor is not valid', 'token.history_cursor_invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new TokenError('History cursor is not valid', 'token.history_cursor_invalid');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new TokenError('History cursor is not valid', 'token.history_cursor_invalid');
  }
  const { v, at, key } = parsed as { v?: unknown; at?: unknown; key?: unknown };
  if (v !== 1 || typeof at !== 'string' || !HISTORY_CURSOR_AT.test(at)) {
    throw new TokenError('History cursor is not valid', 'token.history_cursor_invalid');
  }
  if (typeof key !== 'string' || key.length < 1 || key.length > 128) {
    throw new TokenError('History cursor is not valid', 'token.history_cursor_invalid');
  }
  return { at, key };
}

export interface StakePreview {
  readonly tier: StakeTier;
  readonly unlocksAt: string | null;
  readonly multiplierBps: number;
  readonly effectiveWeight: string;
}

/**
 * What `stake` will store for this amount and tier at `at`.
 *
 * Pure: no row, no ledger post. Unlock and multiplier are `unlockDate` and
 * `STAKE_TIERS`, the same calls `claimStakePending` makes. Weight is
 * `stakeWeight`, the same function yield and governance use. An unknown tier
 * or an unpublished staking asset refuses. No penalty and no early exit.
 */
export function previewStakeTerms(input: { amount: Amount; tier: string; at: Date; stakingAssetPublished: boolean }): StakePreview {
  if (!input.stakingAssetPublished) {
    throw new TokenError('Staking asset is not published', 'token.staking_asset_unpublished');
  }
  if (!Object.hasOwn(STAKE_TIERS, input.tier)) {
    throw new TokenError(`Unknown stake tier "${input.tier}"`, 'token.stake_tier_unknown');
  }
  if (input.amount <= 0n) {
    throw new TokenError('Stake amount must be positive', 'token.stake_amount_invalid');
  }
  const tier = input.tier as StakeTier;
  const unlocksAt = unlockDate(tier, input.at);
  return {
    tier,
    unlocksAt: unlocksAt === null ? null : unlocksAt.toISOString(),
    multiplierBps: STAKE_TIERS[tier].multiplierBps,
    effectiveWeight: formatAmount(stakeWeight(input.amount, tier)),
  };
}

export interface UnstakePreview {
  /** `locked_until` while `unstake` would refuse `token.stake_locked` for the lock. */
  readonly status: 'locked_until' | 'ready' | 'closing' | 'pending' | 'closed';
  readonly unlocksAt: string | null;
  readonly amount: string;
  /**
   * What `unstake` does once the lock has passed: return the full principal.
   * Null when today's path refuses and does not return principal (pending, closed).
   * There is no penalty and no early-exit amount.
   */
  readonly afterUnlock: 'full_principal' | null;
  readonly refusal: 'token.stake_locked' | 'token.stake_closed' | null;
}

export interface PayoutHistoryItem {
  readonly windowId: string;
  readonly amount: string | null;
  readonly assetId: string | null;
  readonly ledgerTxId: string | null;
  /** Set when the ledger transaction could not be read. The table amount is not used. */
  readonly reason: 'ledger_tx_unread' | null;
}

export interface PayoutHistoryPage {
  readonly items: PayoutHistoryItem[];
  readonly nextCursor: string | null;
}

export type VoteHistoryItem = {
  readonly proposalId: string;
  readonly title: string | null;
  readonly titleReason: 'proposal_title_unset' | null;
  /** The proposal's voting type, so an approval and a ranked `pick` read apart. */
  readonly votingType: VotingType;
  /** Weight stored on the ballot. Never recomputed from a later stake. */
  readonly weight: string;
  readonly castAt: string;
} & (
  | { readonly choice: 'for' | 'against' | 'abstain'; readonly ballot: null }
  /** A non-basic ballot as stored (approval, weighted, ranked and the rest); choice is null. */
  | { readonly choice: null; readonly ballot: Ballot }
);

export interface VoteHistoryPage {
  readonly items: VoteHistoryItem[];
  readonly nextCursor: string | null;
}

export interface EmissionScheduleView {
  readonly params: {
    readonly initialEpochReward: string;
    readonly halvingIntervalEpochs: number;
    readonly maxSupply: string;
  } | null;
  readonly epochs: Array<{ readonly epoch: number; readonly reward: string }> | null;
  readonly missing: string | null;
  readonly reason: 'token.params_unset' | 'token.params_missing' | 'token.params_invalid' | null;
}

/**
 * Lifecycle of a buyback run (0002).
 *
 * `pending` means the run owns its revenue window but its burn is not yet on
 * the ledger. It exists so the window can be claimed BEFORE the irreversible
 * leg posts — the same reason `token.stakes` has a `pending` status.
 */
export type BuybackRunStatus = 'pending' | 'settled';

/** §4.3 proposal surface — what an IFC-weighted vote may decide. */
export type ProposalKind = 'listing' | 'fee_param' | 'curriculum' | 'grant';
export type ProposalStatus = 'draft' | 'open' | 'passed' | 'rejected' | 'executed' | 'cancelled' | 'closed_ranked';
export type VoteChoice = 'for' | 'against' | 'abstain';

export interface ProposalCounts {
  votes: number;
  for: number;
  against: number;
  abstain: number;
}

export interface ProposalRecord {
  id: string;
  kind: ProposalKind;
  body: Record<string, unknown>;
  status: ProposalStatus;
  opensAt: Date;
  closesAt: Date;
  createdAt: Date;
  title: string | null;
  bodyMd: string | null;
  discussionLink: string | null;
  /** `gov:proposal:<space>:<author>:<n>`. Null on rows from before this column. */
  businessKey: string | null;
  authorId: string | null;
  revision: number;
  /** `basic` is for/against/abstain. Other types carry a choice list (MC-token-03). */
  votingType: VotingType;
  choices: string[] | null;
  /** Seal of the voting power measured at creation. Null on proposals from before the snapshot. */
  snapshot: SnapshotSeal | null;
  /** Written when a non-basic proposal closes (`closed_ranked`). */
  ranking: number[] | null;
  /** Written when a governance moderator, admin or controller cancels it (MC-token-02). Its votes stay. */
  cancel: { reason: string; at: Date } | null;
  counts: ProposalCounts;
}

export interface VoteRecord {
  id: string;
  proposalId: string;
  userId: string;
  /** The account's power from the proposal's snapshot (or, before snapshots, at cast time). */
  weight: Amount;
  /** Null when `ballot` holds a non-basic vote. */
  choice: VoteChoice | null;
  ballot: Ballot | null;
  castAt: Date;
  /** The linked wallet whose signature was checked when the vote was recorded, lower-case. */
  signedBy: string;
}

export interface ProposalTally {
  forWeight: Amount;
  againstWeight: Amount;
  abstainWeight: Amount;
  totalWeight: Amount;
  voterCount: number;
}

/** The vote rule as read now: a minimum, or the code every vote is refused with. */
export interface VoteRuleState {
  minPower: Amount | null;
  code: TokenError['code'] | null;
}

export interface ProposalDetail extends ProposalRecord {
  tally: ProposalTally;
  /** Per-choice totals and ranking for a non-basic type. Null on `basic`. */
  choiceTally: ChoiceTally | null;
}

export interface ProposalCloseResult extends ProposalDetail {
  /** `token.governance_execute_unwired` for grant/listing — never a ledger post. */
  execute: typeof GOVERNANCE_EXECUTE_UNWIRED | null;
}

export interface TokenServiceOptions {
  assetId?: string;
  /**
   * Test override. Production loads emission from `token_params` (T-02).
   * When `loadParamsFromDb` is false, this is required.
   */
  emission?: EmissionParams;
  /**
   * Test override. Production loads buyback from `token_params` (T-02).
   * When `loadParamsFromDb` is false, this is required.
   */
  buyback?: BuybackParams;
  /**
   * How long a loaded fee-discount schedule stays good, in ms (default 60s).
   *
   * The schedule is a governed row that changes on the order of months, and `accessOf` is on
   * every gate in the OS — re-reading it per call would be a query per gate. A minute is the
   * lag a `fee_param` proposal takes to reach traffic, which is well inside the window
   * governance already operates on. 0 disables the cache, which is what the tests use.
   */
  feeScheduleTtlMs?: number;
  /**
   * Production default true: buyback + emission params come from `token_params`.
   * Tests set false and inject `emission` / `buyback` so pure service tests need no DB row.
   */
  loadParamsFromDb?: boolean;
  /**
   * Owner quorum in bps (0..=10000). Missing → close refuses
   * `token.governance_quorum_unset`. Never defaulted here.
   */
  governanceQuorumBps?: number;
  /**
   * Owner for-threshold in bps of (for+against). Missing → same refuse.
   */
  governanceThresholdBps?: number;
  /**
   * Emission epoch length in ms — the minimum gap between one epoch being
   * claimed and the next NEW epoch starting (`token.epoch_too_early`). Default
   * one day (owner-present, Nitro's pick 2026-10-14). `0` switches the gate off:
   * for tests that walk many epochs in a row, never for a deployment (env.ts
   * only accepts positive integers). Reward, cap and halving are not set here.
   */
  emissionEpochMs?: number;
  /**
   * Who may vote (`TOKEN_VOTE_RULE`, `power:<decimal>`). Read on every vote;
   * blank refuses `token.vote_rule_unset`. Never defaulted here.
   */
  voteRule?: string;
  /**
   * Checks a vote's wallet signature with identity (vote-signature.ts). Missing refuses every vote
   * `token.signed_vote_unavailable`; never treated as verified.
   */
  voteSignatures?: VoteSignaturePort;
}

/** One day. Epoch length is owner-decided (2026-10-14); reward / cap / halving stay unset. */
export const DEFAULT_EMISSION_EPOCH_MS = 86_400_000;

/** "1d 2h 3m 4s" — whole units, largest non-zero first, for refusal copy. */
function describeDuration(ms: number): string {
  const total = Math.max(1, Math.ceil(ms / 1000));
  const units: Array<[string, number]> = [
    ['d', Math.floor(total / 86_400)],
    ['h', Math.floor((total % 86_400) / 3_600)],
    ['m', Math.floor((total % 3_600) / 60)],
    ['s', total % 60],
  ];
  return units
    .filter(([, n]) => n > 0)
    .map(([u, n]) => `${n}${u}`)
    .join(' ');
}

/** One frozen line of a yield window's plan: who is owed what, and whether it has posted. */
export interface YieldPlanRow {
  userId: string;
  amount: Amount;
  /** Null until the `rewardPay` for this row has returned. */
  ledgerTxId: string | null;
}

export interface YieldRunResult {
  windowId: string;
  /** Value moved BY THIS RUN. A re-run that posts nothing reports zero. */
  distributed: Amount;
  /** Stakers paid BY THIS RUN. */
  recipients: number;
  /** Stakers whose share rounded to nothing when the window was planned. */
  skipped: number;
  /** Planned rows this run found already posted — the resumability signal. */
  alreadyPaid: number;
}

export interface BuybackRunResult {
  runId: string;
  tokensBought: Amount;
  burned: Amount;
  toRewards: Amount;
}

export interface StakeRecord {
  id: string;
  userId: string;
  amount: Amount;
  tier: StakeTier;
  startedAt: Date;
  unlocksAt: Date | null;
  /** `pending` = claim row not yet funded; shown so clients can retry the same stakeId. */
  status: 'pending' | 'active' | 'unstaking' | 'closed';
}

function proposalTitle(body: unknown): { title: string | null; reason: 'proposal_title_unset' | null } {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const title = (body as Record<string, unknown>).title;
    if (typeof title === 'string' && title.trim() !== '') return { title, reason: null };
  }
  return { title: null, reason: 'proposal_title_unset' };
}

/** NULL, whitespace, or `{}` — an undecided ladder, not a zero discount. */
/** The stored fee-decay column as it is; a missing singleton row refuses. */
async function readFeeDiscountRow(sql: Sql, opts: { forUpdate?: boolean } = {}): Promise<unknown> {
  const rows = opts.forUpdate
    ? await sql<Array<{ fee_discount_schedule: unknown }>>`SELECT fee_discount_schedule FROM token.token_params WHERE id = true FOR UPDATE`
    : await sql<Array<{ fee_discount_schedule: unknown }>>`SELECT fee_discount_schedule FROM token.token_params WHERE id = true`;
  if (rows.length === 0) throw new TokenError('token_params singleton row is missing — run migrations', 'token.params_missing');
  return rows[0]!.fee_discount_schedule;
}

/**
 * The ladder the owner proposed, as the publish door would store it, or `token.fee_discount_invalid` naming the step
 * that is wrong. The router calls this before it consumes the founders' approval, so a ladder the door refuses does not
 * spend one.
 */
export function feeDiscountLadderToPublish(raw: unknown): PublishedFeeDiscountSchedule {
  try {
    return publishableFeeDiscountSchedule(raw);
  } catch (err) {
    if (err instanceof RangeError || err instanceof MoneyError) throw new TokenError(err.message, 'token.fee_discount_invalid');
    throw err;
  }
}

/** Blank operator config. `config` is the column name; no value is invented. */
function throwParamsUnset(config: string): never {
  throw new TokenError(`${config} is unset`, 'token.params_unset', undefined, config);
}

/**
 * A pending buyback claim is released only this long after the last burn/post
 * attempt (`last_post_at`, database clock): longer than the ledger client's
 * 25 s post deadline plus the ledger's 15 s lock wait, so a late burn has
 * landed or died. The claim's `created_at` is not this clock.
 */
const BUYBACK_QUIET_SECONDS = 120;

export class TokenService {
  private readonly assetId: string;
  private readonly feeScheduleTtlMs: number;
  private readonly loadParamsFromDb: boolean;
  private feeScheduleCache: { schedule: FeeDiscountSchedule; loadedAt: number } | null = null;
  /** Bumped by every publish, so a read that began before it does not cache the ladder it replaced. */
  private feeScheduleGeneration = 0;
  private buybackParamsCache: { params: BuybackParams; loadedAt: number } | null = null;
  private readonly emissionEpochMs: number;
  private emissionParamsCache: { params: EmissionParams; loadedAt: number } | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    private readonly bus: EventBus,
    private readonly options: TokenServiceOptions,
  ) {
    this.assetId = options.assetId ?? 'IFC';
    this.feeScheduleTtlMs = options.feeScheduleTtlMs ?? 60_000;
    this.loadParamsFromDb = options.loadParamsFromDb !== false;
    this.emissionEpochMs = options.emissionEpochMs ?? DEFAULT_EMISSION_EPOCH_MS;
    if (!Number.isSafeInteger(this.emissionEpochMs) || this.emissionEpochMs < 0) {
      throw new Error('TokenService emissionEpochMs must be a non-negative integer (0 = gate off, tests only)');
    }
    if (!this.loadParamsFromDb) {
      if (!options.emission || !options.buyback) {
        throw new Error('TokenService test mode requires emission and buyback overrides when loadParamsFromDb is false');
      }
    }
  }

  // ── Staking (§4.3) ─────────────────────────────────────────────────────────

  /**
   * Open a stake.
   *
   * L3-2 ordering: **claim `pending` row → ledger post → activate**.
   *
   * - `pending` is not counted by `stakeOf` and is not yield-eligible, so a
   *   claim without funding cannot create an unfunded obligation.
   * - Ledger post is idempotent on `stakeId`; retry after a crash mid-flight
   *   re-posts (no-op) and activates.
   * - If the ledger **confirms** a refuse (insufficient funds), the pending
   *   row is deleted so we leave no stake record behind — same guarantee the
   *   old ledger-first path advertised, without the crash window of
   *   "money moved, no row".
   * - Ambiguous ledger failures (timeout, transport error after apply) must
   *   **leave** the pending claim. Deleting on every catch creates
   *   post-without-claim: principal locked in the stake account with no row
   *   to unstake. The same stakeId retry is the recovery path (M-02).
   *
   * `stakeId` is the caller-stable retry key. Omit used to mint a UUID so a
   * retry without a client id staked twice (ledger keys on stakeId). Refuse
   * rather than invent an id a retry cannot reuse.
   */
  async stake(input: { userId: string; amount: Amount; tier: StakeTier; stakeId: string }): Promise<StakeRecord> {
    const stakeId = input.stakeId?.trim() ?? '';
    if (!stakeId) {
      throw new TokenError('stakeId is required; a stake does not mint one', 'token.stake_id_required');
    }

    return withMoneySpan(
      'token.stake',
      { operation: 'stake', userId: input.userId, amount: formatAmount(input.amount), tier: input.tier },
      async () => {
        const startedAt = new Date();
        const unlocksAt = unlockDate(input.tier, startedAt);

        // Claim-before-post: insert pending, or on conflict re-load and refuse
        // amount/user/tier mismatches (same class as pay.deposit_conflict).
        // Never post the caller's amount against another row's identity.
        const claimed = await this.claimStakePending({
          stakeId,
          userId: input.userId,
          amount: input.amount,
          tier: input.tier,
          startedAt,
          unlocksAt,
        });

        if (claimed.status === 'active' || claimed.status === 'unstaking' || claimed.status === 'closed') {
          // Exact retry of an already-finished stake — return the book row, do not re-post.
          return claimed;
        }

        try {
          await this.ledger.post(
            recipes.stake({
              stakeId: claimed.id,
              userId: claimed.userId,
              assetId: this.assetId,
              amount: claimed.amount,
              tier: claimed.tier,
            }),
          );
        } catch (err) {
          // Delete only on confirmed insufficient funds. Any other error may
          // have applied under `token.stake:${id}` — keep the pending row so
          // retry activates (M-02) instead of orphaning principal.
          if (err instanceof InsufficientFundsError) {
            await this.sql`
              DELETE FROM token.stakes WHERE id = ${claimed.id} AND status = 'pending'
            `;
          }
          throw err;
        }

        const activated = await this.sql<
          Array<{
            id: string;
            user_id: string;
            amount: string;
            tier: StakeTier;
            started_at: Date;
            unlocks_at: Date | null;
            status: string;
          }>
        >`
          UPDATE token.stakes SET status = 'active' WHERE id = ${claimed.id} AND status = 'pending'
          RETURNING id, user_id, amount, tier, started_at, unlocks_at, status
        `;

        if (!activated[0]) {
          // Concurrent activate won, or the claim was deleted under us.
          // Never invent status:'active' for a missing row.
          const existing = await this.getStake(claimed.id);
          if (existing && (existing.status === 'active' || existing.status === 'unstaking' || existing.status === 'closed')) {
            return existing;
          }
          throw new TokenError(
            `Stake claim ${claimed.id} vanished after the ledger post — principal may still be in the stake account; retry the same stakeId or reconcile, do not invent a new claim`,
            'token.stake_claim_missing',
          );
        }

        const row = activated[0];

        await this.bus.publish(
          'stakeCreated',
          {
            stakeId: row.id,
            userId: row.user_id,
            amount: formatAmount(parseAmount(row.amount)),
            tier: row.tier,
            unlocksAt: row.unlocks_at?.toISOString() ?? null,
          },
          { idempotencyKey: `token.stake:${row.id}` },
        );

        return {
          id: row.id,
          userId: row.user_id,
          amount: parseAmount(row.amount),
          tier: row.tier,
          startedAt: row.started_at,
          unlocksAt: row.unlocks_at,
          status: 'active' as const,
        };
      },
    );
  }

  /**
   * Insert a pending stake claim, or load the existing row on retry.
   * Mismatched user/amount/tier on the same stakeId is a hard conflict.
   */
  private async claimStakePending(input: {
    stakeId: string;
    userId: string;
    amount: Amount;
    tier: StakeTier;
    startedAt: Date;
    unlocksAt: Date | null;
  }): Promise<StakeRecord> {
    const inserted = await this.sql<
      Array<{ id: string; user_id: string; amount: string; tier: StakeTier; started_at: Date; unlocks_at: Date | null; status: string }>
    >`
      INSERT INTO token.stakes (id, user_id, amount, tier, multiplier_bps, started_at, unlocks_at, status)
      VALUES (
        ${input.stakeId}, ${input.userId}, ${formatAmount(input.amount)}::numeric, ${input.tier},
        ${STAKE_TIERS[input.tier].multiplierBps}, ${input.startedAt}, ${input.unlocksAt}, 'pending'
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id, user_id, amount, tier, started_at, unlocks_at, status
    `;
    if (inserted[0]) {
      const row = inserted[0];
      return {
        id: row.id,
        userId: row.user_id,
        amount: parseAmount(row.amount),
        tier: row.tier,
        startedAt: row.started_at,
        unlocksAt: row.unlocks_at,
        status: row.status as StakeRecord['status'],
      };
    }

    const rows = await this.sql<
      Array<{ id: string; user_id: string; amount: string; tier: StakeTier; started_at: Date; unlocks_at: Date | null; status: string }>
    >`
      SELECT id, user_id, amount, tier, started_at, unlocks_at, status
        FROM token.stakes WHERE id = ${input.stakeId} FOR UPDATE
    `;
    const existing = rows[0];
    if (!existing) {
      throw new TokenError(`Stake ${input.stakeId} disappeared after conflict`, 'token.stake_not_found');
    }

    const amount = parseAmount(existing.amount);
    const mismatch = existing.user_id !== input.userId || amount !== input.amount || existing.tier !== input.tier;
    if (mismatch) {
      throw new TokenError(
        `Stake ${input.stakeId} was already claimed as ${formatAmount(amount)} ${existing.tier} by ${existing.user_id}`,
        'token.stake_conflict',
      );
    }

    return {
      id: existing.id,
      userId: existing.user_id,
      amount,
      tier: existing.tier,
      startedAt: existing.started_at,
      unlocksAt: existing.unlocks_at,
      status: existing.status as StakeRecord['status'],
    };
  }

  /**
   * Close a stake and return the principal.
   *
   * The lock is enforced here AND the row is locked for the duration, so two
   * concurrent unstake calls cannot both post to the ledger. Without the row
   * lock the ledger's idempotency key would catch the double-post — but the
   * caller would get an inconsistent answer, and relying on the last line of
   * defence for ordinary correctness is how the last line stops being one.
   */
  async unstake(stakeId: string, now: Date = new Date()): Promise<StakeRecord> {
    return withMoneySpan('token.unstake', { operation: 'unstake' }, async () => this.unstakeInner(stakeId, now));
  }

  /**
   * Close a stake: **claim `unstaking` → ledger unstake → `closed`** (M-04).
   *
   * Ledger-first left a window where principal was already available while
   * stakeOf still counted the row. Claiming `unstaking` first (short txn)
   * drops the row from stakeOf (active-only) before the ledger moves.
   * Ledger key `token.unstake:${stakeId}` makes crash mid-flight retry-safe.
   * Never hold FOR UPDATE across a remote ledger.post.
   *
   * The pot must equal the table amount before the row is claimed `unstaking`.
   * A mismatch is `token.stake_ledger_mismatch`: nothing is posted and the row
   * stays active. The table figure is not a partial unstake, and the
   * difference is not a sweep.
   */
  private async unstakeInner(stakeId: string, now: Date): Promise<StakeRecord> {
    const claimed = await transaction(
      this.sql,
      async (tx) => {
        const rows = await tx<
          Array<{ id: string; user_id: string; amount: string; tier: StakeTier; started_at: Date; unlocks_at: Date | null; status: string }>
        >`
          SELECT id, user_id, amount, tier, started_at, unlocks_at, status
            FROM token.stakes WHERE id = ${stakeId} FOR UPDATE
        `;

        const row = rows[0];
        if (!row) throw new TokenError(`Stake ${stakeId} not found`, 'token.stake_not_found');
        if (row.status === 'closed') throw new TokenError('Stake is already closed', 'token.stake_closed');
        if (row.status === 'pending') {
          throw new TokenError('Stake is still pending funding — cannot unstake', 'token.stake_locked');
        }
        if (row.status !== 'active' && row.status !== 'unstaking') {
          throw new TokenError(`Stake is not unstakable (status=${row.status})`, 'token.stake_closed');
        }

        if (row.status === 'active' && !isUnlocked(row.tier, row.started_at, now)) {
          throw new TokenError(`Stake is locked until ${row.unlocks_at?.toISOString() ?? 'unlock'} (${row.tier})`, 'token.stake_locked');
        }

        // An ACTIVE row may only be claimed when its pot matches. Once the
        // immutable intent is UNSTAKING, a prior post may already have moved
        // the pot and lost its acknowledgement. Re-submit the same recipe
        // from the persisted row terms; the ledger idempotency key returns the
        // original post, while a genuinely absent post must still pass its
        // balance check before the row can close.
        const recorded = parseAmount(row.amount);
        const book = (await this.ledger.balance(tokenStakeAccount(row.user_id, this.assetId, row.id))).amount;
        const retryingCommittedUnstake = row.status === 'unstaking' && book === 0n;
        if (book !== recorded && !retryingCommittedUnstake) {
          throw new TokenError(
            `Stake ${row.id} table amount ${formatAmount(recorded)} disagrees with ledger ${formatAmount(book)}`,
            'token.stake_ledger_mismatch',
          );
        }

        if (row.status === 'active') {
          await tx`UPDATE token.stakes SET status = 'unstaking' WHERE id = ${stakeId} AND status = 'active'`;
        }

        return {
          id: stakeId,
          userId: row.user_id,
          amount: parseAmount(row.amount),
          tier: row.tier,
          startedAt: row.started_at,
          unlocksAt: row.unlocks_at,
        };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );

    await this.ledger.post(
      recipes.unstake({
        stakeId: claimed.id,
        userId: claimed.userId,
        assetId: this.assetId,
        amount: claimed.amount,
        tier: claimed.tier,
      }),
    );

    // Close is conditional so concurrent unstakes cannot both report success.
    // Ledger key is idempotent (second post is a no-op); only one UPDATE from
    // `unstaking` → `closed` may win. Losers see 0 rows and refuse — crash
    // recovery still works: a lone retry on an `unstaking` row posts (no-op if
    // already applied) and closes.
    const closed = await this.sql<
      Array<{ id: string; user_id: string; amount: string; tier: StakeTier; started_at: Date; unlocks_at: Date | null; status: string }>
    >`
      UPDATE token.stakes
         SET status = 'closed'
       WHERE id = ${claimed.id} AND status = 'unstaking'
   RETURNING id, user_id, amount, tier, started_at, unlocks_at, status
    `;

    if (closed.length === 0) {
      throw new TokenError('Stake is already closed', 'token.stake_closed');
    }

    const done = closed[0]!;
    return {
      id: done.id,
      userId: done.user_id,
      amount: parseAmount(done.amount),
      tier: done.tier,
      startedAt: done.started_at,
      unlocksAt: done.unlocks_at,
      status: 'closed' as const,
    };
  }

  /**
   * Total active stake for a user — the number every other module gates on
   * (§4.3: launchpad allocations, OTC access, premium lobbies, vendor slots).
   *
   * The book is ledger-client `tokenStakeAccount` balances. `token.stakes` is
   * the claim index (who, tier, lock). If a row's amount disagrees with its
   * pot, refuse — do not grant access or fee discount off the table.
   * Pending / unstaking rows stay out of the index (crash windows stay closed).
   */
  async stakeOf(userId: string): Promise<Amount> {
    return this.stakeOfOn(this.sql, userId);
  }

  /**
   * Ledger-backed active stake using the caller's sql. `castVote` must pass
   * the open `tx` — `this.sql` inside FOR UPDATE takes a second pool slot and
   * deadlocks under concurrent ballots.
   */
  private async stakeOfOn(sql: Sql, userId: string): Promise<Amount> {
    const rows = await sql<Array<{ id: string; amount: string }>>`
      SELECT id, amount FROM token.stakes WHERE user_id = ${userId} AND status = 'active' ORDER BY id
    `;
    let total: Amount = 0n;
    for (const row of rows) {
      const recorded = parseAmount(row.amount);
      const book = (await this.ledger.balance(tokenStakeAccount(userId, this.assetId, row.id))).amount;
      if (book !== recorded) {
        throw new TokenError(
          `Stake ${row.id} table amount ${formatAmount(recorded)} disagrees with ledger ${formatAmount(book)}`,
          'token.stake_ledger_mismatch',
        );
      }
      total += book;
    }
    return total;
  }

  /**
   * Active stake locked in id order, read from ledger pots.
   *
   * One read is the ballot weight and the electorate that weight was a share
   * of. Both are written on the vote. Close uses the stored electorate, so a
   * later unstake cannot shrink the quorum bar and a stake opened after the
   * window cannot raise it.
   */
  private async snapshotActiveStake(sql: Sql): Promise<{ total: Amount; byUser: Map<string, Amount> }> {
    const rows = await sql<Array<{ id: string; user_id: string; amount: string }>>`
      SELECT id, user_id, amount
        FROM token.stakes
       WHERE status = 'active'
       ORDER BY id
       FOR UPDATE
    `;
    const byUser = new Map<string, Amount>();
    let total: Amount = 0n;
    for (const row of rows) {
      const recorded = parseAmount(row.amount);
      const book = (await this.ledger.balance(tokenStakeAccount(row.user_id, this.assetId, row.id))).amount;
      if (book !== recorded) {
        throw new TokenError(
          `Stake ${row.id} table amount ${formatAmount(recorded)} disagrees with ledger ${formatAmount(book)}`,
          'token.stake_ledger_mismatch',
        );
      }
      total += book;
      byUser.set(row.user_id, (byUser.get(row.user_id) ?? 0n) + book);
    }
    return { total, byUser };
  }

  /** One stake by id — used by the router to enforce ownership before unstake. */
  async getStake(stakeId: string): Promise<StakeRecord | null> {
    const rows = await this.sql<
      Array<{ id: string; user_id: string; amount: string; tier: StakeTier; started_at: Date; unlocks_at: Date | null; status: string }>
    >`
      SELECT id, user_id, amount, tier, started_at, unlocks_at, status
        FROM token.stakes WHERE id = ${stakeId}
    `;
    const row = rows[0];
    if (!row) return null;
    // Include `pending` so a client can discover an in-flight claim and retry
    // the same stakeId (M-02 recovery). Unstake still refuses non-active rows.
    if (row.status !== 'active' && row.status !== 'unstaking' && row.status !== 'closed' && row.status !== 'pending') {
      return null;
    }
    return {
      id: row.id,
      userId: row.user_id,
      amount: parseAmount(row.amount),
      tier: row.tier,
      startedAt: row.started_at,
      unlocksAt: row.unlocks_at,
      status: row.status as StakeRecord['status'],
    };
  }

  /**
   * Stakes owned by a user. Defaults to active only.
   * `all` includes pending so a crash mid-stake is visible for retry (M-02).
   * Page size is refuse-closed when unset — never invent 50.
   */
  async listStakes(userId: string, status: 'active' | 'closed' | 'pending' | 'all' = 'active', limit?: number): Promise<StakeRecord[]> {
    const page = assertStakesListLimit(limit);
    const rows =
      status === 'all'
        ? await this.sql<
            Array<{
              id: string;
              user_id: string;
              amount: string;
              tier: StakeTier;
              started_at: Date;
              unlocks_at: Date | null;
              status: string;
            }>
          >`
            SELECT id, user_id, amount, tier, started_at, unlocks_at, status
              FROM token.stakes
             WHERE user_id = ${userId} AND status IN ('pending', 'active', 'unstaking', 'closed')
             ORDER BY started_at DESC, id ASC
             LIMIT ${page}
          `
        : await this.sql<
            Array<{
              id: string;
              user_id: string;
              amount: string;
              tier: StakeTier;
              started_at: Date;
              unlocks_at: Date | null;
              status: string;
            }>
          >`
            SELECT id, user_id, amount, tier, started_at, unlocks_at, status
              FROM token.stakes
             WHERE user_id = ${userId} AND status = ${status}
             ORDER BY started_at DESC, id ASC
             LIMIT ${page}
          `;

    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      amount: parseAmount(row.amount),
      tier: row.tier,
      startedAt: row.started_at,
      unlocksAt: row.unlocks_at,
      status: row.status as StakeRecord['status'],
    }));
  }

  /**
   * Stake terms for an amount that has not been written.
   * `stakingAssetPublished` is the caller's read of the environment, not the
   * zod default. Writes nothing.
   */
  previewStake(input: { amount: Amount; tier: string; at?: Date; stakingAssetPublished: boolean }): StakePreview {
    return previewStakeTerms({
      amount: input.amount,
      tier: input.tier,
      at: input.at ?? new Date(),
      stakingAssetPublished: input.stakingAssetPublished,
    });
  }

  /**
   * What `unstake` would do for this owner's stake. Reads one row. Writes nothing.
   * Another user's id is `token.stake_not_found` — the row is not confirmed.
   * A lock reports `locked_until` and the unlock time. After that instant the
   * service returns the full principal. No penalty and no early-exit path.
   */
  async previewUnstake(stakeId: string, userId: string, now: Date = new Date()): Promise<UnstakePreview> {
    const rows = await this.sql<
      Array<{
        id: string;
        user_id: string;
        amount: string;
        tier: StakeTier;
        started_at: Date;
        unlocks_at: Date | null;
        status: string;
      }>
    >`
      SELECT id, user_id, amount, tier, started_at, unlocks_at, status
        FROM token.stakes WHERE id = ${stakeId}
    `;
    const row = rows[0];
    if (!row || row.user_id !== userId) {
      throw new TokenError(`Stake ${stakeId} not found`, 'token.stake_not_found');
    }
    if (row.status !== 'active' && row.status !== 'unstaking' && row.status !== 'closed' && row.status !== 'pending') {
      throw new TokenError(`Stake ${stakeId} not found`, 'token.stake_not_found');
    }

    const amount = formatAmount(parseAmount(row.amount));
    const unlocksAt = row.unlocks_at ? row.unlocks_at.toISOString() : null;

    if (row.status === 'closed') {
      return { status: 'closed', unlocksAt, amount, afterUnlock: null, refusal: 'token.stake_closed' };
    }
    if (row.status === 'pending') {
      return { status: 'pending', unlocksAt, amount, afterUnlock: null, refusal: 'token.stake_locked' };
    }
    if (row.status === 'unstaking') {
      return { status: 'closing', unlocksAt, amount, afterUnlock: 'full_principal', refusal: null };
    }
    if (!isUnlocked(row.tier, row.started_at, now)) {
      return { status: 'locked_until', unlocksAt, amount, afterUnlock: 'full_principal', refusal: 'token.stake_locked' };
    }
    return { status: 'ready', unlocksAt, amount, afterUnlock: 'full_principal', refusal: null };
  }

  /**
   * The caller's yield instructions, newest first. Amount and the ledger
   * reference are the `yield_payouts` row. The asset is the one this service
   * books; publication of that asset is `token.terms`, not this list.
   */
  async yieldHistory(userId: string, limit: number | undefined, cursor?: string): Promise<PayoutHistoryPage> {
    const page = await this.listOwnYieldRows(userId, limit, cursor);
    return {
      items: page.rows.map((row) => ({
        windowId: row.window_id,
        amount: formatAmount(parseAmount(row.amount)),
        assetId: this.assetId,
        ledgerTxId: row.ledger_tx_id,
        reason: null,
      })),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * The caller's revenue distributions. The value moved only as `rewardPay`
   * (`reward:yield:<window>:<user>`). The payout row is the index of windows;
   * the amount, asset and transaction id are read through ledger-client.
   * A missing transaction does not fall back to the table amount.
   */
  async revenueShareHistory(userId: string, limit: number | undefined, cursor?: string): Promise<PayoutHistoryPage> {
    const page = await this.listOwnYieldRows(userId, limit, cursor);
    const items: PayoutHistoryItem[] = [];
    for (const row of page.rows) {
      const tx = await this.ledger.getTxByKey(`reward:yield:${row.window_id}:${userId}`);
      const debit = tx?.entries.find((entry) => entry.direction === 'debit');
      const idAgrees = tx !== null && (row.ledger_tx_id === null || tx.id === row.ledger_tx_id);
      if (!tx || !debit || !idAgrees) {
        items.push({
          windowId: row.window_id,
          amount: null,
          assetId: null,
          ledgerTxId: null,
          reason: 'ledger_tx_unread',
        });
        continue;
      }
      items.push({
        windowId: row.window_id,
        amount: formatAmount(debit.amount),
        assetId: debit.assetId,
        ledgerTxId: tx.id,
        reason: null,
      });
    }
    return { items, nextCursor: page.nextCursor };
  }

  /**
   * The caller's ballots across proposals, newest first. Weight is the column
   * written at cast time. A later stake does not change it. Title is
   * `proposals.body.title` when that string is set; otherwise null.
   */
  async myVotes(userId: string, limit: number | undefined, cursor?: string): Promise<VoteHistoryPage> {
    const page = assertHistoryListLimit(limit);
    const mark = cursor === undefined ? null : decodeHistoryCursor(cursor);
    if (mark && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mark.key)) {
      throw new TokenError('History cursor is not valid', 'token.history_cursor_invalid');
    }
    const rows = await this.sql<
      Array<{
        proposal_id: string;
        body: unknown;
        voting_type: string;
        choice: 'for' | 'against' | 'abstain' | null;
        ballot: unknown;
        weight: string;
        cast_at: Date;
        cast_cursor: string;
        id: string;
      }>
    >`
      SELECT v.proposal_id, p.body, p.voting_type, v.choice, v.ballot, v.weight::text AS weight, v.cast_at, v.id,
             to_char(v.cast_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cast_cursor
        FROM token.governance_votes v
        JOIN token.proposals p ON p.id = v.proposal_id
       WHERE v.user_id = ${userId}
         ${mark ? this.sql`AND (v.cast_at, v.id) < (${mark.at}::timestamptz, ${mark.key}::uuid)` : this.sql``}
       ORDER BY v.cast_at DESC, v.id DESC
       LIMIT ${page + 1}
    `;
    const kept = rows.slice(0, page);
    const last = kept[kept.length - 1];
    return {
      items: kept.map((row): VoteHistoryItem => {
        const title = proposalTitle(row.body);
        const shared = {
          proposalId: row.proposal_id,
          title: title.title,
          titleReason: title.reason,
          votingType: storedVoteHistoryType(row.voting_type),
          weight: formatAmount(parseAmount(row.weight)),
          castAt: row.cast_at.toISOString(),
        };
        const ballot = storedVoteHistoryBallot(row.ballot);
        // The table holds exactly one of choice or ballot. A row with both or neither is unreadable, not guessed.
        if (row.choice !== null && ballot === null) return { ...shared, choice: row.choice, ballot: null };
        if (row.choice === null && ballot !== null) return { ...shared, choice: null, ballot };
        throw voteHistoryUnreadable();
      }),
      nextCursor: rows.length > page && last ? encodeHistoryCursor(last.cast_cursor, last.id) : null,
    };
  }

  private async listOwnYieldRows(
    userId: string,
    limit: number | undefined,
    cursor: string | undefined,
  ): Promise<{
    rows: Array<{ window_id: string; amount: string; ledger_tx_id: string | null; planned_cursor: string }>;
    nextCursor: string | null;
  }> {
    const page = assertHistoryListLimit(limit);
    const mark = cursor === undefined ? null : decodeHistoryCursor(cursor);
    const rows = await this.sql<Array<{ window_id: string; amount: string; ledger_tx_id: string | null; planned_cursor: string }>>`
      SELECT window_id, amount::text AS amount, ledger_tx_id,
             to_char(planned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS planned_cursor
        FROM token.yield_payouts
       WHERE user_id = ${userId}
         ${mark ? this.sql`AND (planned_at, window_id) < (${mark.at}::timestamptz, ${mark.key})` : this.sql``}
       ORDER BY planned_at DESC, window_id DESC
       LIMIT ${page + 1}
    `;
    const kept = rows.slice(0, page);
    const last = kept[kept.length - 1];
    return {
      rows: kept,
      nextCursor: rows.length > page && last ? encodeHistoryCursor(last.planned_cursor, last.window_id) : null,
    };
  }

  /**
   * The published fee-decay schedule (§4.3), read from `token_params`.
   *
   * The row is the authority, not `DEFAULT_FEE_DISCOUNT_SCHEDULE`. A blank
   * schedule refuses with `token.params_unset` and names
   * `token_params.fee_discount_schedule`. There is no fallback fee.
   */
  async feeDiscountSchedule(now: number = Date.now()): Promise<FeeDiscountSchedule> {
    const cached = this.feeScheduleCache;
    if (cached && this.feeScheduleTtlMs > 0 && now - cached.loadedAt < this.feeScheduleTtlMs) return cached.schedule;

    const generation = this.feeScheduleGeneration;
    const raw = await readFeeDiscountRow(this.sql);
    if (feeDiscountScheduleBlank(raw)) {
      throwParamsUnset('token_params.fee_discount_schedule');
    }

    let schedule: FeeDiscountSchedule;
    try {
      schedule = parseFeeDiscountSchedule(raw);
    } catch (err) {
      if (err instanceof TokenError) throw err;
      throw new TokenError('token_params.fee_discount_schedule is not a valid schedule', 'token.params_invalid');
    }
    if (generation === this.feeScheduleGeneration) this.feeScheduleCache = { schedule, loadedAt: now };
    return schedule;
  }

  /**
   * The stored fee-decay schedule as the owner's door sees it: the row, or null while blank, and its version. A row
   * that does not parse is returned as stored, so the owner can see what to replace.
   */
  async feeDiscountScheduleRow(): Promise<{ schedule: unknown; version: string }> {
    const raw = await readFeeDiscountRow(this.sql);
    return { schedule: feeDiscountScheduleBlank(raw) ? null : raw, version: feeDiscountScheduleVersion(raw) };
  }

  /**
   * Publish the fee-decay schedule (§4.3), after the router has consumed the two founders' approval of exactly this
   * ladder over exactly `expectedVersion`. The row is locked, compared and written in one transaction, so a publish
   * that lost a race refuses `token.fee_discount_stale` and writes nothing. This process's cached schedule is dropped,
   * and a read that began before the write does not cache the old one, so its next discount read is the new row. Other
   * svc-token processes read the new row when their cache expires (`feeScheduleTtlMs`, one minute by default).
   */
  async publishFeeDiscountSchedule(input: {
    schedule: unknown;
    expectedVersion: string;
  }): Promise<{ schedule: PublishedFeeDiscountSchedule; version: string; previousVersion: string }> {
    const schedule = feeDiscountLadderToPublish(input.schedule);
    const written = await transaction(this.sql, async (tx) => {
      const previousVersion = feeDiscountScheduleVersion(await readFeeDiscountRow(tx, { forUpdate: true }));
      if (previousVersion !== input.expectedVersion) {
        throw new TokenError(
          `expectedVersion ${input.expectedVersion} is stale; the stored schedule is ${previousVersion}`,
          'token.fee_discount_stale',
        );
      }
      await tx`
        UPDATE token.token_params SET fee_discount_schedule = ${tx.json(schedule as never)}, updated_at = now() WHERE id = true
      `;
      return { previousVersion };
    });
    this.feeScheduleGeneration += 1;
    this.feeScheduleCache = null;
    return { schedule, version: feeDiscountScheduleVersion(schedule), previousVersion: written.previousVersion };
  }

  /**
   * Buyback split params from `token_params` (T-02). A blank bps refuses.
   * Source defaults are not filled in.
   */
  async buybackParams(now: number = Date.now()): Promise<BuybackParams> {
    if (!this.loadParamsFromDb) return this.options.buyback!;
    const cached = this.buybackParamsCache;
    if (cached && this.feeScheduleTtlMs > 0 && now - cached.loadedAt < this.feeScheduleTtlMs) return cached.params;

    const rows = await this.sql<Array<{ buyback_bps: string | null; burn_split_bps: string | null }>>`
      SELECT buyback_bps::text, burn_split_bps::text FROM token.token_params WHERE id = true
    `;
    if (rows.length === 0) throw new TokenError('token_params singleton row is missing — run migrations', 'token.params_missing');
    const buybackRaw = rows[0]!.buyback_bps;
    const burnRaw = rows[0]!.burn_split_bps;
    if (buybackRaw == null || buybackRaw.trim() === '') {
      throwParamsUnset('token_params.buyback_bps');
    }
    if (burnRaw == null || burnRaw.trim() === '') {
      throwParamsUnset('token_params.burn_split_bps');
    }
    const params: BuybackParams = {
      buybackBps: Number(buybackRaw),
      burnSplitBps: Number(burnRaw),
    };
    if (!Number.isInteger(params.buybackBps) || params.buybackBps < 0 || params.buybackBps > 10_000) {
      throw new TokenError(`token_params.buyback_bps out of range: ${params.buybackBps}`, 'token.params_invalid');
    }
    if (!Number.isInteger(params.burnSplitBps) || params.burnSplitBps < 0 || params.burnSplitBps > 10_000) {
      throw new TokenError(`token_params.burn_split_bps out of range: ${params.burnSplitBps}`, 'token.params_invalid');
    }
    this.buybackParamsCache = { params, loadedAt: now };
    return params;
  }

  /**
   * Emission curve from `token_params` (T-02). A blank supply or reward refuses.
   * Code defaults are not live authority.
   */
  async emissionParams(now: number = Date.now()): Promise<EmissionParams> {
    if (!this.loadParamsFromDb) return this.options.emission!;
    const cached = this.emissionParamsCache;
    if (cached && this.feeScheduleTtlMs > 0 && now - cached.loadedAt < this.feeScheduleTtlMs) return cached.params;

    const rows = await this.sql<Array<{ total_supply: string | null; halving_interval: number | null; emission_curve: unknown }>>`
      SELECT total_supply::text, halving_interval, emission_curve FROM token.token_params WHERE id = true
    `;
    if (rows.length === 0) throw new TokenError('token_params singleton row is missing — run migrations', 'token.params_missing');
    const row = rows[0]!;
    if (row.total_supply == null || row.total_supply.trim() === '') {
      throwParamsUnset('token_params.total_supply');
    }
    if (row.halving_interval == null) {
      throwParamsUnset('token_params.halving_interval');
    }
    const curve = row.emission_curve;
    if (feeDiscountScheduleBlank(curve)) {
      throwParamsUnset('token_params.emission_curve');
    }
    if (typeof curve !== 'object' || Array.isArray(curve)) {
      throw new TokenError('token_params.emission_curve is not an object', 'token.params_invalid');
    }
    const curveObj = curve as Record<string, unknown>;
    const initialRaw = curveObj.initialEpochReward;
    if (typeof initialRaw === 'number') {
      throw new TokenError(
        'token_params.emission_curve.initialEpochReward must be a decimal string, not a JSON number',
        'token.params_invalid',
      );
    }
    if (typeof initialRaw !== 'string' || initialRaw.trim() === '') {
      throwParamsUnset('token_params.emission_curve.initialEpochReward');
    }
    const params: EmissionParams = {
      initialEpochReward: parseAmount(initialRaw),
      halvingIntervalEpochs: Number(row.halving_interval),
      maxSupply: parseAmount(row.total_supply),
    };
    if (!Number.isInteger(params.halvingIntervalEpochs) || params.halvingIntervalEpochs < 1) {
      throw new TokenError(`token_params.halving_interval invalid: ${params.halvingIntervalEpochs}`, 'token.params_invalid');
    }
    this.emissionParamsCache = { params, loadedAt: now };
    return params;
  }

  async accessOf(userId: string) {
    const [staked, schedule] = await Promise.all([this.stakeOf(userId), this.feeDiscountSchedule()]);
    return { staked, tier: accessTierFor(staked), feeDiscountBps: feeDiscountBps(staked, schedule) };
  }

  // ── Real yield (§4.3) ──────────────────────────────────────────────────────

  /**
   * Distribute a window's platform revenue to stakers, pro-rata by stake ×
   * multiplier.
   *
   * "Real revenue, not emissions" — the value comes from `houseFees`, swept
   * into the rewards engine and paid out. Nothing is minted here.
   *
   * ── WEEKLY JOB IS `runYieldWindow` IN `yield-job.ts` ──────────────────────
   *
   * §4.3's aggregation job reads houseFees via ledger-client and calls this
   * method. Keep `sources` here as the recipe input; the job is the only
   * production builder. Operator `distributeRevenue` remains a treasury
   * mutation. On **first claim** each named amount is bound to the live
   * `houseFees` pot — over-claim refuses as `token.yield_source_underfunded`
   * before the window header (#1353 / T-03). Under-claim stays allowed as a
   * deliberate partial window.
   *
   * Each payout is its OWN ledger transaction keyed on (window, user), so a
   * crash halfway through is resumable: re-running pays only whoever was
   * missed. A single giant transaction would be atomic but unresumable, and
   * with thousands of stakers that is the worse trade.
   */
  async distributeRevenue(input: {
    windowId: string;
    /** Fees to sweep in, per source module. */
    sources: ReadonlyArray<{ module: string; amount: Amount }>;
  }): Promise<YieldRunResult> {
    return withMoneySpan('token.distributeRevenue', { operation: 'yield', windowId: input.windowId }, async (span) => {
      const result = await this.distributeRevenueInner(input);
      span.setAttribute('intafaced.recipients', result.recipients);
      span.setAttribute('intafaced.distributed', formatAmount(result.distributed));
      span.setAttribute('intafaced.already_paid', result.alreadyPaid);
      return result;
    });
  }

  private async distributeRevenueInner(input: {
    windowId: string;
    sources: ReadonlyArray<{ module: string; amount: Amount }>;
  }): Promise<YieldRunResult> {
    /**
     * Collapse sources by module BEFORE claiming, sweeping or planning.
     *
     * The sweep ledger key is `token.fee.sweep:${windowId}:${module}:${asset}` —
     * one post per (window, module). Two legs for the same module used to
     * produce total = a+b while only the first post moved money (the second hit
     * the idempotency key and became a silent no-op). The plan then paid against
     * a figure larger than what the rewards engine actually held.
     *
     * Summing first makes one post of the full module amount, so plan total and
     * value swept agree. Duplicate modules on the wire are operator noise, not
     * two independent sweeps.
     */
    const byModule = new Map<string, Amount>();
    for (const source of input.sources) {
      if (source.amount <= 0n) continue;
      byModule.set(source.module, (byModule.get(source.module) ?? 0n) + source.amount);
    }

    const total = [...byModule.values()].reduce((acc, a) => acc + a, 0n);
    if (total <= 0n) throw new TokenError('No revenue to distribute for this window', 'token.nothing_to_distribute');

    /**
     * T-03 residual — bind operator-typed amounts to the actual fee pots on
     * FIRST claim only.
     *
     * `runYieldWindow` builds `sources` from live pots. This method still
     * binds named amounts to houseFees on FIRST claim so an operator mutation
     * cannot over-claim. Fail closed **before** claim/sweep when any module's
     * houseFees balance is short of the named amount. Under-claim (leaving
     * fees in the pot) stays allowed — that is a deliberate partial window.
     *
     * Re-runs of an already-claimed window must NOT re-check the pot: the first
     * run already swept it to zero, and the resume path is plan + idempotent
     * sweep + pay. Mismatched totals still refuse via the header assert.
     */
    const alreadyClaimed = await this.readYieldWindowHeader(this.sql, input.windowId);
    if (alreadyClaimed === null) {
      for (const [module, amount] of byModule) {
        const held = (await this.ledger.balance(houseFees(module, this.assetId))).amount;
        if (held < amount) {
          throw new TokenError(
            `Module "${module}" houseFees holds ${formatAmount(held)} ${this.assetId} but this window names ` +
              `${formatAmount(amount)} — refuse rather than underfund the plan or die mid-sweep`,
            'token.yield_source_underfunded',
          );
        }
      }
    }

    // CLAIM (window_id, total) + freeze who is paid BEFORE any fee sweep.
    // An empty settlement still claims the header so a later stake cannot
    // re-plan the same window id (0004). Sweep after claim so a re-run with a
    // mismatched total refuses before moving more fees.
    const plan = await this.planYieldWindow(input.windowId, total);

    for (const [module, amount] of byModule) {
      await this.ledger.post(
        recipes.sweepFeesToRewards({
          windowId: input.windowId,
          sourceModule: module,
          assetId: this.assetId,
          amount,
        }),
      );
    }

    if (plan.rows.length === 0) {
      // Nothing was staked when this window was claimed. Fees are swept into
      // the rewards engine (same as before 0004) so buyback/other paths that
      // draw on the engine still see them. The header freezes this window id —
      // re-running it does not invent recipients. A later window id with
      // stakers needs its own sources (and fees in houseFees); residual in
      // the engine is the operator's to schedule (§13 socket token.yield).
      return { windowId: input.windowId, distributed: 0n, recipients: 0, skipped: plan.skipped, alreadyPaid: 0 };
    }

    let distributed = 0n;
    let recipients = 0;
    let alreadyPaid = 0;

    for (const row of plan.rows) {
      // A row that already carries a ledger transaction is not re-posted and,
      // just as importantly, is not COUNTED. Reporting a no-op post as a fresh
      // payout made a re-run tell the operator the window had paid out twice —
      // in the only channel the operator has.
      if (row.ledgerTxId !== null) {
        alreadyPaid++;
        continue;
      }

      const posted = await this.ledger.post(
        recipes.rewardPay({
          rewardId: `yield:${input.windowId}:${row.userId}`,
          userId: row.userId,
          assetId: this.assetId,
          amount: row.amount,
          reason: 'token.yield.distributed',
        }),
      );

      // After the post, never before: a row that says "paid" must have a
      // transaction to point at, which is what `yield_payouts_paid_has_tx_ck`
      // enforces regardless of what this code does. A crash between the post
      // and this update leaves the row unpaid; the retry re-posts (idempotent
      // on the same key) and lands the same transaction id.
      //
      // Conditional UPDATE is also the concurrent-call honesty gate: two
      // operators settling the same unpaid plan both see ledgerTxId=null, both
      // post (second is a ledger no-op), but only one UPDATE from paid_at IS
      // NULL can win. The loser must not report a fresh payout in
      // distributed/recipients — that is the same operator-channel lie #1076
      // closed for sequential re-runs via alreadyPaid.
      const marked = await this.sql<Array<{ user_id: string }>>`
        UPDATE token.yield_payouts
           SET ledger_tx_id = ${posted.id}, paid_at = now()
         WHERE window_id = ${input.windowId} AND user_id = ${row.userId} AND paid_at IS NULL
     RETURNING user_id
      `;
      if (marked.length === 0) {
        alreadyPaid++;
        continue;
      }

      distributed += row.amount;
      recipients++;
    }

    return { windowId: input.windowId, distributed, recipients, skipped: plan.skipped, alreadyPaid };
  }

  /**
   * THAT this window was claimed, and WHO it pays — decided once, then read.
   *
   * #1076 froze the recipient list in `yield_payouts` so a re-run after a new
   * stake could not grow the list. It left the empty-pool case unclaimed: no
   * payout row meant the next call looked like a first call, planned whoever
   * was staked then, and paid them out of revenue already swept under that
   * window id. 0004 closes that residual with a header `(window_id, total)`
   * claimed before any sweep — an empty settlement is still a settlement.
   *
   * Order: claim header (+ write payout instructions) → caller sweeps → pay.
   * Same claim-before-post shape as `stake` (0001) and `recordBuyback` (0002).
   *
   * Decides no economic number — records the total the operator already typed
   * and the pro-rata answer at first claim, so asking twice cannot give two
   * answers (including the empty answer).
   */
  private async planYieldWindow(windowId: string, total: Amount): Promise<{ rows: YieldPlanRow[]; skipped: number }> {
    const existingHeader = await this.readYieldWindowHeader(this.sql, windowId);
    if (existingHeader !== null) {
      this.assertWindowTotal(windowId, existingHeader, total);
      return { rows: await this.readYieldPlan(this.sql, windowId), skipped: 0 };
    }

    return transaction(
      this.sql,
      async (tx) => {
        // Serialise claim of THIS window only. `hashtext` is stable across
        // sessions, and an xact lock is released by commit or rollback alike, so
        // a crash mid-claim cannot wedge the window.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`token.yield:${windowId}`})::bigint)`;

        const racedHeader = await this.readYieldWindowHeader(tx, windowId);
        if (racedHeader !== null) {
          this.assertWindowTotal(windowId, racedHeader, total);
          return { rows: await this.readYieldPlan(tx, windowId), skipped: 0 };
        }

        // Header first — even when nobody is staked — so the empty answer is
        // frozen before any fee movement and before any late joiner can appear.
        await tx`
          INSERT INTO token.yield_windows (window_id, total_amount)
          VALUES (${windowId}, ${formatAmount(total)}::numeric)
        `;

        const stakes = await tx<Array<{ id: string; user_id: string; amount: string; tier: StakeTier; multiplier_bps: string }>>`
          SELECT id, user_id, amount, tier, multiplier_bps FROM token.stakes WHERE status = 'active' ORDER BY id ASC
        `;
        if (stakes.length === 0) return { rows: [], skipped: 0 };

        // The row is the claim index. Weight is the pot only when they agree.
        // A drift refuses — the table figure is not a weight, and the pot is
        // not a substitute share.
        const weighed: Array<{ userId: string; amount: Amount; tier: StakeTier; multiplierBps: number }> = [];
        for (const s of stakes) {
          const recorded = parseAmount(s.amount);
          const book = (await this.ledger.balance(tokenStakeAccount(s.user_id, this.assetId, s.id))).amount;
          if (book !== recorded) {
            throw new TokenError(
              `Stake ${s.id} table amount ${formatAmount(recorded)} disagrees with ledger ${formatAmount(book)}`,
              'token.stake_ledger_mismatch',
            );
          }
          weighed.push({
            userId: s.user_id,
            amount: book,
            tier: s.tier,
            // The multiplier SNAPSHOTTED when the stake opened, not today's
            // table. A staker locked for 12 months bought that multiplier;
            // re-tuning the ladder afterwards must not retroactively change what
            // they earn.
            multiplierBps: Number(s.multiplier_bps),
          });
        }

        const shares = distributeYield(total, weighed);

        /**
         * Sum shares per user before writing the plan.
         *
         * `distributeYield` returns one share PER STAKE, and a user can hold
         * several (a flex stake and an m12 stake, say). The reward key is per
         * (window, user), so posting each share separately meant the second one
         * hit the ledger's idempotency check and became a silent no-op — the
         * user was underpaid and the remainder sat in the rewards engine.
         *
         * Summing first keeps one payout per user per window, which is also the
         * invariant the key — and now the primary key of `yield_payouts` —
         * already assumed. Found by partner audit.
         */
        const perUser = new Map<string, Amount>();
        for (const share of shares) {
          perUser.set(share.userId, (perUser.get(share.userId) ?? 0n) + share.share);
        }

        const rows: YieldPlanRow[] = [];
        let skipped = 0;

        for (const [userId, amount] of [...perUser.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
          // A share can round to zero for a dust-sized stake. The ledger rejects
          // zero-amount entries by design, so a zero row would be an instruction
          // nothing could ever clear — counted, never written.
          if (amount <= 0n) {
            skipped++;
            continue;
          }
          rows.push({ userId, amount, ledgerTxId: null });
        }

        for (const row of rows) {
          await tx`
            INSERT INTO token.yield_payouts (window_id, user_id, amount)
            VALUES (${windowId}, ${row.userId}, ${formatAmount(row.amount)}::numeric)
          `;
        }

        return { rows, skipped };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  private async readYieldWindowHeader(sql: Sql, windowId: string): Promise<Amount | null> {
    const rows = await sql<Array<{ total_amount: string }>>`
      SELECT total_amount FROM token.yield_windows WHERE window_id = ${windowId}
    `;
    const row = rows[0];
    return row ? parseAmount(row.total_amount) : null;
  }

  private async readYieldPlan(sql: Sql, windowId: string): Promise<YieldPlanRow[]> {
    const rows = await sql<Array<{ user_id: string; amount: string; ledger_tx_id: string | null }>>`
      SELECT user_id, amount, ledger_tx_id FROM token.yield_payouts
       WHERE window_id = ${windowId} ORDER BY user_id ASC
    `;
    return rows.map((r) => ({ userId: r.user_id, amount: parseAmount(r.amount), ledgerTxId: r.ledger_tx_id }));
  }

  /**
   * A re-run must be the SAME window, not just the same id.
   *
   * Compared against the HEADER total (0004), not the sum of payout rows —
   * an empty settlement has zero payout rows but a non-zero claimed total.
   * Paying a frozen plan (or re-planning) against a different figure would
   * answer a request nobody made. Same reasoning as `bank.loan_principal_mismatch`.
   */
  private assertWindowTotal(windowId: string, claimed: Amount, total: Amount): void {
    if (claimed !== total) {
      throw new TokenError(
        `Window ${windowId} was already claimed for ${formatAmount(claimed)} ${this.assetId}, but this call names ` +
          `${formatAmount(total)} — a re-run must carry the same revenue. Use a new window id to distribute a different amount`,
        'token.yield_window_mismatch',
      );
    }
  }

  // ── Operator burn record (§4.3 calls this buyback & burn) ──────────────────

  /**
   * Record an operator-asserted buyback — or refuse when the book cannot.
   *
   * NOTHING IS BOUGHT BACK HERE, and the method name is the §4.3 vocabulary
   * rather than a description of what runs. §13 socket `token.buyback`.
   *
   * - `tokensBought` is a figure the caller types. No market-buy is executed by
   *   this service or any other, so the platform acquires no IFC and creates no
   *   buy pressure. Pricing and execution are svc-trade's job and svc-trade
   *   cannot yet do it.
   * - Existing recipes cannot book that purchase: `burn` only moves `toBurn`
   *   *out* of the rewards engine (fee-funded value already ours); `mintEmission`
   *   would print supply; `sweepFeesToRewards` drains module fees already used
   *   by yield. `toRewards` is the remainder of the split, not a second credit.
   * - A settled row must mean this run posted recipes whose engineΔ + burnΔ
   *   equals `tokensBought`. No such recipe exists in `packages/ledger-client`,
   *   so a new or pending run is refused `token.buyback_tokens_unmoved`.
   *   Coincidental global balance movement is not a settle (paper-settle).
   * - Do not publish `buybackExecuted` until this run posted a ledger tx.
   *   Emitting it on refuse (or on a fee-funded `burn`) would lie that tokens
   *   were bought. The catalog still declares the event; event-wiring stays
   *   red. `WIRING_SOCKETS` lives in `packages/events` — exclusive this
   *   service cannot declare a missing-publisher socket (second PR).
   * - There is no caller: no cron, no bus subscriber, no admin form. An
   *   operator with admin:treasury + MFA invokes the mutation or it never runs.
   * - `buybackBudget()` (economics/buyback.ts) is what would size the spend from
   *   revenue. It is called from nowhere but its own tests.
   *
   * ORDERING (0002): the window is still CLAIMED first so overlap / run-id
   * conflict refuse by name before anything would post. Previously the burn
   * posted first and the row followed `ON CONFLICT (id) DO NOTHING`, while the
   * guard was a unique index on the WINDOW. A new run id over a spent window
   * therefore burned for real and then failed on an index its conflict clause
   * did not name: tokens irreversibly gone, no row, no event, and an opaque 500.
   *
   * Windows are half-open `[from, to)` and may not overlap (0002). This method
   * decides no economic number — not a window length, not a cadence, not a
   * rate. Those are the owner's (see the token-economics ADR).
   *
   * Turning this into the §4.3 flywheel needs a real market-buy recipe against
   * the internal book plus a schedule — a product decision and an svc-trade
   * dependency, not a rename, and not a fee-funded burn wearing the name.
   */
  async recordBuyback(input: {
    runId: string;
    /** Typed columns, not a JSON blob — "which runs covered July" is a query. */
    revenueWindow: { from: Date; to: Date };
    revenueTotal: Record<string, string>;
    tokensBought: Amount;
  }): Promise<{ runId: string; burned: Amount; toRewards: Amount }> {
    return withMoneySpan('token.recordBuyback', { operation: 'buyback', amount: formatAmount(input.tokensBought) }, async () =>
      this.recordBuybackInner(input),
    );
  }

  private async recordBuybackInner(input: {
    runId: string;
    revenueWindow: { from: Date; to: Date };
    revenueTotal: Record<string, string>;
    tokensBought: Amount;
  }): Promise<{ runId: string; burned: Amount; toRewards: Amount }> {
    // Validate before anything is claimed and long before anything burns. The
    // DB has a `to > from` check, but reaching it as a raw 23514 would be the
    // same unnamed-500 failure this method was rewritten to remove.
    if (!(input.revenueWindow.from.getTime() < input.revenueWindow.to.getTime())) {
      throw new TokenError(
        `Revenue window [${iso(input.revenueWindow.from)}, ${iso(input.revenueWindow.to)}) is empty or inverted`,
        'token.buyback_window_invalid',
      );
    }

    // A zero (or negative) buy still CLAIMS the revenue window via the GiST
    // exclusion on `[from,to)`. That permanently blocks a later real burn for
    // the same interval while moving nothing — spend the window only when a
    // real size is asserted.
    if (input.tokensBought <= 0n) {
      throw new TokenError(
        'tokensBought must be positive — a zero buy still claims the revenue window and blocks a later real burn',
        'token.buyback_revenue_invalid',
      );
    }

    const revenueTotal = normaliseRevenueTotal(input.revenueTotal);

    const buyback = await this.buybackParams();
    // toBurn + toRewards === tokensBought exactly (splitBuyback derives one side
    // by subtraction). Pure arithmetic over the params — no ledger read — so the
    // final figures are known at claim time and the claimed row is never a
    // placeholder that has to be corrected later.
    const { toBurn, toRewards } = splitBuyback(input.tokensBought, buyback);

    // ── CLAIM ────────────────────────────────────────────────────────────────
    const claimed = await this.claimBuybackWindow({
      runId: input.runId,
      window: input.revenueWindow,
      revenueTotal,
      tokensBought: input.tokensBought,
      toBurn,
      toRewards,
    });

    if (claimed.status === 'settled') {
      // Exact retry of a run that already finished. Return the book row rather
      // than recomputing: what this run actually burned is what the row says,
      // even if the params have moved since. Never re-post.
      return { runId: claimed.id, burned: claimed.burned, toRewards: claimed.toRewards };
    }

    // ── REFUSE ───────────────────────────────────────────────────────────────
    // No existing recipe books tokensBought onto the ledger. Do not post
    // `burn(toBurn)` from the fee-funded engine (that is not a buy). Do not
    // settle because two consecutive `balance` reads happened to sum to the
    // operator figure (paper-settle — a concurrent yield/mint/burn can mint a
    // `buybackExecuted` this run never posted). A future buyback recipe posts
    // here, then settles only against *this run's* posted keys.
    //
    // Do not restore `this.bus.publish('buybackExecuted', …)` here. Nothing
    // posted — the burn leg does not run — so the event would lie. Doctrine
    // event-wiring is red for that missing publisher on purpose. The repo
    // pattern is a WIRING_SOCKETS missing-publisher row in
    // packages/events/src/catalog.ts ("publisher waits on a buyback recipe").
    // Exclusive this service cannot add it (one service per PR; that file is
    // a second package). Clear the gate in a packages/events PR, or restore
    // the publisher here only after a recipe actually posts.
    return this.refuseUnbookedBuyback(claimed.id, input.runId, input.tokensBought, { fresh: claimed.fresh });
  }

  /**
   * Settle a buyback whose tokensBought is a real IOC fill.
   *
   * The live job calls this AFTER `placeIocMarketBuy`. Operator HTTP still
   * uses `recordBuyback` and still refuses unmoved. Claim then `recipes.burn`
   * from the rewards engine — the fill must have credited that pot or the
   * burn fails closed (insufficient funds), never a fee-funded fake buy.
   *
   * Does not emit `buybackExecuted` (WIRING_SOCKETS publisher is a
   * packages/events PR).
   */
  async settleBuybackFill(input: {
    runId: string;
    revenueWindow: { from: Date; to: Date };
    revenueTotal: Record<string, string>;
    tokensBought: Amount;
  }): Promise<{ runId: string; burned: Amount; toRewards: Amount }> {
    return withMoneySpan('token.settleBuybackFill', { operation: 'buyback', amount: formatAmount(input.tokensBought) }, async () =>
      this.settleBuybackFillInner(input),
    );
  }

  private async settleBuybackFillInner(input: {
    runId: string;
    revenueWindow: { from: Date; to: Date };
    revenueTotal: Record<string, string>;
    tokensBought: Amount;
  }): Promise<{ runId: string; burned: Amount; toRewards: Amount }> {
    if (!(input.revenueWindow.from.getTime() < input.revenueWindow.to.getTime())) {
      throw new TokenError(
        `Revenue window [${iso(input.revenueWindow.from)}, ${iso(input.revenueWindow.to)}) is empty or inverted`,
        'token.buyback_window_invalid',
      );
    }
    if (input.tokensBought <= 0n) {
      throw new TokenError(
        'tokensBought must be positive — a zero fill is token.buyback_book_empty on the job, not a settle',
        'token.buyback_revenue_invalid',
      );
    }

    const revenueTotal = normaliseRevenueTotal(input.revenueTotal);
    const buyback = await this.buybackParams();
    const planned = splitBuyback(input.tokensBought, buyback);

    const claimed = await this.claimBuybackWindow({
      runId: input.runId,
      window: input.revenueWindow,
      revenueTotal,
      tokensBought: input.tokensBought,
      toBurn: planned.toBurn,
      toRewards: planned.toRewards,
    });
    // A resumed claim keeps the split it was made with. The params may have moved since, and the burn key is the run id,
    // so posting a different amount would either conflict with an earlier attempt or burn more than the row records.
    const toBurn = claimed.burned;
    const toRewards = claimed.toRewards;

    if (claimed.status === 'settled') {
      return { runId: claimed.id, burned: claimed.burned, toRewards: claimed.toRewards };
    }

    if (toBurn > 0n) {
      const stamped = await this.stampBuybackPostAttempt(claimed.id);
      if (!stamped) {
        const held = await this.sql<Array<{ status: BuybackRunStatus; tokens_burned: string; tokens_to_rewards: string }>>`
          SELECT status, tokens_burned, tokens_to_rewards FROM token.buyback_runs WHERE id = ${claimed.id}
        `;
        const row = held[0];
        if (row?.status === 'settled') {
          return { runId: claimed.id, burned: parseAmount(row.tokens_burned), toRewards: parseAmount(row.tokens_to_rewards) };
        }
        throw new TokenError(
          `Buyback run ${input.runId} is no longer a pending claim — refusing to burn. The quiet-period release won the row, and NOTHING was posted`,
          'token.buyback_run_conflict',
        );
      }
    }

    try {
      if (toBurn > 0n) {
        await this.ledger.post(
          recipes.burn({
            runId: input.runId,
            assetId: this.assetId,
            amount: toBurn,
            from: rewardsEngine(this.assetId),
          }),
        );
      }
    } catch (err) {
      if (err instanceof InsufficientFundsError && claimed.fresh) {
        await this.sql`
          DELETE FROM token.buyback_runs WHERE id = ${claimed.id} AND status = 'pending'
        `;
      }
      throw err;
    }

    await this.sql`
      UPDATE token.buyback_runs SET status = 'settled' WHERE id = ${claimed.id} AND status = 'pending'
    `;

    return { runId: claimed.id, burned: toBurn, toRewards };
  }

  /**
   * Mark this pending row as a burn attempt before the ledger post.
   *
   * One read-committed transaction, `FOR UPDATE` on the row: a concurrent
   * quiet-period release queues on the same lock and then reads this
   * `last_post_at`, so it cannot delete a claim whose burn is about to be
   * sent. Returns false when the row is already gone or no longer pending —
   * the caller must not post.
   */
  private async stampBuybackPostAttempt(runId: string): Promise<boolean> {
    return transaction(
      this.sql,
      async (tx) => {
        const locked = await tx<Array<{ id: string }>>`
          SELECT id FROM token.buyback_runs
           WHERE id = ${runId} AND status = 'pending'
           FOR UPDATE
        `;
        if (!locked[0]) return false;
        await tx`
          UPDATE token.buyback_runs
             SET last_post_at = clock_timestamp()
           WHERE id = ${runId} AND status = 'pending'
        `;
        return true;
      },
      { isolation: 'read committed' },
    );
  }

  /**
   * Pending claim, no market-buy on the book.
   *
   * A fresh insert from this call posted nothing — release so the window is
   * not held hostage. A retry of an older pending row is released only when
   * `getTxByKey` says the burn key is absent AND `last_post_at` is null or
   * older than BUYBACK_QUIET_SECONDS on the database clock. "Absent now" alone
   * is not "never": the burn from the earlier attempt can still be queued
   * behind the ledger's chain-tip lock after the client gave up (25 s deadline;
   * the ledger's own statement timeout is 15 s). The clock is the last attempt,
   * not `created_at`: a claim can be hours old when a retry posts. Deleting on
   * claim age frees the window while that late burn lands. The delete takes
   * the same row lock as `stampBuybackPostAttempt`, so the two cannot both
   * pass. `getTxByKey` answers null only for a key the ledger says it has not
   * booked (the read-only `txByKey` door); when it cannot answer (ledger down,
   * malformed, inconsistent) it throws — that must stay
   * `token.buyback_tokens_unmoved`, never a 500, and unknown ≠ absent.
   */
  private async refuseUnbookedBuyback(claimedId: string, runId: string, tokensBought: Amount, opts: { fresh: boolean }): Promise<never> {
    let release = opts.fresh;
    if (!release) {
      try {
        const burnTx = await this.ledger.getTxByKey(`token.burn:${this.assetId}:${runId}`);
        release = burnTx === null;
      } catch {
        release = false;
      }
    }
    if (release) {
      await transaction(
        this.sql,
        async (tx) => {
          const locked = await tx<Array<{ releasable: boolean }>>`
            SELECT (
              last_post_at IS NULL
              OR last_post_at < clock_timestamp() - make_interval(secs => ${BUYBACK_QUIET_SECONDS})
            ) AS releasable
              FROM token.buyback_runs
             WHERE id = ${claimedId} AND status = 'pending'
             FOR UPDATE
          `;
          if (locked[0]?.releasable !== true) return;
          await tx`
            DELETE FROM token.buyback_runs
             WHERE id = ${claimedId} AND status = 'pending'
          `;
        },
        { isolation: 'read committed' },
      );
    }
    throw new TokenError(
      `Buyback run ${runId} asserted tokensBought=${formatAmount(tokensBought)} ${this.assetId} but that figure did not move on the ledger — no recipe books a market-buy into the rewards engine. Refusing to settle a DB-only buyback. A burn from the engine would spend fee revenue, not purchased tokens`,
      'token.buyback_tokens_unmoved',
    );
  }

  /**
   * Take ownership of a revenue window, or refuse by name.
   *
   * Concurrent GiST inserts on `buyback_runs_window_no_overlap_ex` can raise
   * 40P01 deadlock instead of 23P01. An unmapped deadlock used to escape the
   * public door as 500 after the winner had already claimed — same unnamed
   * refuse the 0002 rewrite removed for the serial path. Serialize THIS claim
   * with an xact advisory lock (yield/mint shape), name overlap before INSERT,
   * and map leftover 23P01/23505/40P01/40001 AFTER the tx rolls back so the
   * holder query does not run on an aborted session.
   *
   * Mirrors `claimStakePending`: insert, or on an id conflict re-read and refuse
   * a row whose identity does not match what the caller is asking to post.
   */
  private async claimBuybackWindow(input: {
    runId: string;
    window: { from: Date; to: Date };
    revenueTotal: Record<string, string>;
    tokensBought: Amount;
    toBurn: Amount;
    toRewards: Amount;
  }): Promise<{ id: string; status: BuybackRunStatus; burned: Amount; toRewards: Amount; fresh: boolean }> {
    type Row = {
      id: string;
      revenue_window_from: Date;
      revenue_window_to: Date;
      tokens_bought: string;
      tokens_burned: string;
      tokens_to_rewards: string;
      status: BuybackRunStatus;
    };
    type Held = { id: string; revenue_window_from: Date; revenue_window_to: Date; status: BuybackRunStatus };

    const mapRow = (row: Row, fresh: boolean) => ({
      id: row.id,
      status: row.status,
      burned: parseAmount(row.tokens_burned),
      toRewards: parseAmount(row.tokens_to_rewards),
      fresh,
    });

    try {
      return await transaction(
        this.sql,
        async (tx) => {
          // Global on purpose: nested/partial overlaps do not share from/to, so
          // a per-window lock would still race the exclusion constraint.
          await tx`SELECT pg_advisory_xact_lock(hashtext(${'token.buyback'})::bigint)`;

          const overlapping = await tx<Held[]>`
            SELECT id, revenue_window_from, revenue_window_to, status
              FROM token.buyback_runs
             WHERE tstzrange(revenue_window_from, revenue_window_to, '[)')
                && tstzrange(${input.window.from}, ${input.window.to}, '[)')
               AND id <> ${input.runId}
             ORDER BY revenue_window_from
             LIMIT 5
          `;
          if (overlapping[0]) {
            throw this.overlapError(input.runId, input.window, overlapping);
          }

          const inserted = await tx<Row[]>`
            INSERT INTO token.buyback_runs (
              id, revenue_window_from, revenue_window_to, revenue_total,
              tokens_bought, tokens_burned, tokens_to_rewards, status, executed_at
            )
            VALUES (
              ${input.runId}, ${input.window.from}, ${input.window.to},
              ${this.sql.json(input.revenueTotal as never)},
              ${formatAmount(input.tokensBought)}::numeric, ${formatAmount(input.toBurn)}::numeric,
              ${formatAmount(input.toRewards)}::numeric, 'pending', now()
            )
            ON CONFLICT (id) DO NOTHING
            RETURNING id, revenue_window_from, revenue_window_to, tokens_bought, tokens_burned, tokens_to_rewards, status
          `;

          const row = inserted[0];
          if (row) return mapRow(row, true);

          const rows = await tx<Row[]>`
            SELECT id, revenue_window_from, revenue_window_to, tokens_bought, tokens_burned, tokens_to_rewards, status
              FROM token.buyback_runs WHERE id = ${input.runId} FOR UPDATE
          `;
          const existing = rows[0];
          if (!existing) {
            throw new TokenError(`Buyback run ${input.runId} disappeared after conflict`, 'token.buyback_run_conflict');
          }

          const mismatch =
            existing.revenue_window_from.getTime() !== input.window.from.getTime() ||
            existing.revenue_window_to.getTime() !== input.window.to.getTime() ||
            parseAmount(existing.tokens_bought) !== input.tokensBought;

          if (mismatch) {
            throw new TokenError(
              `Buyback run ${input.runId} was already claimed for [${iso(existing.revenue_window_from)}, ` +
                `${iso(existing.revenue_window_to)}) buying ${formatAmount(parseAmount(existing.tokens_bought))} — ` +
                `refusing to post [${iso(input.window.from)}, ${iso(input.window.to)}) buying ${formatAmount(input.tokensBought)} against it`,
              'token.buyback_run_conflict',
            );
          }

          return mapRow(existing, false);
        },
        { isolation: 'read committed' },
      );
    } catch (err) {
      const named = asTokenError(err);
      if (named) throw named;
      // 23P01 exclusion / 23505 unique / 40P01 deadlock / 40001 serialization —
      // the window is contested. Query the holder on a live session (the tx
      // above has rolled back). Nothing has burned yet.
      if (isExclusionViolation(err) || isUniqueViolation(err) || isContention(err)) {
        throw await this.windowAlreadyClaimed(input.runId, input.window);
      }
      throw err;
    }
  }

  /** Name the run that already holds the window. A refusal a human can act on. */
  private async windowAlreadyClaimed(runId: string, window: { from: Date; to: Date }): Promise<TokenError> {
    const rows = await this.sql<Array<{ id: string; revenue_window_from: Date; revenue_window_to: Date; status: BuybackRunStatus }>>`
      SELECT id, revenue_window_from, revenue_window_to, status
        FROM token.buyback_runs
       WHERE tstzrange(revenue_window_from, revenue_window_to, '[)')
          && tstzrange(${window.from}, ${window.to}, '[)')
       ORDER BY revenue_window_from
       LIMIT 5
    `;
    return this.overlapError(runId, window, rows);
  }

  private overlapError(
    runId: string,
    window: { from: Date; to: Date },
    rows: Array<{ id: string; revenue_window_from: Date; revenue_window_to: Date; status: BuybackRunStatus }>,
  ): TokenError {
    const held = rows.map((r) => `${r.id} [${iso(r.revenue_window_from)}, ${iso(r.revenue_window_to)}) ${r.status}`).join(', ');
    return new TokenError(
      `Revenue window [${iso(window.from)}, ${iso(window.to)}) overlaps an already-claimed buyback run, so run ${runId} was refused ` +
        `and NOTHING was burned. Windows are half-open [from, to) and may not overlap. Already claimed: ${held || '(unknown)'}`,
      'token.buyback_window_overlap',
    );
  }

  /**
   * Settled buyback runs, newest first, as stored — each one adds up
   * (bought = burned + toRewards) or the read refuses
   * `token.treasury_figure_unreadable`. Pending claims are not runs. The
   * buyback rate comes back beside them, or the code that says it is not set;
   * this read never sizes a spend, prices the token or reads revenue.
   */
  async buybackRuns(limit: number): Promise<{
    runs: BuybackRunView[];
    rate: BuybackParams | null;
    missing: string | null;
    reason: 'token.params_unset' | 'token.params_missing' | 'token.params_invalid' | null;
  }> {
    const rows = await this.sql<
      Array<{
        id: string | null;
        bought: string | null;
        burned: string | null;
        to_rewards: string | null;
        executed_at: Date | string | null;
        window_from: Date | string | null;
        window_to: Date | string | null;
      }>
    >`
      SELECT id::text AS id,
             tokens_bought::text AS bought,
             tokens_burned::text AS burned,
             tokens_to_rewards::text AS to_rewards,
             executed_at,
             revenue_window_from AS window_from,
             revenue_window_to AS window_to
        FROM token.buyback_runs
       WHERE status = 'settled'
       ORDER BY executed_at DESC, id DESC
       LIMIT ${limit}
    `;
    const stored: BuybackRunRow[] = rows.map((row) => ({
      id: row.id,
      bought: row.bought,
      burned: row.burned,
      toRewards: row.to_rewards,
      executedAt: row.executed_at,
      windowFrom: row.window_from,
      windowTo: row.window_to,
    }));
    const reported = reportBuybackRuns(stored);
    if (!reported.ok) {
      throw new TokenError('A buyback run this service recorded could not be read', reported.code);
    }
    try {
      return { runs: reported.runs, rate: await this.buybackParams(), missing: null, reason: null };
    } catch (err) {
      if (
        err instanceof TokenError &&
        (err.code === 'token.params_unset' || err.code === 'token.params_missing' || err.code === 'token.params_invalid')
      ) {
        return { runs: reported.runs, rate: null, missing: err.config ?? 'token_params', reason: err.code };
      }
      throw err;
    }
  }

  /** Tokens permanently removed from circulation. */
  async burnedSupply(): Promise<Amount> {
    return (await this.ledger.balance(burnAccount(this.assetId))).amount;
  }

  /**
   * Treasury view.
   *
   * `burned` is `burnedSupply` (the burn-account balance), so it cannot
   * disagree with that read. Lifetime minted, bought, toRewards and
   * distributed stay sums of closed epochs, settled buybacks, and yield
   * payouts with a ledger transaction id. `lastBuyback` is the latest settled
   * run. Pending claims are not included. No rows on those sums, or no
   * settled run, is null. Does not post a recipe and does not quote a market.
   */
  async treasuryView(): Promise<TokenTreasuryView> {
    const rows = await this.sql<
      Array<{
        minted: string | null;
        minted_count: string;
        bought: string | null;
        to_rewards: string | null;
        settled_count: string;
        distributed: string | null;
        distributed_count: string;
        last_bought: string | null;
        last_burned: string | null;
        last_to_rewards: string | null;
        last_executed_at: Date | string | null;
      }>
    >`
      SELECT
        (SELECT SUM(mined_amount)::text FROM token.emission_epochs WHERE closed = true) AS minted,
        (SELECT COUNT(*)::text FROM token.emission_epochs WHERE closed = true) AS minted_count,
        (SELECT SUM(tokens_bought)::text FROM token.buyback_runs WHERE status = 'settled') AS bought,
        (SELECT SUM(tokens_to_rewards)::text FROM token.buyback_runs WHERE status = 'settled') AS to_rewards,
        (SELECT COUNT(*)::text FROM token.buyback_runs WHERE status = 'settled') AS settled_count,
        (SELECT SUM(amount)::text FROM token.yield_payouts WHERE ledger_tx_id IS NOT NULL AND btrim(ledger_tx_id) <> '') AS distributed,
        (SELECT COUNT(*)::text FROM token.yield_payouts WHERE ledger_tx_id IS NOT NULL AND btrim(ledger_tx_id) <> '') AS distributed_count,
        last.bought AS last_bought,
        last.burned AS last_burned,
        last.to_rewards AS last_to_rewards,
        last.executed_at AS last_executed_at
      FROM (SELECT 1) AS anchor
      LEFT JOIN LATERAL (
        SELECT tokens_bought::text AS bought,
               tokens_burned::text AS burned,
               tokens_to_rewards::text AS to_rewards,
               executed_at
          FROM token.buyback_runs
         WHERE status = 'settled'
         ORDER BY executed_at DESC, id DESC
         LIMIT 1
      ) AS last ON true
    `;
    const row = rows[0];
    if (!row) {
      throw new TokenError('The treasury read returned no row', 'token.treasury_figure_unreadable');
    }
    const sums: TreasurySums = {
      minted: row.minted,
      mintedCount: row.minted_count,
      bought: row.bought,
      boughtCount: row.settled_count,
      toRewards: row.to_rewards,
      toRewardsCount: row.settled_count,
      distributed: row.distributed,
      distributedCount: row.distributed_count,
    };
    const reported = reportTreasury(sums);
    if (!reported.ok) {
      throw new TokenError('A treasury figure this service recorded could not be read', reported.code);
    }
    const lastRow: LastBuybackRow = {
      bought: row.last_bought,
      burned: row.last_burned,
      toRewards: row.last_to_rewards,
      executedAt: row.last_executed_at,
    };
    const last = reportLastBuyback(lastRow);
    if (!last.ok) {
      throw new TokenError('A treasury figure this service recorded could not be read', last.code);
    }
    return {
      ...reported.view,
      burned: formatAmount(await this.burnedSupply()),
      lastBuyback: last.last,
    };
  }

  // ── Emissions (§4.3) ───────────────────────────────────────────────────────

  /**
   * Next sequential epoch that has not been closed yet — what the auto-tick
   * and an operator "mint due" both want. Gaps are not filled: if someone
   * minted epoch 5 first, the next open index is still 6 (mintEpoch itself
   * accepts any unclosed index for operator catch-up).
   */
  async nextEmissionEpoch(): Promise<number> {
    const rows = await this.sql<Array<{ next: number | string }>>`
      SELECT COALESCE(MAX(epoch) + 1, 0) AS next FROM token.emission_epochs WHERE closed = true
    `;
    return Number(rows[0]?.next ?? 0);
  }

  /**
   * Schedule parameters and the next `count` epoch rewards.
   *
   * Rewards are `epochReward`, the function `claimEmissionEpoch` uses. Blank
   * `token_params` returns null and the missing key — never `DEFAULT_EMISSION_PARAMS`.
   * This read does not insert an epoch row.
   */
  async emissionSchedule(count: number | undefined): Promise<EmissionScheduleView> {
    const n = assertEmissionScheduleCount(count);
    let params: EmissionParams;
    try {
      params = await this.emissionParams();
    } catch (err) {
      if (
        err instanceof TokenError &&
        (err.code === 'token.params_unset' || err.code === 'token.params_missing' || err.code === 'token.params_invalid')
      ) {
        return {
          params: null,
          epochs: null,
          missing: err.config ?? 'token_params',
          reason: err.code,
        };
      }
      throw err;
    }
    const start = await this.nextEmissionEpoch();
    const epochs: Array<{ epoch: number; reward: string }> = [];
    for (let i = 0; i < n; i++) {
      const epoch = start + i;
      epochs.push({ epoch, reward: formatAmount(epochReward(epoch, params)) });
    }
    return {
      params: {
        initialEpochReward: formatAmount(params.initialEpochReward),
        halvingIntervalEpochs: params.halvingIntervalEpochs,
        maxSupply: formatAmount(params.maxSupply),
      },
      epochs,
      missing: null,
      reason: null,
    };
  }

  /**
   * Mint an epoch's scheduled emission.
   *
   * svc-token is the ONLY minter. svc-mining-pool (Phase 5) requests an epoch
   * allocation from here; it never mints. The epoch row is the dedupe: a closed
   * epoch cannot be minted twice, and the ledger's idempotency key on
   * `token.emission:<assetId>:<epoch>` is the backstop if this check is ever bypassed.
   */
  async mintEpoch(epoch: number, destination = rewardsEngine(this.assetId)): Promise<{ epoch: number; minted: Amount }> {
    return withMoneySpan('token.mintEpoch', { operation: 'emission', epoch }, async () => this.mintEpochInner(epoch, destination));
  }

  /** Mint the next sequential epoch. Used by the auto-tick and operator surface. */
  async mintNextEpoch(destination = rewardsEngine(this.assetId)): Promise<{ epoch: number; minted: Amount }> {
    const epoch = await this.nextEmissionEpoch();
    return this.mintEpoch(epoch, destination);
  }

  private async mintEpochInner(
    epoch: number,
    destination: ReturnType<typeof rewardsEngine>,
  ): Promise<{
    epoch: number;
    minted: Amount;
  }> {
    // The mint recipe credits `this.assetId`, so a destination keyed to another
    // asset would put this deployment's tokens into a foreign asset's account.
    // The default used to be a hardcoded `rewardsEngine('IFC')` while
    // TOKEN_ASSET_ID is configurable (env.ts) — a testnet running its own symbol
    // minted that symbol into an IFC account. Fixing the default is not enough:
    // an explicit caller can still pass a mismatch, and this is a mint.
    if (destination.assetId !== this.assetId) {
      throw new TokenError(
        `Emission destination is an ${destination.assetId} account but this service mints ${this.assetId}`,
        'token.params_invalid',
      );
    }

    // Claim COMMITS before the ledger post — same shape as `stake` / buyback.
    // Wrapping claim+post in one Postgres transaction would roll back the row
    // on process death after the post, under-booking the ceiling again.
    const claimed = await this.claimEmissionEpoch(epoch);

    // Keep the claim on every rejection. Even a typed auth/validation refusal
    // on a retry cannot prove that an earlier request with this key did not
    // commit. Releasing it would remove reserved supply and permit a later
    // epoch to exceed maxSupply. A later retry uses this snapshotted reward
    // and the same idempotency key.
    await this.ledger.post(recipes.mintEmission({ epoch, assetId: this.assetId, amount: claimed.reward, destination }));

    await this.sql`
      UPDATE token.emission_epochs
         SET closed = true, mined_amount = ${formatAmount(claimed.reward)}::numeric
       WHERE epoch = ${epoch} AND closed = false
    `;

    return { epoch, minted: claimed.reward };
  }

  /**
   * Claim an epoch open with a snapshotted scheduled amount, or resume one.
   *
   * CLAIM-BEFORE-POST (W4 residual / L13 A1). Previous order was post → insert
   * closed row. A crash between those left real supply on the ledger with no
   * `emission_epochs` row, so `SUM(mined_amount)` under-booked the ceiling and a
   * retune could mint past the cap. A retry also re-read today's `token_params`
   * and could disagree with the amount the first post already spent on its
   * ledger key.
   *
   * Open claims set `mined_amount = scheduled_amount` so the ceiling reserves
   * the supply before the irreversible post. Resume never recomputes reward
   * from a possibly retuned curve.
   */
  private async claimEmissionEpoch(epoch: number): Promise<{ reward: Amount }> {
    const emission = await this.emissionParams();
    return transaction(
      this.sql,
      async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`token.mint:${this.assetId}`})::bigint)`;

        const rows = await tx<Array<{ epoch: number; closed: boolean; scheduled_amount: string }>>`
          SELECT epoch, closed, scheduled_amount
            FROM token.emission_epochs WHERE epoch = ${epoch} FOR UPDATE
        `;
        const existing = rows[0];
        if (existing?.closed) {
          throw new TokenError(`Epoch ${epoch} is already closed`, 'token.epoch_closed');
        }
        if (existing) {
          // Resume open claim: never recompute from a possibly retuned curve.
          const reward = parseAmount(existing.scheduled_amount);
          if (reward <= 0n) throw new TokenError('Emission schedule is exhausted', 'token.supply_exhausted');
          return { reward };
        }

        const reward = epochReward(epoch, emission);
        if (reward <= 0n) throw new TokenError('Emission schedule is exhausted', 'token.supply_exhausted');

        const cumulative = cumulativeEmission(epoch, emission);
        if (cumulative > emission.maxSupply) {
          throw new TokenError('Emission would exceed max supply', 'token.supply_exhausted');
        }

        /**
         * THE CEILING HAS TO BE MEASURED AGAINST THE BOOK, NOT AGAINST THE PLAN.
         *
         * The guard above asks the CURVE what should have been emitted by this
         * epoch. The curve lives in `token_params.emission_curve` and
         * `token_params.total_supply`, both of which are editable — §4.3 hands
         * parameter control to governance on purpose, and the README's whole
         * argument for the kill-switch is that a curve can be MIS-TUNED and
         * retuned.
         *
         * So the plan can be rewritten under an already-minted supply. Mint
         * epochs 0..k under a generous curve, then lower `initialEpochReward`
         * (or lower `total_supply`) — and `cumulativeEmission(k+1)` recomputes
         * small, passes the cap, and mints again. What was already emitted is
         * nowhere in that comparison. Nothing else catches it either:
         * `emission_epochs_mined_within_scheduled_ck` bounds one ROW against its
         * own schedule, never the total against the cap.
         *
         * The book cannot be retuned. `SUM(mined_amount)` is what this service
         * has claimed or closed — open claims reserve supply the same way a
         * closed row does — and it is the only figure the ceiling can honestly
         * be measured against — "inflation cannot be un-minted" is precisely
         * why this must refuse BEFORE the post.
         */
        const [emitted] = await tx<Array<{ total: string }>>`
          SELECT COALESCE(SUM(mined_amount), 0) AS total FROM token.emission_epochs
        `;
        const alreadyEmitted = parseAmount(emitted?.total ?? '0');
        if (alreadyEmitted + reward > emission.maxSupply) {
          throw new TokenError(
            `Minting epoch ${epoch} would take emitted supply to ${formatAmount(alreadyEmitted + reward)} ${this.assetId}, ` +
              `past the ${formatAmount(emission.maxSupply)} cap — ${formatAmount(alreadyEmitted)} is already emitted`,
            'token.supply_exhausted',
          );
        }

        /**
         * TIME GATE — a NEW epoch may not start sooner than one epoch length
         * after the previous one was claimed.
         *
         * Placed after the resume branch above (a claimed-but-unclosed epoch is a
         * retry of the SAME epoch and is never refused here) and after the supply
         * checks (an exhausted schedule should say so, not "wait"). It runs under
         * the per-asset advisory lock taken at the top of this transaction, so two
         * concurrent callers are serialised: the second sees the first's row.
         *
         * The clock is the DATABASE's: `created_at` is stamped with
         * `clock_timestamp()` below and the elapsed time is measured with
         * `clock_timestamp()` here, so app-server clock skew and restarts cannot
         * move the gate. `clock_timestamp()` rather than `now()` because `now()` is
         * the transaction start, which predates a wait on the advisory lock.
         */
        if (this.emissionEpochMs > 0) {
          const [last] = await tx<Array<{ epoch: number; elapsed_ms: number | string }>>`
            SELECT epoch, (EXTRACT(EPOCH FROM (clock_timestamp() - created_at)) * 1000)::float8 AS elapsed_ms
              FROM token.emission_epochs
             ORDER BY created_at DESC, epoch DESC
             LIMIT 1
          `;
          if (last) {
            const elapsedMs = Number(last.elapsed_ms);
            const remainingMs = Math.ceil(this.emissionEpochMs - elapsedMs);
            if (remainingMs > 0) {
              throw new TokenError(
                `Epoch ${epoch} cannot start yet: epochs are ${describeDuration(this.emissionEpochMs)} long and epoch ${last.epoch} ` +
                  `was claimed ${describeDuration(Math.max(0, elapsedMs))} ago — wait ${describeDuration(remainingMs)} more`,
                'token.epoch_too_early',
                remainingMs,
              );
            }
          }
        }

        await tx`
          INSERT INTO token.emission_epochs (epoch, scheduled_amount, mined_amount, closed, created_at)
          VALUES (${epoch}, ${formatAmount(reward)}::numeric, ${formatAmount(reward)}::numeric, false, clock_timestamp())
        `;

        return { reward };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  // ── Governance — ballots + close tally (§4.3) ──────────────────────────────
  //
  // `closeProposal` writes `passed` | `rejected` from the snapshotted tally
  // against owner env bps. It does not execute: grant/listing return
  // `token.governance_execute_unwired` and never post. `executed` / `cancelled`
  // stay unwired.

  /** The founders' voting delay and period (MC-token-02). Null means not set. */
  governanceSettings(): Promise<GovernanceSettings> {
    return readGovernanceSettings(this.sql);
  }

  governanceSettingsHistory() {
    return governanceSettingsHistory(this.sql);
  }

  /** Refuses, without writing, a settings change the write would refuse. */
  precheckGovernanceSettings(input: Parameters<typeof precheckGovernanceSettings>[1]): Promise<void> {
    return precheckGovernanceSettings(this.sql, input);
  }

  /** Refuses, without writing, a role move the write would refuse. */
  precheckGovernanceRole(input: Parameters<typeof precheckGovernanceRole>[1]): Promise<void> {
    return precheckGovernanceRole(this.sql, input);
  }

  setGovernanceSettings(input: Parameters<typeof setGovernanceSettings>[1]): Promise<GovernanceSettings> {
    return setGovernanceSettings(this.sql, input);
  }

  governanceRoles(limit: number): Promise<GovernanceRoleRow[]> {
    return governanceRoles(this.sql, limit);
  }

  governanceRoleOf(userId: string): Promise<GovernanceRole | null> {
    return governanceRoleOf(this.sql, userId);
  }

  setGovernanceRole(input: Parameters<typeof setGovernanceRole>[1]): Promise<GovernanceRoleRow> {
    return setGovernanceRole(this.sql, input);
  }

  /** A governance moderator, admin or controller cancels a draft or open proposal with a reason; its votes stay. */
  async cancelProposal(input: { proposalId: string; reason: string; actorId: string; now?: Date }): Promise<ProposalRecord> {
    await cancelGovernanceProposal(this.sql, { ...input, now: input.now ?? new Date() });
    const row = await loadProposalRow(this.sql, input.proposalId);
    if (!row) throw new TokenError(`Proposal ${input.proposalId} not found`, 'token.proposal_not_found');
    return row;
  }

  /**
   * Open a proposal. Who may propose and how many per period are owner
   * settings: blank refuses, and admin does not bypass a blank or the cap.
   * `asAdmin` skips only the membership check. No ledger recipe.
   *
   * A future `opensAt` stays `draft` until `openDueProposals`. A window that
   * already contains `now` is inserted `open`.
   *
   * The stored id is `gov:proposal:<space>:<author>:<ordinal>`. The client
   * sends one request handle. Stake for the rule is read in that insert,
   * after the author lock, not from a total taken before it.
   */
  async createProposal(input: {
    kind: ProposalKind;
    body?: Record<string, unknown>;
    createdBy: string;
    /** Operator path — skips the membership check, not a blank rule or the cap. */
    asAdmin?: boolean;
    opensAt?: Date;
    closesAt?: Date;
    /** Stored retry handle. Required. A missing handle is `token.proposal_handle_invalid`. */
    handle?: string;
    title?: string;
    bodyMd?: string;
    discussionLink?: string;
    /** `basic` (for/against/abstain) when omitted. Other types need `choices` (MC-token-03). */
    votingType?: string;
    choices?: string[];
    now?: Date;
  }): Promise<ProposalRecord> {
    const now = input.now ?? new Date();
    const votingType = assertBallotType(input.votingType ?? 'basic');
    const choices = asBallotError(() => normalizeChoices(votingType, input.choices));
    const asAdmin = input.asAdmin === true;
    const peeked = await assessProposalAccess(this.sql, { userId: input.createdBy, asAdmin, staked: 0n, now });
    if (peeked.code === 'token.proposer_rule_unset' || peeked.code === 'token.proposal_limit_unset') {
      throw new TokenError(
        peeked.code === 'token.proposer_rule_unset' ? 'Who may open a proposal is not set' : 'The proposal limit is not set',
        peeked.code,
      );
    }

    // One read of every active stake per attempt, locked in id order. The author's stake for the proposer rule comes
    // from the same read, so two authors creating at once take their row locks in one order and cannot deadlock.
    const snapshots = new WeakMap<Sql, Promise<Map<string, Amount>>>();
    const snapshotOf = (tx: Sql) => {
      let read = snapshots.get(tx);
      if (!read) {
        read = this.snapshotActiveStake(tx).then((snap) => snap.byUser);
        snapshots.set(tx, read);
      }
      return read;
    };

    return insertGovernanceProposal(this.sql, {
      kind: input.kind,
      body: input.body ?? {},
      authorId: input.createdBy,
      asAdmin,
      // A time the author leaves out comes from the founders' voting delay and period, read after the proposer rule
      // passes; a blank one refuses `token.proposal_window_unset` (MC-token-02).
      window: async (tx) => {
        const needsSettings = !input.opensAt || !input.closesAt;
        const settings = needsSettings ? await readGovernanceSettings(tx) : { votingDelayMs: null, votingPeriodMs: null };
        const window = proposalWindow(settings, { opensAt: input.opensAt, closesAt: input.closesAt, now });
        if (!(window.closesAt.getTime() > window.opensAt.getTime())) {
          throw new TokenError('Proposal window must close after it opens', 'token.proposal_window');
        }
        return window;
      },
      now,
      handle: input.handle,
      title: input.title,
      bodyMd: input.bodyMd,
      discussionLink: input.discussionLink,
      lockedStake: async (tx) => (await snapshotOf(tx)).get(input.createdBy) ?? 0n,
      votingType,
      choices,
      snapshot: snapshotOf,
    });
  }

  async editProposal(input: {
    proposalId: string;
    authorId: string;
    title?: string;
    bodyMd?: string;
    discussionLink?: string;
    body?: Record<string, unknown>;
    opensAt?: Date;
    closesAt?: Date;
  }): Promise<ProposalRecord> {
    return editGovernanceDraft(this.sql, input);
  }

  async followSpace(userId: string, following: boolean): Promise<{ spaceId: string; following: boolean }> {
    return setGovernanceFollow(this.sql, userId, following);
  }

  async governanceHome(userId: string, asAdmin: boolean): Promise<{ spaceId: string; following: boolean; proposal: ProposalAccess }> {
    const space = await readGovernanceSpace(this.sql, userId);
    const now = new Date();
    const peeked = await assessProposalAccess(this.sql, { userId, asAdmin, staked: 0n, now });
    if (peeked.code === 'token.proposer_rule_unset' || peeked.code === 'token.proposal_limit_unset' || peeked.minStake == null) {
      return { ...space, proposal: peeked };
    }
    const staked = asAdmin ? 0n : await this.stakeOf(userId);
    return { ...space, proposal: await assessProposalAccess(this.sql, { userId, asAdmin, staked, now }) };
  }

  /** Move due drafts to `open`. A second run changes nothing. Does not open a future window. */
  async openDueProposals(now?: Date): Promise<{ opened: number }> {
    return { opened: await openDueDrafts(this.sql, now ?? new Date()) };
  }

  /**
   * Cast one ballot.
   *
   * A proposal created with a snapshot (MC-token-03) weighs the ballot by the
   * voting power stored at creation, and `eligible_stake` is that snapshot's
   * total: stake opened or closed after creation changes neither. A proposal
   * from before snapshots keeps the old read (active stake at this instant).
   *
   * Who may vote is the published rule (`TOKEN_VOTE_RULE`); blank refuses
   * `token.vote_rule_unset` before any write. Every vote is signed (OWNER
   * 108): no signature refuses `token.vote_signature_required`; identity then
   * checks the signer of `voteMessage` against the account's linked wallets,
   * before the transaction. No answer, no IDENTITY_URL, no linked wallet or an
   * account that may not act refuse `token.signed_vote_unavailable`; any other
   * signer refuses `token.vote_signature_invalid`. The signer and signature
   * are stored on the vote. Zero weight is refused, never recorded.
   */
  async castVote(input: {
    proposalId: string;
    userId: string;
    /** For/against/abstain on a `basic` proposal; `abstain` on any type. */
    choice?: VoteChoice;
    /** A ballot for a non-basic type. Exactly one of `choice` and `ballot`. */
    ballot?: Ballot;
    /** A linked wallet's EIP-191 signature over `voteMessage(...)`. Required. */
    signature?: string;
    now?: Date;
  }): Promise<VoteRecord> {
    if (input.signature === undefined || input.signature === '') {
      throw new TokenError('A vote must be signed by a wallet linked to the account', 'token.vote_signature_required');
    }
    const rule = parseVoteRule(this.options.voteRule ?? process.env.TOKEN_VOTE_RULE);
    if ((input.choice === undefined) === (input.ballot === undefined)) {
      throw new TokenError('A vote is either a for/against/abstain choice or a ballot', 'token.ballot_invalid');
    }
    const now = input.now ?? new Date();
    const signature = input.signature.toLowerCase();
    // The message as signed: the stored ballot below is canonical and may differ in order from the request.
    const signedMessage = voteMessage(input);
    const signedBy = await this.voteSigner(input.userId, signedMessage, signature);

    return transaction(
      this.sql,
      async (tx) => {
        const proposals = await tx<
          Array<{
            id: string;
            status: ProposalStatus;
            opens_at: Date;
            closes_at: Date;
            voting_type: string | null;
            choices: unknown;
            snapshot_count: number | null;
            snapshot_total: string | null;
            snapshot_hash: string | null;
          }>
        >`
          SELECT id, status, opens_at, closes_at, voting_type, choices,
                 snapshot_count, snapshot_total::text AS snapshot_total, snapshot_hash
            FROM token.proposals
           WHERE id = ${input.proposalId}
           FOR UPDATE
        `;

        const proposal = proposals[0];
        if (!proposal) throw new TokenError(`Proposal ${input.proposalId} not found`, 'token.proposal_not_found');
        if (proposal.status !== 'open') {
          throw new TokenError(`Proposal is ${proposal.status}, not open for voting`, 'token.proposal_not_open');
        }
        if (now.getTime() < proposal.opens_at.getTime() || now.getTime() >= proposal.closes_at.getTime()) {
          throw new TokenError('Proposal voting window is not active', 'token.proposal_window');
        }

        const votingType = assertBallotType(proposal.voting_type ?? 'basic');
        let choice: VoteChoice | null = null;
        let ballot: Ballot | null = null;
        if (votingType === 'basic') {
          if (input.choice === undefined) throw new TokenError('A basic proposal takes for, against or abstain', 'token.ballot_invalid');
          choice = input.choice;
        } else if (input.choice !== undefined) {
          if (input.choice !== 'abstain') throw new TokenError('This proposal takes a ballot, not for or against', 'token.ballot_invalid');
          ballot = { kind: 'abstain' };
        } else {
          const count = Array.isArray(proposal.choices) ? proposal.choices.length : 0;
          ballot = asBallotError(() => validateBallot(votingType, count, input.ballot!));
        }

        // Use `tx` — outer `this.sql` while FOR UPDATE is held deadlocks the pool.
        const seal = sealFromRow(proposal);
        // A proposal from before snapshots has no power fixed at creation, so it is never weighed by today's stake.
        if (!seal) {
          throw new TokenError('No voting power was fixed when this proposal was created', 'token.governance_snapshot_missing');
        }
        const power = await readSealedSnapshot(tx, input.proposalId, seal);
        const weight = power.get(input.userId) ?? 0n;
        const eligible = seal.total;
        if (weight <= 0n) {
          throw new TokenError('No voting power on this proposal — voting weight is zero', 'token.no_voting_weight');
        }
        if (weight < rule.minPower) {
          throw new TokenError('Voting power on this proposal is below the vote rule', 'token.vote_rule_not_met');
        }

        const voteId = crypto.randomUUID();
        try {
          const rows = await tx<
            Array<{
              id: string;
              proposal_id: string;
              user_id: string;
              weight: string;
              choice: VoteChoice | null;
              ballot: unknown;
              cast_at: Date;
              signed_by: string;
            }>
          >`
            INSERT INTO token.governance_votes (
              id, proposal_id, user_id, weight, eligible_stake, choice, ballot, cast_at, signed_by, signature, signed_message
            )
            VALUES (
              ${voteId}, ${input.proposalId}, ${input.userId},
              ${formatAmount(weight)}::numeric, ${formatAmount(eligible)}::numeric,
              ${choice}, ${ballot === null ? null : tx.json(ballot as never)}, ${now}, ${signedBy}, ${signature}, ${signedMessage}
            )
            RETURNING id, proposal_id, user_id, weight, choice, ballot, cast_at, signed_by
          `;

          const row = rows[0]!;
          return {
            id: row.id,
            proposalId: row.proposal_id,
            userId: row.user_id,
            weight: parseAmount(row.weight),
            choice: row.choice,
            ballot: asBallotError(() => parseStoredBallot(row.ballot)),
            castAt: row.cast_at,
            signedBy: row.signed_by,
          };
        } catch (err) {
          // Unique (proposal_id, user_id) — one ballot per member.
          if (isUniqueViolation(err)) {
            throw new TokenError('Already voted on this proposal', 'token.already_voted');
          }
          throw err;
        }
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  /** The linked wallet that signed this vote's message, or the typed refusal. Asked before any lock is taken. */
  private async voteSigner(userId: string, message: string, signature: string): Promise<string> {
    const port = this.options.voteSignatures;
    const unavailable = (why: string) => new TokenError(`Signed votes cannot be checked: ${why}`, SIGNED_VOTE_UNAVAILABLE);
    if (!port) throw unavailable('the identity service is not configured');
    const answer = await port.verify({ userId, message, signature });
    if (answer === null) throw unavailable('the identity service did not answer');
    switch (answer.state) {
      case 'linked':
        return answer.address;
      case 'no_wallet':
        throw unavailable('no wallet is linked to this account');
      case 'account_inactive':
        throw unavailable('this account may not act');
      default:
        // not_linked or invalid.
        throw new TokenError('The vote is not signed by a wallet linked to this account', 'token.vote_signature_invalid');
    }
  }

  /** The signed account's voting power on one proposal, fixed at creation. Zero carries its reason. */
  async proposalPower(proposalId: string, userId: string): Promise<ProposalPower & { rule: VoteRuleState }> {
    const power = await readProposalPower(this.sql, proposalId, userId);
    return { ...power, rule: this.voteRuleState() };
  }

  /** Whether a signed vote can be checked at all: false when no identity is configured. A linked wallet is identity's to say. */
  signedVotesConfigured(): boolean {
    return this.options.voteSignatures !== undefined;
  }

  /** Who may vote, as the pane shows it: the minimum, or the typed code a vote would be refused with. Never a default. */
  voteRuleState(): VoteRuleState {
    try {
      return { minPower: parseVoteRule(this.options.voteRule ?? process.env.TOKEN_VOTE_RULE).minPower, code: null };
    } catch (err) {
      if (err instanceof TokenError) return { minPower: null, code: err.code };
      throw err;
    }
  }

  /** The signed account's stored voting power, one row per proposal snapshot, newest first. */
  async votingPowerHistory(userId: string, limit: number | undefined): Promise<PowerHistoryEntry[]> {
    return readPowerHistory(this.sql, userId, limit);
  }

  /** Per-choice tally of a non-basic proposal from its stored ballots. */
  private async choiceTallyOf(sql: Sql, card: ProposalRecord): Promise<ChoiceTally | null> {
    if (card.votingType === 'basic') return null;
    const rows = await sql<Array<{ weight: string; choice: VoteChoice | null; ballot: unknown }>>`
      SELECT weight::text AS weight, choice, ballot
        FROM token.governance_votes
       WHERE proposal_id = ${card.id}
       ORDER BY cast_at, id
    `;
    return asBallotError(() =>
      tallyChoices(
        card.votingType,
        card.choices?.length ?? 0,
        rows.map((row) => ({ weight: parseAmount(row.weight), choice: row.choice, ballot: parseStoredBallot(row.ballot) })),
      ),
    );
  }

  async listProposals(
    input: {
      status?: ProposalStatus;
      kind?: ProposalKind;
      /** Text search over title and markdown. Blank is no filter, not an error. */
      q?: string;
      limit?: number;
    } = {},
  ): Promise<ProposalRecord[]> {
    const limit = assertProposalListLimit(input.limit);
    return listGovernanceProposals(this.sql, {
      status: input.status,
      kind: input.kind,
      q: input.q,
      limit,
    });
  }

  /**
   * One proposal plus a tally computed at read time.
   *
   * The tally is a REPORT until `closeProposal` consumes it. Close is what
   * writes `passed` | `rejected`; this read does not.
   */
  async getProposal(proposalId: string): Promise<ProposalDetail> {
    const row = await loadProposalRow(this.sql, proposalId);
    if (!row) throw new TokenError(`Proposal ${proposalId} not found`, 'token.proposal_not_found');

    const tallies = await this.sql<Array<{ choice: VoteChoice; weight: string; n: string }>>`
      SELECT choice, COALESCE(SUM(weight), 0)::text AS weight, COUNT(*)::text AS n
        FROM token.governance_votes
       WHERE proposal_id = ${proposalId}
         AND choice IS NOT NULL
       GROUP BY choice
    `;

    const folded = foldTally(tallies);
    const choiceTally = await this.choiceTallyOf(this.sql, row);
    if (choiceTally) {
      // A non-basic proposal has no for/against. Counts come from the card.
      return {
        ...row,
        choiceTally,
        tally: {
          forWeight: 0n,
          againstWeight: 0n,
          abstainWeight: choiceTally.abstainWeight,
          totalWeight: choiceTally.participatingWeight,
          voterCount: choiceTally.voterCount,
        },
      };
    }

    return {
      ...row,
      choiceTally,
      counts: {
        votes: folded.voterCount,
        for: folded.forCount,
        against: folded.againstCount,
        abstain: folded.abstainCount,
      },
      tally: {
        forWeight: folded.forWeight,
        againstWeight: folded.againstWeight,
        abstainWeight: folded.abstainWeight,
        totalWeight: folded.forWeight + folded.againstWeight + folded.abstainWeight,
        voterCount: folded.voterCount,
      },
    };
  }

  /**
   * Close an open proposal whose window has ended. Writes `passed` | `rejected`.
   *
   * Quorum = participating weight vs the eligible stake snapshotted on the
   * ballots (the greatest electorate any ballot was cast against), in owner
   * bps. That is the same read `castVote` stored beside the weight. A later
   * unstake does not shrink it, and a stake opened after the window is not
   * in it. Active rows are still the claim index: a row that disagrees with
   * its pot refuses `token.stake_ledger_mismatch` — never a drifted SUM, and
   * never the live sum, as the bar. A ballot with no snapshot refuses
   * `token.governance_snapshot_missing` — never zero, which would make quorum
   * vacuously true. Pass = for / (for+against) in owner bps. Blank owner bps
   * refuse `token.governance_quorum_unset` — never a compiled bar.
   *
   * Grant / listing: status is written; `execute` is
   * `token.governance_execute_unwired`. No ledger post.
   */
  async closeProposal(input: { proposalId: string; now?: Date }): Promise<ProposalCloseResult> {
    const quorumBps = this.options.governanceQuorumBps;
    const thresholdBps = this.options.governanceThresholdBps;
    const now = input.now ?? new Date();

    return transaction(
      this.sql,
      async (tx) => {
        const proposals = await tx<
          Array<{
            id: string;
            kind: ProposalKind;
            body: Record<string, unknown>;
            status: ProposalStatus;
            opens_at: Date;
            closes_at: Date;
            created_at: Date;
            title: string | null;
            body_md: string | null;
            discussion_link: string | null;
            business_key: string | null;
            author_id: string | null;
            revision: number | null;
            voting_type: string | null;
            choices: unknown;
            snapshot_count: number | null;
            snapshot_total: string | null;
            snapshot_hash: string | null;
            ranking: unknown;
          }>
        >`
          SELECT id, kind, body, status, opens_at, closes_at, created_at,
                 title, body_md, discussion_link, business_key, author_id, revision,
                 voting_type, choices, snapshot_count, snapshot_total::text AS snapshot_total, snapshot_hash, ranking
            FROM token.proposals
           WHERE id = ${input.proposalId}
           FOR UPDATE
        `;

        const row = proposals[0];
        if (!row) throw new TokenError(`Proposal ${input.proposalId} not found`, 'token.proposal_not_found');
        if (row.status !== 'open') {
          throw new TokenError(`Proposal is ${row.status}, not open for close`, 'token.proposal_not_open');
        }
        if (now.getTime() < row.closes_at.getTime()) {
          throw new TokenError('Proposal voting window is still active', 'token.proposal_window');
        }

        const card = proposalCard(row);
        const choiceTally = await this.choiceTallyOf(tx, card);
        if (choiceTally) {
          // Non-basic types store only the ranking. What a multi-choice result
          // means (quorum, a winner that executes) is the owner's, so nothing
          // passes or fails here and nothing executes.
          await tx`
            UPDATE token.proposals
               SET status = 'closed_ranked',
                   ranking = ${tx.json(choiceTally.ranking as never)}
             WHERE id = ${input.proposalId}
          `;
          const closed = await loadProposalRow(tx, input.proposalId);
          if (!closed) throw new TokenError(`Proposal ${input.proposalId} not found`, 'token.proposal_not_found');
          return {
            ...closed,
            choiceTally,
            tally: {
              forWeight: 0n,
              againstWeight: 0n,
              abstainWeight: choiceTally.abstainWeight,
              totalWeight: choiceTally.participatingWeight,
              voterCount: choiceTally.voterCount,
            },
            execute: executeUnwiredFor(row.kind),
          };
        }
        if (quorumBps === undefined || thresholdBps === undefined) {
          throw new TokenError(
            'Governance quorum/threshold is unset (TOKEN_GOVERNANCE_QUORUM_BPS / TOKEN_GOVERNANCE_THRESHOLD_BPS)',
            GOVERNANCE_QUORUM_UNSET,
          );
        }

        const tallies = await tx<Array<{ choice: VoteChoice; weight: string; n: string }>>`
          SELECT choice, COALESCE(SUM(weight), 0)::text AS weight, COUNT(*)::text AS n
            FROM token.governance_votes
           WHERE proposal_id = ${input.proposalId}
           GROUP BY choice
        `;
        const folded = foldTally(tallies);

        const stakeRows = await tx<Array<{ id: string; user_id: string; amount: string }>>`
          SELECT id, user_id, amount
            FROM token.stakes
           WHERE status = 'active'
           ORDER BY id
        `;
        for (const stakeRow of stakeRows) {
          const recorded = parseAmount(stakeRow.amount);
          const book = (await this.ledger.balance(tokenStakeAccount(stakeRow.user_id, this.assetId, stakeRow.id))).amount;
          if (book !== recorded) {
            throw new TokenError(
              `Stake ${stakeRow.id} table amount ${formatAmount(recorded)} disagrees with ledger ${formatAmount(book)}`,
              'token.stake_ledger_mismatch',
            );
          }
        }

        // Greatest snapshot, not the latest. A later ballot cast after an
        // unstake must not pull the bar under a weight an earlier ballot kept.
        // Stake that appears only after the last ballot — including after the
        // window — is absent from every row, so it cannot inflate the bar.
        const snap = await tx<Array<{ missing: string; eligible: string | null }>>`
          SELECT COUNT(*) FILTER (WHERE eligible_stake IS NULL)::text AS missing,
                 MAX(eligible_stake)::text AS eligible
            FROM token.governance_votes
           WHERE proposal_id = ${input.proposalId}
        `;
        const missing = BigInt(snap[0]?.missing ?? '0');
        if (missing !== 0n) {
          throw new TokenError(
            'A ballot is missing the eligible-stake snapshot from when it was cast',
            'token.governance_snapshot_missing',
          );
        }
        const eligibleRaw = snap[0]?.eligible;
        const eligibleStake = eligibleRaw == null ? 0n : parseAmount(eligibleRaw);

        const status = decideProposalOutcome({
          forWeight: folded.forWeight,
          againstWeight: folded.againstWeight,
          abstainWeight: folded.abstainWeight,
          eligibleStake,
          quorumBps,
          thresholdBps,
        });

        await tx`
          UPDATE token.proposals
             SET status = ${status}
           WHERE id = ${input.proposalId}
        `;

        return {
          ...card,
          status,
          choiceTally: null,
          counts: {
            votes: folded.voterCount,
            for: folded.forCount,
            against: folded.againstCount,
            abstain: folded.abstainCount,
          },
          tally: {
            forWeight: folded.forWeight,
            againstWeight: folded.againstWeight,
            abstainWeight: folded.abstainWeight,
            totalWeight: folded.forWeight + folded.againstWeight + folded.abstainWeight,
            voterCount: folded.voterCount,
          },
          execute: executeUnwiredFor(row.kind),
        };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }
}

/**
 * Fold grouped vote rows into a tally.
 *
 * ACCUMULATES. It used to ASSIGN (`forWeight = w`) while `voterCount` in the
 * very same loop accumulated — two idioms in one loop, correct today only
 * because `GROUP BY choice` happens to yield at most one row per choice. Under
 * assignment, any grouping that returns a choice more than once (per asset, per
 * snapshot, a UNION for delegated weight) silently keeps the LAST row and drops
 * the rest, and dropped weight in a tally is a misreported election.
 *
 * Exported so the invariant is testable at all: with one row per choice the two
 * idioms are indistinguishable from outside, which is exactly why the bug
 * survived. It is not exported for callers — `getProposal` is the caller.
 *
 * Close consumes this fold. The read-time tally on `getProposal` stays a report.
 */
export function foldTally(rows: Array<{ choice: VoteChoice; weight: string; n: string }>): {
  forWeight: Amount;
  againstWeight: Amount;
  abstainWeight: Amount;
  voterCount: number;
  forCount: number;
  againstCount: number;
  abstainCount: number;
} {
  let forWeight = 0n;
  let againstWeight = 0n;
  let abstainWeight = 0n;
  let voterCount = 0;
  let forCount = 0;
  let againstCount = 0;
  let abstainCount = 0;

  for (const t of rows) {
    const w = parseAmount(t.weight);
    const ballots = Number(t.n);
    voterCount += ballots;
    if (t.choice === 'for') {
      forWeight += w;
      forCount += ballots;
    } else if (t.choice === 'against') {
      againstWeight += w;
      againstCount += ballots;
    } else {
      abstainWeight += w;
      abstainCount += ballots;
    }
  }

  return { forWeight, againstWeight, abstainWeight, voterCount, forCount, againstCount, abstainCount };
}

/** Ballot rules raise `BallotError`; the service speaks `TokenError` with the same code. */
/** A stored row this read cannot show. It is the service's data at fault, never the caller's input. */
function voteHistoryUnreadable(): TokenError {
  return new TokenError('A stored vote could not be read', 'token.vote_history_unreadable');
}

function storedVoteHistoryType(value: string): VotingType {
  try {
    return assertVotingType(value);
  } catch {
    throw voteHistoryUnreadable();
  }
}

/** A stored ballot inside the bounds the wire shows (whole choice indexes, 1 to 10 000 bps); anything else is unreadable. */
function storedVoteHistoryBallot(raw: unknown): Ballot | null {
  let ballot: Ballot | null;
  try {
    ballot = parseStoredBallot(raw);
  } catch {
    throw voteHistoryUnreadable();
  }
  const index = (n: number) => Number.isInteger(n) && n >= 0 && n < MAX_CHOICES;
  if (ballot === null || ballot.kind === 'abstain') return ballot;
  if (ballot.kind === 'pick') {
    if (ballot.choices.length < 1 || ballot.choices.length > MAX_CHOICES || !ballot.choices.every(index)) throw voteHistoryUnreadable();
    return { kind: 'pick', choices: [...ballot.choices] };
  }
  if (
    ballot.parts.length < 1 ||
    ballot.parts.length > MAX_CHOICES ||
    !ballot.parts.every((part) => index(part.choice) && Number.isInteger(part.bps) && part.bps >= 1 && part.bps <= BALLOT_BPS)
  ) {
    throw voteHistoryUnreadable();
  }
  // Only the two wire keys, so a stored extra key cannot fail the strict output check.
  return { kind: 'split', parts: ballot.parts.map((part) => ({ choice: part.choice, bps: part.bps })) };
}

function asBallotError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof BallotError) throw new TokenError(err.message, err.code);
    throw err;
  }
}

function assertBallotType(value: string): VotingType {
  return asBallotError(() => assertVotingType(value));
}

function asTokenError(err: unknown): TokenError | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof TokenError) return current;
    if (typeof current !== 'object' || current === null || !('cause' in current)) return undefined;
    current = (current as { cause: unknown }).cause;
  }
  return undefined;
}

/** postgres.js surfaces PG error codes on `err.code` (string); walk `cause`. */
function pgCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;
    if ('code' in current) {
      const code = (current as { code: unknown }).code;
      if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    }
    current = 'cause' in current ? (current as { cause: unknown }).cause : undefined;
  }
  return undefined;
}

function isUniqueViolation(err: unknown): boolean {
  return pgCode(err) === '23505';
}

/**
 * 23P01 `exclusion_violation` — what the non-overlap constraint raises (0002).
 * A different SQLSTATE from a unique violation, so it needs naming separately
 * or it falls through to an unnamed 500, which is the failure mode this whole
 * change exists to remove.
 */
function isExclusionViolation(err: unknown): boolean {
  return pgCode(err) === '23P01';
}

/** Concurrent GiST overlap can deadlock (40P01) or serialize-fail (40001). */
function isContention(err: unknown): boolean {
  const code = pgCode(err);
  return code === '40P01' || code === '40001';
}

/** Dates are half-open window bounds here; always render them unambiguously. */
function iso(d: Date): string {
  return d.toISOString();
}

/**
 * Asset id sanity, not an asset registry.
 *
 * Deliberately permissive: this service does not own the list of tradable
 * assets, and inventing one here would be inventing product law. It rejects
 * only what cannot be an identifier at all — empty, whitespace-bearing, or
 * absurdly long keys, which are the shapes that indicate a caller sent the
 * wrong structure entirely.
 */
const ASSET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * Validate and canonicalise `revenueTotal` before it reaches jsonb.
 *
 * This column is the audit record of what a run was sized against — the only
 * written answer to "which revenue did we burn against". It was previously
 * `z.record(z.string(), z.string())` on the wire and written through untouched, so
 * `{"IFC":"not-a-number","USDT":"-999","BTC":"1e400"}` stored cleanly. That is
 * not a cosmetic defect: an unparseable audit figure cannot be reconciled
 * against the ledger later, which is the one thing it is for.
 *
 * Money law (§0.6): decimal strings on the wire, scaled bigint in memory, never
 * a `number`. `parseAmount` is the only thing that decides what a valid amount
 * is, so it is the thing used here — and the value is re-emitted through
 * `formatAmount` so that "1000", "1000.0" and "1000.000" are stored as the one
 * number they are, rather than three spellings of it.
 */
function normaliseRevenueTotal(raw: Record<string, string>): Record<string, string> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TokenError('revenueTotal must be an object of assetId → decimal amount string', 'token.buyback_revenue_invalid');
  }

  const out: Record<string, string> = {};

  for (const [assetId, value] of Object.entries(raw)) {
    if (!ASSET_ID_RE.test(assetId)) {
      throw new TokenError(`revenueTotal key ${JSON.stringify(assetId)} is not a usable asset id`, 'token.buyback_revenue_invalid');
    }

    if (typeof value !== 'string') {
      throw new TokenError(
        `revenueTotal[${JSON.stringify(assetId)}] must be a decimal STRING — a ${typeof value} cannot carry money (§0.6)`,
        'token.buyback_revenue_invalid',
      );
    }

    let amount: Amount;
    try {
      amount = parseAmount(value);
    } catch (err) {
      // A MoneyError is neither a TokenError nor a LedgerError, so letting it
      // escape would be another opaque 500. Name it.
      throw new TokenError(
        `revenueTotal[${JSON.stringify(assetId)}] is not a valid amount: ${err instanceof Error ? err.message : String(err)}`,
        'token.buyback_revenue_invalid',
      );
    }

    if (amount < 0n) {
      throw new TokenError(
        `revenueTotal[${JSON.stringify(assetId)}] is negative (${value}) — revenue collected cannot be negative`,
        'token.buyback_revenue_invalid',
      );
    }

    out[assetId] = formatAmount(amount);
  }

  return out;
}
