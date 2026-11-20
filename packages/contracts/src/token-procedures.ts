import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import { defineProcedure, NO_INPUT, type Refusals } from './procedure.js';
import { jsonValueSchema } from './procedure-strict-schema.js';
import {
  tokenAccessViewSchema,
  tokenAmountSchema as amount,
  tokenBallotSchema,
  tokenBurnedSupplySchema,
  tokenPowerHistorySchema,
  tokenProposalClosedSchema,
  tokenProposalDetailSchema,
  tokenProposalIdSchema,
  tokenProposalKindSchema,
  tokenProposalPowerSchema,
  tokenProposalStatusSchema,
  tokenProposalViewSchema,
  tokenStakeViewSchema,
  tokenVoteChoiceSchema,
  tokenVoteMessageSchema,
  tokenVoteSchema,
  tokenVotingTypeSchema,
  TOKEN_MAX_CHOICES,
} from './token-governance.js';

/**
 * svc-token's calls an app makes, one record per call. svc-token mounts each from here (`mountRecord` in its router,
 * which is not made from records as a whole yet), so its path, guard, input, output and named refusals are this file.
 * A `TokenError` leaves with the status svc-token's `toTrpcError` gives its code; the lists below say which may leave.
 */

const base = { service: 'svc-token', module: 'token', transport: 'trpc' } as const;
/** A token reader, on the token module's jurisdiction check. */
const READER = { caller: 'scope', scope: 'token:read', module: 'token' } as const;
/** A token reader with no module check (a public supply figure). */
const ANY_READER = { caller: 'scope', scope: 'token:read' } as const;
/** A member who stakes and votes, on the token module's jurisdiction check. */
const STAKER = { caller: 'scope', scope: 'token:stake', module: 'token' } as const;
/** Any signed-in account: the handler decides between a staker and an operator (`token:stake` or `admin:write`). */
const SIGNED_IN = { caller: 'signedIn' } as const;
/** A member's read the console reads too: the first of `token:read` and `admin:read` the caller holds. */
const MEMBER_OR_OPERATOR = { caller: 'anyScope', scopes: ['token:read', 'admin:read'] } as const;
/** The console's reads and the founders' two-person writes. */
const OPERATOR_READ = { caller: 'scope', scope: 'admin:read' } as const;
const OPERATOR_WRITE = { caller: 'scope', scope: 'admin:write' } as const;

const freeze = (r: Refusals): Refusals => Object.freeze(r);
const PARAMS_REASON = z.enum(['token.params_unset', 'token.params_missing', 'token.params_invalid']);
const iso = z.string().datetime({ offset: true });
const bps = z.number().int().min(0).max(10_000);

/** A page of history: the size is optional so an omit reaches `token.history_list_limit_unset`, never a zod "Required". */
export const tokenHistoryInputSchema = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .default({});

/** A payout history page (`yieldHistory`, `revenueShareHistory`): one row per weekly window, read from its posting. */
export const tokenPayoutHistorySchema = z.object({
  items: z.array(
    z.object({
      windowId: z.string(),
      amount: amount.nullable(),
      assetId: assetIdSchema.nullable(),
      ledgerTxId: z.string().nullable(),
      reason: z.literal('ledger_tx_unread').nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export const TOKEN_ACCESS_OF = defineProcedure({
  ...base,
  name: 'token.accessOf',
  kind: 'query',
  path: 'accessOf',
  access: READER,
  refusals: freeze({
    'token.params_unset': 'PRECONDITION_FAILED',
    'token.params_invalid': 'BAD_REQUEST',
    'token.fee_discount_invalid': 'BAD_REQUEST',
    'token.stake_ledger_mismatch': 'PRECONDITION_FAILED',
  }),
  input: z.object({}).optional(),
  output: tokenAccessViewSchema,
  samples: [{ verdict: 'accept' }, { verdict: 'accept', input: {} }, { verdict: 'refuse', input: 7 }],
});

export const TOKEN_LIST_STAKES = defineProcedure({
  ...base,
  name: 'token.listStakes',
  kind: 'query',
  path: 'listStakes',
  access: READER,
  refusals: freeze({ 'token.stakes_list_limit_unset': 'PRECONDITION_FAILED' }),
  input: z
    .object({
      status: z.enum(['active', 'closed', 'pending', 'all']).default('active'),
      /** Optional so an omit reaches `token.stakes_list_limit_unset`; blank is not 50. */
      limit: z.number().int().min(1).max(200).optional(),
    })
    .default({ status: 'active' }),
  output: z.array(tokenStakeViewSchema),
  samples: [
    { verdict: 'accept', input: { status: 'all', limit: 50 } },
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: { status: 'gone' } },
    { verdict: 'refuse', input: { limit: 0 } },
  ],
});

export const TOKEN_EMISSION_SCHEDULE = defineProcedure({
  ...base,
  name: 'token.emissionSchedule',
  kind: 'query',
  path: 'emissionSchedule',
  access: READER,
  refusals: freeze({ 'token.emission_schedule_count_unset': 'PRECONDITION_FAILED' }),
  input: z.object({ count: z.number().int().min(1).max(200).optional() }).default({}),
  output: z.object({
    params: z
      .object({
        initialEpochReward: amount,
        halvingIntervalEpochs: z.number().int().positive(),
        maxSupply: amount,
      })
      .nullable(),
    epochs: z.array(z.object({ epoch: z.number().int().nonnegative(), reward: amount })).nullable(),
    missing: z.string().nullable(),
    reason: PARAMS_REASON.nullable(),
  }),
  accept: {
    setOrRefused: {
      says: 'the owner parameters are there exactly when no reason is given',
      holds: (reply) =>
        typeof reply === 'object' &&
        reply !== null &&
        'params' in reply &&
        'reason' in reply &&
        (reply.params === null) === (reply.reason !== null),
    },
  },
  samples: [
    { verdict: 'accept', input: { count: 12 } },
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: { count: 0 } },
  ],
});

export const TOKEN_REVENUE_SHARE_HISTORY = defineProcedure({
  ...base,
  name: 'token.revenueShareHistory',
  kind: 'query',
  path: 'revenueShareHistory',
  access: READER,
  refusals: freeze({ 'token.history_list_limit_unset': 'PRECONDITION_FAILED', 'token.history_cursor_invalid': 'BAD_REQUEST' }),
  input: tokenHistoryInputSchema,
  output: tokenPayoutHistorySchema,
  samples: [
    { verdict: 'accept', input: { limit: 50 } },
    { verdict: 'accept', input: { limit: 50, cursor: 'c-1' } },
    { verdict: 'refuse', input: { limit: 201 } },
  ],
});

/**
 * `burned` is the `burnedSupply` balance; `minted`, `bought`, `toRewards` and `distributed` are sums of rows svc-token
 * stored. Null on those sums, and a null `lastBuyback`, means no rows, not zero. No price.
 */
export const TOKEN_TREASURY = defineProcedure({
  ...base,
  name: 'token.treasury',
  kind: 'query',
  path: 'treasury',
  access: READER,
  refusals: freeze({ 'token.treasury_figure_unreadable': 'PRECONDITION_FAILED' }),
  input: NO_INPUT,
  output: z.object({
    minted: amount.nullable(),
    burned: amount,
    bought: amount.nullable(),
    toRewards: amount.nullable(),
    distributed: amount.nullable(),
    lastBuyback: z.object({ bought: amount, burned: amount, toRewards: amount, executedAt: iso }).nullable(),
  }),
  samples: [{ verdict: 'accept' }],
});

/** Stored buyback runs, the job's state and the rate (or why the rate is blank). */
export const TOKEN_BUYBACK_RUNS = defineProcedure({
  ...base,
  name: 'token.buybackRuns',
  kind: 'query',
  path: 'buybackRuns',
  access: READER,
  refusals: freeze({ 'token.treasury_figure_unreadable': 'PRECONDITION_FAILED' }),
  input: z.object({ limit: z.number().int().min(1).max(200) }),
  output: z.object({
    job: z.enum(['set', 'unset']),
    runs: z.array(
      z.object({
        id: z.string().min(1),
        bought: amount,
        burned: amount,
        toRewards: amount,
        executedAt: iso,
        windowFrom: iso,
        windowTo: iso,
      }),
    ),
    rate: z.object({ buybackBps: bps, burnSplitBps: bps }).nullable(),
    missing: z.string().nullable(),
    reason: PARAMS_REASON.nullable(),
  }),
  samples: [
    { verdict: 'accept', input: { limit: 50 } },
    { verdict: 'refuse', input: {} },
    { verdict: 'refuse', input: { limit: 0 } },
  ],
});

/** Tokens permanently removed from circulation: the burn account's balance. */
export const TOKEN_BURNED_SUPPLY = defineProcedure({
  ...base,
  name: 'token.burnedSupply',
  kind: 'query',
  path: 'burnedSupply',
  access: ANY_READER,
  refusals: freeze({}),
  input: NO_INPUT,
  output: tokenBurnedSupplySchema,
  samples: [{ verdict: 'accept' }],
});

// ---------------------------------------------------------------------------------------------------------------------
// Governance (MC-token-02, MC-token-03): the space, proposals, votes, voting power and delegation, and the founders'
// settings and roles. Every refusal below is a `TokenError` code svc-token's `toTrpcError` sends with the status named; the
// founders' approval and step-up refusals (`DualControlError`, `ActionApprovalConsumeError`, `StepUpCheckError`) are not
// `TokenError`s and leave unchanged.

const proposalId = tokenProposalIdSchema;
const PROPOSAL_ACCESS_CODE = z.enum([
  'token.proposer_rule_unset',
  'token.proposal_limit_unset',
  'token.proposal_not_allowed',
  'token.proposal_limit_reached',
]);
/** The governance roles a founder pair may grant (`governance.setRole`). */
export const TOKEN_GOVERNANCE_ROLES = ['controller', 'admin', 'moderator', 'author'] as const;
export const tokenGovernanceRoleSchema = z.enum(TOKEN_GOVERNANCE_ROLES);
/** A whole number of milliseconds as a decimal string; the door checks its range. */
const msWire = z.string().regex(/^\d{1,15}$/);
/** A stored setting: a whole number of milliseconds (no leading zero), or null when blank. */
const WHOLE_MS = /^(?:0|[1-9][0-9]{0,14})$/;
const msOrNull = (v: unknown) => v === null || (typeof v === 'string' && WHOLE_MS.test(v));
export const tokenGovernanceSettingsSchema = z.object({
  votingDelayMs: z.string().nullable(),
  votingPeriodMs: z.string().nullable(),
  revision: z.number().int().nonnegative(),
});
const settingsAreWholeMs = {
  says: 'each setting is a whole number of milliseconds with no leading zero, or null',
  holds: (reply: unknown) =>
    typeof reply === 'object' &&
    reply !== null &&
    msOrNull((reply as { votingDelayMs?: unknown }).votingDelayMs) &&
    msOrNull((reply as { votingPeriodMs?: unknown }).votingPeriodMs),
};
const approvalIds = { approvalId: z.string().max(128).nullish(), operationId: z.string().max(128).nullish() };

/** The governance space: whether this account follows it, and whether it may write a proposal (and the stake it needs). */
export const TOKEN_GOVERNANCE_HOME = defineProcedure({
  ...base,
  name: 'token.governanceHome',
  kind: 'query',
  path: 'governanceHome',
  access: READER,
  refusals: freeze({ 'token.stake_ledger_mismatch': 'PRECONDITION_FAILED' }),
  input: NO_INPUT,
  output: z.object({
    spaceId: z.string(),
    following: z.boolean(),
    proposal: z.object({ code: PROPOSAL_ACCESS_CODE.nullable(), minStake: amount.nullable() }),
  }),
  samples: [{ verdict: 'accept' }],
});

/** Follow or unfollow the governance space. Moves nothing. */
export const TOKEN_FOLLOW_SPACE = defineProcedure({
  ...base,
  name: 'token.followSpace',
  kind: 'mutation',
  path: 'followSpace',
  access: READER,
  refusals: freeze({}),
  input: z.object({ following: z.boolean() }),
  output: z.object({ spaceId: z.string(), following: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { following: true } },
    { verdict: 'refuse', input: {} },
  ],
});

/** The newest proposals, filtered. A blank page size refuses `token.proposal_list_limit_unset`; blank is not 50. */
export const TOKEN_LIST_PROPOSALS = defineProcedure({
  ...base,
  name: 'token.listProposals',
  kind: 'query',
  path: 'listProposals',
  access: ANY_READER,
  refusals: freeze({ 'token.proposal_list_limit_unset': 'PRECONDITION_FAILED' }),
  input: z
    .object({
      status: tokenProposalStatusSchema.optional(),
      kind: tokenProposalKindSchema.optional(),
      /** Optional so an omit reaches `token.proposal_list_limit_unset`, never a zod "Required". */
      limit: z.number().int().min(1).max(200).optional(),
      q: z.string().optional(),
    })
    .default({}),
  output: z.array(tokenProposalViewSchema),
  samples: [
    { verdict: 'accept', input: { limit: 50 } },
    { verdict: 'accept', input: { limit: 50, status: 'open', kind: 'grant', q: 'x' } },
    { verdict: 'refuse', input: { limit: 0 } },
    { verdict: 'refuse', input: { status: 'gone' } },
  ],
});

/** Write a proposal: a staker within the proposer rule, or an operator. `handle` makes a resend return the stored one. */
export const TOKEN_CREATE_PROPOSAL = defineProcedure({
  ...base,
  name: 'token.createProposal',
  kind: 'mutation',
  path: 'createProposal',
  access: SIGNED_IN,
  refusals: freeze({
    'token.proposer_rule_unset': 'PRECONDITION_FAILED',
    'token.proposal_limit_unset': 'PRECONDITION_FAILED',
    'token.proposal_limit_reached': 'PRECONDITION_FAILED',
    'token.proposal_not_allowed': 'FORBIDDEN',
    'token.proposal_window_unset': 'PRECONDITION_FAILED',
    'token.proposal_window': 'BAD_REQUEST',
    'token.proposal_title_invalid': 'BAD_REQUEST',
    'token.proposal_handle_invalid': 'BAD_REQUEST',
    'token.voting_type_unsupported': 'BAD_REQUEST',
    'token.ballot_invalid': 'BAD_REQUEST',
    'token.stake_ledger_mismatch': 'PRECONDITION_FAILED',
  }),
  input: z.object({
    kind: tokenProposalKindSchema,
    body: z.record(z.string(), jsonValueSchema).default({}),
    opensAt: iso.optional(),
    closesAt: iso.optional(),
    handle: z.string().optional(),
    title: z.string().optional(),
    bodyMd: z.string().optional(),
    discussionLink: z.string().optional(),
    /** `basic` when omitted. Any other type needs 2 to 20 choices. */
    votingType: tokenVotingTypeSchema.optional(),
    choices: z.array(z.string().max(1000)).max(TOKEN_MAX_CHOICES).optional(),
  }),
  output: tokenProposalViewSchema,
  samples: [
    { verdict: 'accept', input: { kind: 'listing' } },
    { verdict: 'accept', input: { kind: 'grant', title: 't', votingType: 'approval', choices: ['a', 'b'] } },
    { verdict: 'refuse', input: {} },
    { verdict: 'refuse', input: { kind: 'listing', opensAt: 'soon' } },
  ],
});

/** Edit a draft's words or window, as its author or an operator. */
export const TOKEN_EDIT_PROPOSAL = defineProcedure({
  ...base,
  name: 'token.editProposal',
  kind: 'mutation',
  path: 'editProposal',
  access: SIGNED_IN,
  refusals: freeze({
    'token.proposal_not_found': 'NOT_FOUND',
    'token.proposal_not_editable': 'PRECONDITION_FAILED',
    'token.proposal_title_invalid': 'BAD_REQUEST',
    'token.proposal_window': 'BAD_REQUEST',
    'token.permission_denied': 'FORBIDDEN',
  }),
  input: z.object({
    proposalId,
    title: z.string().optional(),
    bodyMd: z.string().optional(),
    discussionLink: z.string().optional(),
    body: z.record(z.string(), jsonValueSchema).optional(),
    opensAt: iso.optional(),
    closesAt: iso.optional(),
  }),
  output: tokenProposalViewSchema,
  samples: [
    { verdict: 'accept', input: { proposalId: 'gov:proposal:s:a:1', title: 't' } },
    { verdict: 'refuse', input: {} },
    { verdict: 'refuse', input: { proposalId: '' } },
  ],
});

/** Cancel a draft or open proposal with a reason; svc-token decides who may (a role holder or the author). Votes stay. */
export const TOKEN_GOVERNANCE_CANCEL = defineProcedure({
  ...base,
  name: 'token.governance.cancel',
  kind: 'mutation',
  path: 'governance.cancel',
  access: STAKER,
  refusals: freeze({
    'token.proposal_not_found': 'NOT_FOUND',
    'token.proposal_not_cancellable': 'BAD_REQUEST',
    'token.cancel_reason_invalid': 'BAD_REQUEST',
    'token.permission_denied': 'FORBIDDEN',
  }),
  input: z.object({ proposalId, reason: z.string().max(2000) }),
  output: tokenProposalViewSchema,
  samples: [
    { verdict: 'accept', input: { proposalId: 'gov:proposal:s:a:1', reason: 'duplicate' } },
    { verdict: 'refuse', input: { proposalId: 'gov:proposal:s:a:1' } },
  ],
});

/** One proposal with its for/against tally and, on a multi-choice type, its choice tally. */
export const TOKEN_GET_PROPOSAL = defineProcedure({
  ...base,
  name: 'token.getProposal',
  kind: 'query',
  path: 'getProposal',
  access: ANY_READER,
  refusals: freeze({ 'token.proposal_not_found': 'NOT_FOUND' }),
  input: z.object({ proposalId }),
  output: tokenProposalDetailSchema,
  samples: [
    { verdict: 'accept', input: { proposalId: 'gov:proposal:s:a:1' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Close a proposal whose window has ended, by the owner's quorum and threshold. A grant or listing does not execute yet. */
export const TOKEN_CLOSE_PROPOSAL = defineProcedure({
  ...base,
  name: 'token.closeProposal',
  kind: 'mutation',
  path: 'closeProposal',
  access: STAKER,
  refusals: freeze({
    'token.proposal_not_found': 'NOT_FOUND',
    'token.proposal_not_open': 'BAD_REQUEST',
    'token.proposal_window': 'BAD_REQUEST',
    'token.governance_quorum_unset': 'PRECONDITION_FAILED',
    'token.governance_snapshot_missing': 'PRECONDITION_FAILED',
    'token.vote_history_unreadable': 'PRECONDITION_FAILED',
  }),
  input: z.object({ proposalId }),
  output: tokenProposalClosedSchema,
  samples: [
    { verdict: 'accept', input: { proposalId: 'gov:proposal:s:a:1' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Cast a vote, signed by a wallet linked to the account over `voteMessage`'s exact text. */
export const TOKEN_CAST_VOTE = defineProcedure({
  ...base,
  name: 'token.castVote',
  kind: 'mutation',
  path: 'castVote',
  access: STAKER,
  refusals: freeze({
    'token.proposal_not_found': 'NOT_FOUND',
    'token.proposal_not_open': 'BAD_REQUEST',
    'token.proposal_window': 'BAD_REQUEST',
    'token.already_voted': 'FORBIDDEN',
    'token.no_voting_weight': 'BAD_REQUEST',
    'token.ballot_invalid': 'BAD_REQUEST',
    'token.governance_snapshot_missing': 'PRECONDITION_FAILED',
    'token.vote_rule_unset': 'PRECONDITION_FAILED',
    'token.vote_rule_not_met': 'BAD_REQUEST',
    'token.signed_vote_unavailable': 'PRECONDITION_FAILED',
    'token.vote_signature_required': 'BAD_REQUEST',
    'token.vote_signature_invalid': 'BAD_REQUEST',
  }),
  input: z.object({
    proposalId,
    /** For/against/abstain on a basic proposal; abstain on any type. */
    choice: tokenVoteChoiceSchema.optional(),
    ballot: tokenBallotSchema.optional(),
    /** A linked wallet's EIP-191 signature over the vote's message. Missing refuses `token.vote_signature_required`. */
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]{130}$/)
      .optional(),
  }),
  output: tokenVoteSchema,
  samples: [
    { verdict: 'accept', input: { proposalId: 'gov:proposal:s:a:1', choice: 'for', signature: `0x${'a'.repeat(130)}` } },
    { verdict: 'accept', input: { proposalId: 'gov:proposal:s:a:1', ballot: { kind: 'pick', choices: [0] } } },
    { verdict: 'refuse', input: { proposalId: 'gov:proposal:s:a:1', choice: 'maybe' } },
    { verdict: 'refuse', input: { proposalId: 'gov:proposal:s:a:1', signature: '0x12' } },
  ],
});

/** The exact text the account's wallet signs for one vote. Reads nothing and stores nothing. */
export const TOKEN_VOTE_MESSAGE = defineProcedure({
  ...base,
  name: 'token.voteMessage',
  kind: 'query',
  path: 'voteMessage',
  access: READER,
  refusals: freeze({}),
  input: z.object({ proposalId, choice: tokenVoteChoiceSchema.optional(), ballot: tokenBallotSchema.optional() }),
  output: tokenVoteMessageSchema,
  samples: [
    { verdict: 'accept', input: { proposalId: 'gov:proposal:s:a:1', choice: 'against' } },
    { verdict: 'refuse', input: { choice: 'for' } },
  ],
});

/** The account's voting power stored when one proposal was created; zero carries its reason. */
export const TOKEN_VOTING_POWER_OF_PROPOSAL = defineProcedure({
  ...base,
  name: 'token.votingPower.ofProposal',
  kind: 'query',
  path: 'votingPower.ofProposal',
  access: READER,
  refusals: freeze({ 'token.proposal_not_found': 'NOT_FOUND' }),
  input: z.object({ proposalId }),
  output: tokenProposalPowerSchema,
  samples: [
    { verdict: 'accept', input: { proposalId: 'gov:proposal:s:a:1' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Every stored voting-power snapshot of the account, newest first. A blank page size refuses. */
export const TOKEN_VOTING_POWER_HISTORY = defineProcedure({
  ...base,
  name: 'token.votingPower.history',
  kind: 'query',
  path: 'votingPower.history',
  access: READER,
  refusals: freeze({ 'token.history_list_limit_unset': 'PRECONDITION_FAILED' }),
  input: z.object({ limit: z.number().int().min(1).max(200).optional() }).default({}),
  output: tokenPowerHistorySchema,
  samples: [
    { verdict: 'accept', input: { limit: 20 } },
    { verdict: 'refuse', input: { limit: 0 } },
  ],
});

/** The account's delegation: always a null delegatee and the protocol blocker (no chain service). */
export const TOKEN_DELEGATION = defineProcedure({
  ...base,
  name: 'token.delegation',
  kind: 'query',
  path: 'delegation',
  access: READER,
  refusals: freeze({}),
  input: NO_INPUT,
  output: z.object({ delegateeUserId: z.null(), blocker: z.literal('no_chain_service') }),
  samples: [{ verdict: 'accept' }],
});

/** Set a delegate. Always refused: a blank or non-member target by name, any member by the chain blocker. Writes nothing. */
export const TOKEN_DELEGATE = defineProcedure({
  ...base,
  name: 'token.delegate',
  kind: 'mutation',
  path: 'delegate',
  access: STAKER,
  refusals: freeze({
    'token.delegation_delegatee_unset': 'BAD_REQUEST',
    'token.delegation_delegatee_invalid': 'BAD_REQUEST',
    'token.delegation_unavailable': 'PRECONDITION_FAILED',
  }),
  input: z.object({ delegateeUserId: z.string().max(128).nullish() }).strict(),
  output: z.never(),
  samples: [
    { verdict: 'accept', input: { delegateeUserId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: { delegateeUserId: 7 } },
    { verdict: 'refuse', input: { delegateeUserId: null, extra: 1 } },
  ],
});

/**
 * The owner's fee-decay ladder as stored, and its version. `schedule` is null while unpublished; the row's own shape is
 * the service's, so a caller narrows it (`feeDiscountLadderSchema`).
 */
export const TOKEN_FEE_DISCOUNT_GET = defineProcedure({
  ...base,
  name: 'token.feeDiscount.get',
  kind: 'query',
  path: 'feeDiscount.get',
  access: MEMBER_OR_OPERATOR,
  refusals: freeze({}),
  input: NO_INPUT,
  output: z.object({ schedule: jsonValueSchema, version: z.string() }),
  samples: [{ verdict: 'accept' }],
});

/** The founders' voting delay and period; blank is null, never a default. */
export const TOKEN_GOVERNANCE_SETTINGS = defineProcedure({
  ...base,
  name: 'token.governance.settings',
  kind: 'query',
  path: 'governance.settings',
  access: MEMBER_OR_OPERATOR,
  refusals: freeze({}),
  input: NO_INPUT,
  output: tokenGovernanceSettingsSchema,
  accept: { settingsAreWholeMs },
  samples: [{ verdict: 'accept' }],
});

/** Every stored change of the settings, with who ran and who approved it. */
export const TOKEN_GOVERNANCE_SETTINGS_HISTORY = defineProcedure({
  ...base,
  name: 'token.governance.settingsHistory',
  kind: 'query',
  path: 'governance.settingsHistory',
  access: OPERATOR_READ,
  refusals: freeze({}),
  input: NO_INPUT,
  output: z.array(
    z.object({
      ordinal: z.number().int().positive(),
      votingDelayMs: z.string().nullable(),
      votingPeriodMs: z.string().nullable(),
      actorId: z.string(),
      approverId: z.string(),
      at: z.string(),
    }),
  ),
  accept: {
    settingsAreWholeMs: {
      says: 'each stored setting is a whole number of milliseconds with no leading zero, or null',
      holds: (reply) => Array.isArray(reply) && reply.every((move) => settingsAreWholeMs.holds(move)),
    },
  },
  samples: [{ verdict: 'accept' }],
});

/** Two founders store a new delay and period over the revision it replaces. */
export const TOKEN_GOVERNANCE_SET_SETTINGS = defineProcedure({
  ...base,
  name: 'token.governance.setSettings',
  kind: 'mutation',
  path: 'governance.setSettings',
  access: OPERATOR_WRITE,
  refusals: freeze({ 'token.settings_invalid': 'BAD_REQUEST', 'token.settings_stale': 'CONFLICT' }),
  input: z.object({
    votingDelayMs: msWire.nullable(),
    votingPeriodMs: msWire.nullable(),
    expectedRevision: z.number().int().nonnegative(),
    ...approvalIds,
  }),
  output: tokenGovernanceSettingsSchema.extend({ confirmOperatorId: z.string() }),
  accept: { settingsAreWholeMs },
  samples: [
    { verdict: 'accept', input: { votingDelayMs: '0', votingPeriodMs: '3600000', expectedRevision: 0, approvalId: 'a', operationId: 'o' } },
    { verdict: 'refuse', input: { votingDelayMs: '1.5', votingPeriodMs: null, expectedRevision: 0 } },
    { verdict: 'refuse', input: { votingDelayMs: null, votingPeriodMs: null } },
  ],
});

/** A page of governance roles. A full page says that more exist. */
export const TOKEN_GOVERNANCE_ROLES_LIST = defineProcedure({
  ...base,
  name: 'token.governance.roles',
  kind: 'query',
  path: 'governance.roles',
  access: OPERATOR_READ,
  refusals: freeze({}),
  input: z.object({ limit: z.number().int().min(1).max(200) }),
  output: z.array(z.object({ userId: z.string(), role: tokenGovernanceRoleSchema.nullable(), revision: z.number().int().positive() })),
  samples: [
    { verdict: 'accept', input: { limit: 200 } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Two founders grant or revoke one account's role, with the running founder's fresh step-up for exactly this move. */
export const TOKEN_GOVERNANCE_SET_ROLE = defineProcedure({
  ...base,
  name: 'token.governance.setRole',
  kind: 'mutation',
  path: 'governance.setRole',
  access: OPERATOR_WRITE,
  refusals: freeze({
    'token.role_invalid': 'BAD_REQUEST',
    'token.role_stale': 'CONFLICT',
  }),
  input: z.object({
    userId: z.string().min(1).max(128),
    role: tokenGovernanceRoleSchema.nullable(),
    expectedRevision: z.number().int().nonnegative(),
    ...approvalIds,
    /** The running founder's fresh step-up for exactly this account, role and revision. */
    stepUpApprovalId: z.string().max(128).nullish(),
  }),
  output: z.object({
    userId: z.string(),
    role: tokenGovernanceRoleSchema.nullable(),
    revision: z.number().int().positive(),
    confirmOperatorId: z.string(),
  }),
  samples: [
    { verdict: 'accept', input: { userId: 'u-2', role: 'moderator', expectedRevision: 0, approvalId: 'a', stepUpApprovalId: 's' } },
    { verdict: 'refuse', input: { userId: 'u-2', role: 'king', expectedRevision: 0 } },
  ],
});

/** Every svc-token record in this file, for the service's own sample test. */
export const TOKEN_PROCEDURES = [
  TOKEN_ACCESS_OF,
  TOKEN_LIST_STAKES,
  TOKEN_EMISSION_SCHEDULE,
  TOKEN_REVENUE_SHARE_HISTORY,
  TOKEN_TREASURY,
  TOKEN_BUYBACK_RUNS,
  TOKEN_BURNED_SUPPLY,
  TOKEN_GOVERNANCE_HOME,
  TOKEN_FOLLOW_SPACE,
  TOKEN_LIST_PROPOSALS,
  TOKEN_CREATE_PROPOSAL,
  TOKEN_EDIT_PROPOSAL,
  TOKEN_GOVERNANCE_CANCEL,
  TOKEN_GET_PROPOSAL,
  TOKEN_CLOSE_PROPOSAL,
  TOKEN_CAST_VOTE,
  TOKEN_VOTE_MESSAGE,
  TOKEN_VOTING_POWER_OF_PROPOSAL,
  TOKEN_VOTING_POWER_HISTORY,
  TOKEN_DELEGATION,
  TOKEN_DELEGATE,
  TOKEN_FEE_DISCOUNT_GET,
  TOKEN_GOVERNANCE_SETTINGS,
  TOKEN_GOVERNANCE_SETTINGS_HISTORY,
  TOKEN_GOVERNANCE_SET_SETTINGS,
  TOKEN_GOVERNANCE_ROLES_LIST,
  TOKEN_GOVERNANCE_SET_ROLE,
] as const;
