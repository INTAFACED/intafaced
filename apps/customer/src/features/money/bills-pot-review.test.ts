import { describe, expect, it } from 'vitest';
import { bankWriteForReview } from './contracts';

// The bills pot (BK-pots-03, J-bank-07 #4) is confirmed only when the bank's answer names the pot asked for with the
// top-up as asked; a stop only when that pot comes back cleared.
const POT = '6f9b1c2a-3d4e-4f50-8a6b-7c8d9e0f1a2b';
const OTHER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

describe('bills pot review', () => {
  it('confirms the pot and the top-up it asked for, and no other', () => {
    const review = bankWriteForReview('spaces.setBillsPot', { spaceId: POT, fallback: true });
    expect(review.safeParse({ spaceId: POT, assetId: 'USDT', fallback: true }).success).toBe(true);
    expect(review.safeParse({ spaceId: POT, assetId: 'USDT', fallback: false }).success).toBe(false);
    expect(review.safeParse({ spaceId: OTHER, assetId: 'USDT', fallback: true }).success).toBe(false);
  });

  it('confirms a stop only for that pot', () => {
    const review = bankWriteForReview('spaces.clearBillsPot', { spaceId: POT });
    expect(review.safeParse({ spaceId: POT, billsPot: null }).success).toBe(true);
    expect(review.safeParse({ spaceId: OTHER, billsPot: null }).success).toBe(false);
  });
});
