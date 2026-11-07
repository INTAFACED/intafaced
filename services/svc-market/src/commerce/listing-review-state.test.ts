import { describe, expect, it } from 'vitest';
import { LISTING_REVIEW_STATES, listingReviewState } from './commerce-service.js';

// J-more-catalogue-02 #3: every kind of listing shows its review state. The state is the seller's operator review
// (`vet`), unless an operator took the listing itself down. It does not depend on the listing's kind.
describe('listingReviewState', () => {
  it('a live listing stands on its seller review', () => {
    expect(listingReviewState('active', 'approved')).toBe('approved');
    expect(listingReviewState('archived', 'approved')).toBe('approved');
    expect(listingReviewState('active', 'applied')).toBe('in_review');
    expect(listingReviewState('active', 'rejected')).toBe('rejected');
    expect(listingReviewState('active', 'suspended')).toBe('suspended');
  });

  it('a taken-down listing reads taken_down, whatever its seller review', () => {
    for (const vendor of ['applied', 'approved', 'rejected', 'suspended'] as const) {
      expect(listingReviewState('taken_down', vendor)).toBe('taken_down');
    }
  });

  it('every state it can answer is in the published list, and nothing else is', () => {
    const answered = new Set<string>();
    for (const listing of ['active', 'archived', 'taken_down'] as const)
      for (const vendor of ['applied', 'approved', 'rejected', 'suspended'] as const) answered.add(listingReviewState(listing, vendor));
    expect([...answered].sort()).toEqual([...LISTING_REVIEW_STATES].sort());
  });
});
