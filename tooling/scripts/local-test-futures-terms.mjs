/**
 * LOCAL TEST derivatives terms for the local test stack, in one place: `local-test-gates.mjs futures` publishes them
 * (two-person approval). No futures open waits on them since owner decision 2026-10-27; the rules' tier still gates
 * one. Not owner or legal text.
 */

/**
 * Not owner or legal text: one risk agreement and one margin terms text for the stack's
 * region, and a one-question TEST quiz whose rules name the identity tier a futures open needs (D-account-07).
 */
export const TEST_AGREEMENTS = Object.freeze({
  derivatives_risk: {
    title: 'TEST risk agreement (local test, not legal text)',
    body:
      'LOCAL TEST — not a real agreement. Futures are leveraged: a move against an isolated position can take all ' +
      'of its margin, and a position that falls below maintenance margin is liquidated through the book.',
  },
  margin_terms: {
    title: 'TEST margin terms (local test, not legal text)',
    body:
      'LOCAL TEST — not real terms. Isolated margin is locked per position from your available balance and is ' +
      'returned, less any loss, when the position closes.',
  },
});
export const TEST_ELIGIBILITY_RULES = Object.freeze({
  questions: [
    {
      id: 'test-liquidation',
      prompt: 'TEST question: what can happen when an isolated position falls below its maintenance margin?',
      options: [
        { id: 'a', text: 'It is liquidated and can lose all of its margin' },
        { id: 'b', text: 'Nothing, margin is guaranteed' },
      ],
      correctOptionId: 'a',
    },
  ],
  // How many answers must be right: here, the one question.
  passMark: 1,
  minKycTier: 'full',
});
