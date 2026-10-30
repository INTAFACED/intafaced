import { describe, expect, it } from 'vitest';
import { openItemWhy, shownLine, sumLine } from './open-items';

describe('open custody items, in words', () => {
  it('says why an item is open, and shows an unknown reason as its code', () => {
    expect(openItemWhy({ status: 'below_minimum', reason: 'below_minimum' })).toBe('under the minimum deposit');
    expect(openItemWhy({ status: 'needs_review', reason: 'reversal_unfunded' })).toBe('the credited funds were already spent');
    expect(openItemWhy({ status: 'held_for_screening', reason: null })).toBe('held for screening');
    expect(openItemWhy({ status: 'on_hold', reason: 'amount_mismatch' })).toBe('amount_mismatch');
  });

  it('writes each sum as custody minus ledger with its parts', () => {
    expect(
      sumLine({
        networkId: 'ethereum',
        assetId: 'USDT',
        held: '30',
        heldCount: 2,
        reversalUnfunded: '30',
        reversalUnfundedCount: 1,
        net: '0',
      }),
    ).toBe('USDT on ethereum: custody minus ledger 0 — held 30 (2), not covered 30 (1)');
  });

  it('never hides a cut page', () => {
    expect(shownLine({ items: [], total: 0 })).toBe('Showing 0 of 0.');
    expect(shownLine({ items: new Array(50).fill(null), total: 120 })).toBe('Showing 50 of 120.');
  });
});
