import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { BallotError, assertVotingType, isqrt, normalizeChoices, parseStoredBallot, tallyChoices, validateBallot } from './ballot-tally.js';

/** MC-token-03. Voting types tally in scaled bigint with no float. */

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof BallotError ? err.code : 'other';
  }
}

describe('voting types', () => {
  it('approval: each approved choice gets that power and the tally lists three totals', () => {
    const tally = tallyChoices('approval', 3, [
      { weight: amt('100'), choice: null, ballot: { kind: 'pick', choices: [0, 2] } },
      { weight: amt('40'), choice: null, ballot: { kind: 'pick', choices: [1] } },
    ]);
    expect(tally.totals).toEqual([amt('100'), amt('40'), amt('100')]);
    expect(tally.ranking).toEqual([0, 2, 1]);
    expect(tally.voterCount).toBe(2);
  });

  it('weighted: parts that sum to 9999 basis points are refused token.ballot_invalid', () => {
    expect(
      code(() =>
        validateBallot('weighted', 2, {
          kind: 'split',
          parts: [
            { choice: 0, bps: 5000 },
            { choice: 1, bps: 4999 },
          ],
        }),
      ),
    ).toBe('token.ballot_invalid');
    const tally = tallyChoices('weighted', 2, [
      {
        weight: amt('100'),
        choice: null,
        ballot: {
          kind: 'split',
          parts: [
            { choice: 1, bps: 2500 },
            { choice: 0, bps: 7500 },
          ],
        },
      },
    ]);
    expect(tally.totals).toEqual([amt('75'), amt('25')]);
  });

  it('quadratic: each choice gets the floor of the integer square root, no float', () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(15n)).toBe(3n);
    expect(isqrt(16n)).toBe(4n);
    const big = 10n ** 40n + 12345n;
    expect(isqrt(big)).toBe(10n ** 20n);
    const tally = tallyChoices('quadratic', 2, [
      {
        weight: 100n,
        choice: null,
        ballot: {
          kind: 'split',
          parts: [
            { choice: 0, bps: 5000 },
            { choice: 1, bps: 5000 },
          ],
        },
      },
    ]);
    // 50 base units each: floor(sqrt(50)) = 7.
    expect(tally.totals).toEqual([7n, 7n]);
  });

  it('ranked: a tie goes to the lower choice index', () => {
    const tie = tallyChoices('ranked_choice', 2, [
      { weight: amt('10'), choice: null, ballot: { kind: 'pick', choices: [1, 0] } },
      { weight: amt('10'), choice: null, ballot: { kind: 'pick', choices: [0, 1] } },
    ]);
    expect(tie.ranking[0]).toBe(0);
  });

  it('ranked: instant runoff moves an eliminated choice to the next preference', () => {
    const tally = tallyChoices('ranked_choice', 3, [
      { weight: amt('40'), choice: null, ballot: { kind: 'pick', choices: [0] } },
      { weight: amt('35'), choice: null, ballot: { kind: 'pick', choices: [1] } },
      { weight: amt('25'), choice: null, ballot: { kind: 'pick', choices: [2, 1] } },
    ]);
    expect(tally.rounds).toEqual([
      [amt('40'), amt('35'), amt('25')],
      [amt('40'), amt('60'), 0n],
    ]);
    expect(tally.ranking).toEqual([1, 0, 2]);
    expect(tally.totals).toEqual([amt('40'), amt('35'), amt('25')]);
  });

  it('abstain counts for quorum only', () => {
    const tally = tallyChoices('single_choice', 2, [
      { weight: amt('5'), choice: 'abstain', ballot: null },
      { weight: amt('7'), choice: null, ballot: { kind: 'pick', choices: [1] } },
    ]);
    expect(tally.totals).toEqual([0n, amt('7')]);
    expect(tally.abstainWeight).toBe(amt('5'));
    expect(tally.participatingWeight).toBe(amt('12'));
  });

  it('refuses ballots that do not fit the type', () => {
    expect(code(() => validateBallot('single_choice', 3, { kind: 'pick', choices: [0, 1] }))).toBe('token.ballot_invalid');
    expect(code(() => validateBallot('approval', 3, { kind: 'pick', choices: [] }))).toBe('token.ballot_invalid');
    expect(code(() => validateBallot('approval', 3, { kind: 'pick', choices: [3] }))).toBe('token.ballot_invalid');
    expect(code(() => validateBallot('ranked_choice', 3, { kind: 'pick', choices: [1, 1] }))).toBe('token.ballot_invalid');
    expect(code(() => validateBallot('approval', 2, { kind: 'split', parts: [{ choice: 0, bps: 10000 }] }))).toBe('token.ballot_invalid');
    expect(
      code(() =>
        validateBallot('weighted', 2, {
          kind: 'split',
          parts: [
            { choice: 0, bps: 10000 },
            { choice: 0, bps: 0 },
          ],
        }),
      ),
    ).toBe('token.ballot_invalid');
    expect(code(() => validateBallot('basic', 2, { kind: 'abstain' }))).toBe('token.ballot_invalid');
  });

  it('names an unknown voting type token.voting_type_unsupported', () => {
    expect(code(() => assertVotingType('conviction'))).toBe('token.voting_type_unsupported');
    expect(assertVotingType('approval')).toBe('approval');
  });

  it('a choice list is 2 to 20 distinct non-blank choices, and basic has none', () => {
    expect(normalizeChoices('basic', undefined)).toBeNull();
    expect(code(() => normalizeChoices('basic', ['a', 'b']))).toBe('token.ballot_invalid');
    expect(code(() => normalizeChoices('approval', ['only']))).toBe('token.ballot_invalid');
    expect(code(() => normalizeChoices('approval', ['a', ' a ']))).toBe('token.ballot_invalid');
    expect(normalizeChoices('approval', [' a ', 'b'])).toEqual(['a', 'b']);
  });

  it('reads back only ballots the service writes', () => {
    expect(parseStoredBallot(null)).toBeNull();
    expect(parseStoredBallot({ kind: 'pick', choices: [1] })).toEqual({ kind: 'pick', choices: [1] });
    expect(code(() => parseStoredBallot({ kind: 'pick', choices: ['1'] }))).toBe('token.ballot_invalid');
  });
});
