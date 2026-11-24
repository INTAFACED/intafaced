import { z } from 'zod';
import { jsonValueSchema } from './procedure-strict-schema.js';

/**
 * svc-token's answers for staking and governance: the schemas its router checks its own output against, read by the
 * customer's token rooms. Money crosses the wire as a decimal string, never a number.
 */

/** Voting types (MC-token-03). `basic` is for/against/abstain; every other type carries choices. */
export const TOKEN_VOTING_TYPES = ['basic', 'single_choice', 'approval', 'weighted', 'quadratic', 'ranked_choice'] as const;
export type TokenVotingType = (typeof TOKEN_VOTING_TYPES)[number];
/** Whole-ballot basis points for `weighted` and `quadratic` splits. */
export const TOKEN_BALLOT_BPS = 10_000;
/** Most choices a non-basic proposal carries. */
export const TOKEN_MAX_CHOICES = 20;

/** An unsigned decimal string with at most 18 places. */
export const tokenAmountSchema = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amount must be an unsigned decimal string (max 18dp)');

export const tokenStakeTierSchema = z.enum(['flex', 'm3', 'm12']);

export const tokenStakeViewSchema = z.object({
  id: z.string().guid(),
  userId: z.string().guid(),
  amount: tokenAmountSchema,
  tier: tokenStakeTierSchema,
  startedAt: z.string(),
  unlocksAt: z.string().nullable(),
  status: z.enum(['pending', 'active', 'unstaking', 'closed']),
});

/** `accessOf`: the signed account's stake, its tier and the fee discount it earns. */
export const tokenAccessViewSchema = z.object({
  staked: z.string(),
  tier: z.string(),
  feeDiscountBps: z.number().int(),
});

/** `burnedSupply`. */
export const tokenBurnedSupplySchema = z.object({ burned: tokenAmountSchema });

export const tokenProposalKindSchema = z.enum(['listing', 'fee_param', 'curriculum', 'grant']);
export const tokenProposalStatusSchema = z.enum(['draft', 'open', 'passed', 'rejected', 'executed', 'cancelled', 'closed_ranked']);
export const tokenVoteChoiceSchema = z.enum(['for', 'against', 'abstain']);
export const tokenVotingTypeSchema = z.enum(TOKEN_VOTING_TYPES);
const choiceIndex = z
  .number()
  .int()
  .min(0)
  .max(TOKEN_MAX_CHOICES - 1);
/** A non-basic ballot (MC-token-03). The service checks it against the proposal's type and choices. */
export const tokenBallotSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('abstain') }).strict(),
  z.object({ kind: z.literal('pick'), choices: z.array(choiceIndex).min(1).max(TOKEN_MAX_CHOICES) }).strict(),
  z
    .object({
      kind: z.literal('split'),
      parts: z
        .array(z.object({ choice: choiceIndex, bps: z.number().int().min(1).max(TOKEN_BALLOT_BPS) }).strict())
        .min(1)
        .max(TOKEN_MAX_CHOICES),
    })
    .strict(),
]);
export type TokenBallot = z.infer<typeof tokenBallotSchema>;
export const tokenSnapshotSchema = z.object({ count: z.number().int().nonnegative(), total: z.string(), hash: z.string() });
export const tokenChoiceTallySchema = z.object({
  totals: z.array(z.string()),
  abstainWeight: z.string(),
  participatingWeight: z.string(),
  voterCount: z.number().int().nonnegative(),
  ranking: z.array(z.number().int().nonnegative()),
  rounds: z.array(z.array(z.string())).nullable(),
});

/** Stored id `gov:proposal:<space>:<author>:<n>`. Not a client uuid. */
export const tokenProposalIdSchema = z.string().min(1).max(512);

export const tokenProposalCountsSchema = z.object({
  votes: z.number().int().nonnegative(),
  for: z.number().int().nonnegative(),
  against: z.number().int().nonnegative(),
  abstain: z.number().int().nonnegative(),
});

export const tokenProposalViewSchema = z.object({
  id: tokenProposalIdSchema,
  kind: tokenProposalKindSchema,
  /** The author's terms as stored: any JSON document. */
  body: z.record(z.string(), jsonValueSchema),
  status: tokenProposalStatusSchema,
  opensAt: z.string(),
  closesAt: z.string(),
  createdAt: z.string(),
  title: z.string().nullable(),
  bodyMd: z.string().nullable(),
  discussionLink: z.string().nullable(),
  businessKey: z.string().nullable(),
  authorId: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  votingType: tokenVotingTypeSchema,
  choices: z.array(z.string()).nullable(),
  snapshot: tokenSnapshotSchema.nullable(),
  ranking: z.array(z.number().int().nonnegative()).nullable(),
  cancel: z.object({ reason: z.string(), at: z.string() }).nullable(),
  counts: tokenProposalCountsSchema,
});

export const tokenTallySchema = z.object({
  forWeight: z.string(),
  againstWeight: z.string(),
  abstainWeight: z.string(),
  totalWeight: z.string(),
  voterCount: z.number().int().nonnegative(),
});

/** `getProposal`: the proposal with its for/against tally and, on a multi-choice type, its choice tally. */
export const tokenProposalDetailSchema = tokenProposalViewSchema.extend({
  tally: tokenTallySchema,
  choiceTally: tokenChoiceTallySchema.nullable(),
});

/** `closeProposal`: the closed proposal; a grant or listing does not execute yet. */
export const tokenProposalClosedSchema = tokenProposalDetailSchema.extend({
  execute: z.literal('token.governance_execute_unwired').nullable(),
});

/** `castVote`: the stored vote, with the linked wallet that signed it. */
export const tokenVoteSchema = z.object({
  id: z.string().guid(),
  proposalId: tokenProposalIdSchema,
  userId: z.string().guid(),
  weight: z.string(),
  choice: tokenVoteChoiceSchema.nullable(),
  ballot: tokenBallotSchema.nullable(),
  castAt: z.string(),
  signedBy: z.string(),
});

/** `voteMessage`: the exact text the account's wallet signs for one vote. */
export const tokenVoteMessageSchema = z.object({ message: z.string() });

/** `votingPower.ofProposal`: the power stored when the proposal was created; zero carries its reason. */
export const tokenProposalPowerSchema = z.object({
  proposalId: tokenProposalIdSchema,
  power: z.string(),
  reason: z.enum(['no_stake_at_creation', 'not_measured']).nullable(),
  takenAt: z.string().nullable(),
  /** Who may vote: the minimum power, or the typed code every vote is refused with. */
  rule: z.object({ minPower: z.string().nullable(), code: z.string().nullable() }),
  /**
   * Every vote is signed. `available: false` with its code when no identity is configured; when true, whether the
   * account has a linked wallet is identity's answer at cast time.
   */
  signing: z.object({
    required: z.literal(true),
    available: z.boolean(),
    code: z.literal('token.signed_vote_unavailable').nullable(),
  }),
});

/** `votingPower.history`: every stored snapshot, newest first. */
export const tokenPowerHistorySchema = z.array(
  z.object({ proposalId: tokenProposalIdSchema, title: z.string().nullable(), takenAt: z.string(), power: z.string() }),
);
