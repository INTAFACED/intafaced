import { beforeEach, describe, expect, it } from 'vitest';
import { forgetReviewId, resetReviewIds, reviewIdFor } from './review-id';

const draft = { symbol: 'BTC/USDT', side: 'buy', type: 'limit', amount: '1', price: '100', timeInForce: 'GTC', postOnly: false } as const;
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

describe('the order number of a reviewed draft', () => {
  beforeEach(resetReviewIds);

  it('is the same when the same draft is reviewed again', () => {
    let n = 0;
    const mint = () => `m${++n}`;
    const first = reviewIdFor(ALICE, draft, mint);
    expect(reviewIdFor(ALICE, { ...draft }, mint)).toBe(first);
    expect(n).toBe(1);
  });

  it('is new when anything about the order changes', () => {
    const a = reviewIdFor(ALICE, draft);
    expect(reviewIdFor(ALICE, { ...draft, amount: '2' })).not.toBe(a);
    expect(reviewIdFor(ALICE, { ...draft, price: '101' })).not.toBe(a);
    expect(reviewIdFor(ALICE, { ...draft, side: 'sell' })).not.toBe(a);
  });

  it('is not shared between people', () => {
    expect(reviewIdFor(BOB, draft)).not.toBe(reviewIdFor(ALICE, draft));
  });

  it('is new once the outcome is known, so a later identical order is not a replay', () => {
    const first = reviewIdFor(ALICE, draft);
    forgetReviewId(first);
    expect(reviewIdFor(ALICE, draft)).not.toBe(first);
  });

  it('fits the 64 characters a create allows, with a real user id', () => {
    expect(reviewIdFor(ALICE, draft).length).toBeLessThanOrEqual(64);
  });

  it('carries the user, a draft hash and a mint, and is not a bare random value', () => {
    expect(reviewIdFor(ALICE, draft, () => 'abcd1234')).toMatch(new RegExp(`^desk:${ALICE}:[0-9a-f]{8}-abcd1234$`));
  });
});
