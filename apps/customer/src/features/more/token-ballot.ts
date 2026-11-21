import { z } from 'zod';
import { tokenVoteChoiceSchema, tokenVoteSchema } from '@intafaced/contracts/token-governance';
import { decimalSchema, parseAmount } from '../../shared/money';

/**
 * The ballot this browser remembers for one account: the proposal and choice it sent, and svc-token's receipt once the
 * vote is recorded. It lives in local storage, so a reload mid-vote shows what was sent instead of offering a second vote.
 */

const uuid = z.string().guid();
/** The service stores `gov:proposal:<space>:<author>:<n>`; older rows keep their uuid. */
export const proposalIdSchema = z.union([
  uuid,
  z
    .string()
    .max(512)
    .regex(/^gov:proposal:[^:\s]+:[^:\s]+:[1-9]\d*$/),
]);
export const iso = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)));
export const choiceSchema = tokenVoteChoiceSchema;
export type VoteChoice = z.infer<typeof choiceSchema>;
/** `castVote`'s receipt for a for/against/abstain vote: positive weight, a choice, and the instant it was stored. */
export const voteSchema = tokenVoteSchema.pick({ id: true, userId: true }).extend({
  proposalId: proposalIdSchema,
  weight: decimalSchema.refine((value) => {
    try {
      return parseAmount(value) > 0n;
    } catch {
      return false;
    }
  }),
  choice: choiceSchema,
  castAt: iso,
});
export const ballotSchema = z
  .object({
    markerId: uuid,
    actor: uuid,
    proposalId: proposalIdSchema,
    choice: choiceSchema,
    status: z.enum(['unknown', 'recorded', 'refused']),
    receipt: voteSchema.optional(),
  })
  .refine((b) =>
    b.status === 'recorded'
      ? Boolean(b.receipt && b.receipt.proposalId === b.proposalId && b.receipt.userId === b.actor && b.receipt.choice === b.choice)
      : b.receipt === undefined,
  );
export type Ballot = z.infer<typeof ballotSchema>;
export type SavedBallot = { status: 'empty' } | { status: 'unreadable' } | { status: 'ready'; data: Ballot };
/** The shared action's pending marker for this vote, which the ballot takes its id from. */
export const pendingActionSchema = (reference: string) => z.object({ id: uuid, reference: z.literal(reference) });
