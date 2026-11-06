import { describe, expect, it } from 'vitest';
import { LISTING_REVIEW_STATES, listingReviewState } from './commerce-service.js';

// J-more-catalogue-02 #3 and J-more-catalogue-04: every kind of listing carries its own stored review state, decided by
// two founders; an operator takedown reads taken_down whatever was stored. A row read without its state is never shown
// as approved.
describe('listingReviewState', () => {
  it('a live or archived listing reads its stored review state', () => {
    for (const state of LISTING_REVIEW_STATES.filter((s) => s !== 'taken_down')) {
      expect(listingReviewState('active', state)).toBe(state);
      expect(listingReviewState('archived', state)).toBe(state);
    }
  });

  it('a taken-down listing reads taken_down, whatever was stored', () => {
    for (const state of LISTING_REVIEW_STATES) expect(listingReviewState('taken_down', state)).toBe('taken_down');
    expect(listingReviewState('taken_down', null)).toBe('taken_down');
  });

  it('a missing or unknown stored state refuses by name instead of reading approved', () => {
    for (const stored of [null, undefined, '', 'in_review', 'APPROVED'])
      expect(() => listingReviewState('active', stored)).toThrow(
        expect.objectContaining({ code: 'market.listing_review_state_unreadable' }),
      );
  });
});
