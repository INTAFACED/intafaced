import type { Amount } from '@intafaced/ledger-client';

/**
 * Voting types and their tallies (MC-token-03).
 *
 * Pure functions over scaled bigint. No float, no clock, no database. The
 * `basic` type keeps today's for/against/abstain tally and close; every other
 * type stores only a ranking at close (`closed_ranked`) until the owner
 * decides what a multi-choice result means.
 */

export const VOTING_TYPES = ['basic', 'single_choice', 'approval', 'weighted', 'quadratic', 'ranked_choice'] as const;
export type VotingType = (typeof VOTING_TYPES)[number];

/** Whole-ballot basis points for `weighted` and `quadratic` splits. */
export const BALLOT_BPS = 10_000;
/** Fewest and most choices a non-basic proposal carries. */
export const MIN_CHOICES = 2;
export const MAX_CHOICES = 20;
export const MAX_CHOICE_LENGTH = 200;

/**
 * One ballot for a non-basic proposal. Abstain is allowed on every type and
 * counts for quorum only. `pick` lists choice indices (one for single choice,
 * a set for approval, an order for ranked choice). `split` hands out basis
 * points that add up to exactly 10000.
 */
export type Ballot =
  { kind: 'abstain' } | { kind: 'pick'; choices: number[] } | { kind: 'split'; parts: Array<{ choice: number; bps: number }> };

export class BallotError extends Error {
  constructor(
    message: string,
    readonly code: 'token.ballot_invalid' | 'token.voting_type_unsupported',
  ) {
    super(message);
    this.name = 'BallotError';
  }
}

function invalid(message: string): BallotError {
  return new BallotError(message, 'token.ballot_invalid');
}

export function assertVotingType(value: unknown): VotingType {
  if (typeof value === 'string' && (VOTING_TYPES as readonly string[]).includes(value)) return value as VotingType;
  throw new BallotError('That voting type is not one this service tallies', 'token.voting_type_unsupported');
}

/** `basic` has no choice list. Every other type has 2 to 20 distinct, non-blank choices. */
export function normalizeChoices(votingType: VotingType, choices: readonly string[] | undefined): string[] | null {
  if (votingType === 'basic') {
    if (choices !== undefined && choices.length > 0) throw invalid('A basic proposal has no choice list');
    return null;
  }
  if (choices === undefined) throw invalid('This voting type needs a choice list');
  const trimmed = choices.map((choice) => choice.trim());
  if (trimmed.length < MIN_CHOICES || trimmed.length > MAX_CHOICES) {
    throw invalid(`A choice list has ${MIN_CHOICES} to ${MAX_CHOICES} choices`);
  }
  if (trimmed.some((choice) => choice === '' || choice.length > MAX_CHOICE_LENGTH)) throw invalid('A choice is blank or too long');
  if (new Set(trimmed).size !== trimmed.length) throw invalid('Two choices are the same');
  return trimmed;
}

function assertIndex(choice: number, count: number): void {
  if (!Number.isInteger(choice) || choice < 0 || choice >= count) throw invalid('A ballot names a choice that does not exist');
}

function assertDistinct(choices: readonly number[]): void {
  if (new Set(choices).size !== choices.length) throw invalid('A ballot names the same choice twice');
}

/**
 * Validates one ballot against its proposal's type and choice count. Returns
 * a canonical copy (split parts sorted by choice) so the stored row does not
 * depend on the order the browser sent.
 */
export function validateBallot(votingType: VotingType, choiceCount: number, ballot: Ballot): Ballot {
  if (votingType === 'basic') throw invalid('A basic proposal takes for, against or abstain, not a ballot');
  if (ballot.kind === 'abstain') return { kind: 'abstain' };
  if (ballot.kind === 'pick') {
    const choices = [...ballot.choices];
    for (const choice of choices) assertIndex(choice, choiceCount);
    assertDistinct(choices);
    if (votingType === 'single_choice') {
      if (choices.length !== 1) throw invalid('A single-choice ballot names exactly one choice');
      return { kind: 'pick', choices };
    }
    if (votingType === 'approval') {
      if (choices.length < 1) throw invalid('An approval ballot approves at least one choice');
      return { kind: 'pick', choices: choices.sort((a, b) => a - b) };
    }
    if (votingType === 'ranked_choice') {
      if (choices.length < 1) throw invalid('A ranked ballot ranks at least one choice');
      return { kind: 'pick', choices };
    }
    throw invalid('A weighted or quadratic ballot splits basis points');
  }
  if (votingType !== 'weighted' && votingType !== 'quadratic') throw invalid('Only weighted and quadratic ballots split basis points');
  const parts = ballot.parts.map((part) => ({ choice: part.choice, bps: part.bps }));
  if (parts.length < 1) throw invalid('A split ballot has at least one part');
  for (const part of parts) {
    assertIndex(part.choice, choiceCount);
    if (!Number.isInteger(part.bps) || part.bps <= 0) throw invalid('Each part is a whole positive number of basis points');
  }
  assertDistinct(parts.map((part) => part.choice));
  const sum = parts.reduce((total, part) => total + part.bps, 0);
  if (sum !== BALLOT_BPS) throw invalid(`The parts add up to ${sum} basis points, not ${BALLOT_BPS}`);
  return { kind: 'split', parts: parts.sort((a, b) => a.choice - b.choice) };
}

/** Floor of the square root of a non-negative bigint, by Newton's method. No float. */
export function isqrt(value: bigint): bigint {
  if (value < 0n) throw new RangeError('isqrt of a negative number');
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

export interface TallyVote {
  /** Stored ballot weight (the snapshot power). */
  weight: Amount;
  /** `abstain` for an abstain on any type; for/against only on basic. */
  choice: 'for' | 'against' | 'abstain' | null;
  ballot: Ballot | null;
}

export interface ChoiceTally {
  /** One total per choice, in choice order. Quadratic totals are square roots of base units. */
  totals: Amount[];
  abstainWeight: Amount;
  /** Weight of every ballot, abstain included: what quorum would read. */
  participatingWeight: Amount;
  voterCount: number;
  /** Choice indices, best first. Ties go to the lower index. */
  ranking: number[];
  /** Ranked choice only: the first-preference totals of each instant-runoff round. */
  rounds: Amount[][] | null;
}

function rankByTotal(totals: readonly Amount[]): number[] {
  return totals
    .map((total, index) => ({ total, index }))
    .sort((a, b) => (a.total === b.total ? a.index - b.index : a.total > b.total ? -1 : 1))
    .map((entry) => entry.index);
}

/**
 * Instant runoff. Each round gives every ballot's weight to its highest-ranked
 * choice still in the race. A choice holding more than half of the weight
 * still counted wins. Otherwise the lowest total is eliminated; on a tie the
 * higher index goes, so the lower index wins ties. The ranking is the winner,
 * then the others in reverse order of elimination.
 */
function instantRunoff(count: number, ballots: Array<{ weight: Amount; order: number[] }>): { ranking: number[]; rounds: Amount[][] } {
  const remaining = new Set<number>(Array.from({ length: count }, (_, index) => index));
  const eliminated: number[] = [];
  const rounds: Amount[][] = [];
  while (remaining.size > 0) {
    const totals: Amount[] = Array.from({ length: count }, () => 0n);
    let counted = 0n;
    for (const ballot of ballots) {
      const top = ballot.order.find((choice) => remaining.has(choice));
      if (top === undefined) continue;
      totals[top] = totals[top]! + ballot.weight;
      counted += ballot.weight;
    }
    rounds.push(totals);
    const live = [...remaining].sort((a, b) => a - b);
    const leader = live.reduce((best, index) => (totals[index]! > totals[best]! ? index : best), live[0]!);
    if (remaining.size === 1 || (counted > 0n && totals[leader]! * 2n > counted)) {
      const rest = live
        .filter((index) => index !== leader)
        .sort((a, b) => (totals[a] === totals[b] ? a - b : totals[a]! > totals[b]! ? -1 : 1));
      return { ranking: [leader, ...rest, ...eliminated.reverse()], rounds };
    }
    const loser = live.reduce((worst, index) => (totals[index]! <= totals[worst]! ? index : worst), live[0]!);
    remaining.delete(loser);
    eliminated.push(loser);
  }
  return { ranking: eliminated.reverse(), rounds };
}

/** Tally of a non-basic proposal. Weighted parts are floored to base units; the dust stays untallied. */
export function tallyChoices(votingType: VotingType, choiceCount: number, votes: readonly TallyVote[]): ChoiceTally {
  if (votingType === 'basic') throw invalid('A basic proposal is tallied for, against and abstain');
  const totals: Amount[] = Array.from({ length: choiceCount }, () => 0n);
  let abstainWeight = 0n;
  let participatingWeight = 0n;
  const ranked: Array<{ weight: Amount; order: number[] }> = [];
  for (const vote of votes) {
    participatingWeight += vote.weight;
    if (vote.choice === 'abstain' || vote.ballot?.kind === 'abstain') {
      abstainWeight += vote.weight;
      continue;
    }
    if (!vote.ballot) throw invalid('A stored vote on this proposal has no ballot');
    const ballot = validateBallot(votingType, choiceCount, vote.ballot);
    if (ballot.kind === 'pick') {
      if (votingType === 'ranked_choice') {
        ranked.push({ weight: vote.weight, order: ballot.choices });
        continue;
      }
      for (const choice of ballot.choices) totals[choice] = totals[choice]! + vote.weight;
      continue;
    }
    if (ballot.kind === 'split') {
      for (const part of ballot.parts) {
        const allocated = (vote.weight * BigInt(part.bps)) / BigInt(BALLOT_BPS);
        totals[part.choice] = totals[part.choice]! + (votingType === 'quadratic' ? isqrt(allocated) : allocated);
      }
    }
  }
  if (votingType === 'ranked_choice') {
    const runoff = instantRunoff(choiceCount, ranked);
    return {
      totals: runoff.rounds[0] ?? totals,
      abstainWeight,
      participatingWeight,
      voterCount: votes.length,
      ranking: runoff.ranking,
      rounds: runoff.rounds,
    };
  }
  return { totals, abstainWeight, participatingWeight, voterCount: votes.length, ranking: rankByTotal(totals), rounds: null };
}

/** Parses a stored ballot. A row the service did not write is refused, not guessed. */
export function parseStoredBallot(raw: unknown): Ballot | null {
  if (raw == null) return null;
  if (typeof raw !== 'object') throw invalid('A stored ballot is not readable');
  const value = raw as { kind?: unknown; choices?: unknown; parts?: unknown };
  if (value.kind === 'abstain') return { kind: 'abstain' };
  if (value.kind === 'pick' && Array.isArray(value.choices) && value.choices.every((choice) => typeof choice === 'number')) {
    return { kind: 'pick', choices: value.choices as number[] };
  }
  if (
    value.kind === 'split' &&
    Array.isArray(value.parts) &&
    value.parts.every(
      (part) =>
        typeof part === 'object' &&
        part !== null &&
        typeof (part as { choice?: unknown }).choice === 'number' &&
        typeof (part as { bps?: unknown }).bps === 'number',
    )
  ) {
    return { kind: 'split', parts: value.parts as Array<{ choice: number; bps: number }> };
  }
  throw invalid('A stored ballot is not readable');
}
