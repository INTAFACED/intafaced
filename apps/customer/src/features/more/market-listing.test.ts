import { describe, expect, it } from 'vitest';
import { reviewablePurchase, reviewKey } from './market-listing';

const L = '11111111-1111-4111-8111-111111111111';

describe('reviewablePurchase', () => {
  it('takes my newest settled or released purchase of this listing, never a held, pending or refunded one', () => {
    const rows = [
      { id: 'held', listingId: L, status: 'held', createdAt: '2026-10-30T12:05:00Z' },
      { id: 'old', listingId: L, status: 'settled', createdAt: '2026-10-30T10:00:00Z' },
      { id: 'released', listingId: L, status: 'released', createdAt: '2026-10-30T11:00:00Z' },
      { id: 'refunded', listingId: L, status: 'refunded', createdAt: '2026-10-30T12:00:00Z' },
      { id: 'other', listingId: 'x', status: 'released', createdAt: '2026-10-30T13:00:00Z' },
    ];
    expect(reviewablePurchase(rows, L)?.id).toBe('released');
  });
  it('is none when nothing has settled', () => {
    expect(reviewablePurchase([{ id: 'p', listingId: L, status: 'pending' }], L)).toBeNull();
    expect(reviewablePurchase([], L)).toBeNull();
  });
});

describe('reviewKey', () => {
  it('is the same for the same review sent again, and different for another score or text', () => {
    const key = reviewKey('p1', 4, 'TEST review');
    expect(key).toMatch(/^review:p1:4:[0-9a-f]{8}$/);
    expect(reviewKey('p1', 4, '  TEST review ')).toBe(key);
    expect(reviewKey('p1', 5, 'TEST review')).not.toBe(key);
    expect(reviewKey('p1', 4, 'TEST review, again')).not.toBe(key);
    expect(reviewKey('p2', 4, 'TEST review')).not.toBe(key);
  });
  it('stays inside the service’s 128-character key', () => {
    expect(reviewKey('a'.repeat(36), 5, 'x'.repeat(1_000)).length).toBeLessThanOrEqual(128);
  });
});
