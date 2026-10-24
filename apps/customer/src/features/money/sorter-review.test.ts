import { describe, expect, it } from 'vitest';
import { bankWriteForReview } from './contracts';

// An income sorter (BK-pots-03, J-bank-07 #4) is confirmed only when the bank's answer is the sorter that was asked for:
// its id, asset and every share in order; a stop only when that sorter comes back stopped.
const SORTER = '1d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6';
const BILLS = '6f9b1c2a-3d4e-4f50-8a6b-7c8d9e0f1a2b';
const SAVINGS = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const legs = [
  { spaceId: BILLS, shareBp: 6000 },
  { spaceId: SAVINGS, shareBp: 4000 },
];
const sorter = (fields: Record<string, unknown> = {}) => ({
  id: SORTER,
  assetId: 'USDT',
  status: 'active',
  legs,
  createdAt: '2026-10-24T18:00:00.000Z',
  cancelledAt: null,
  ...fields,
});

describe('income sorter review', () => {
  it('confirms the sorter it asked for, and no other', () => {
    const review = bankWriteForReview('sorter.create', { sorterId: SORTER, assetId: 'USDT', legs });
    expect(review.safeParse(sorter()).success).toBe(true);
    expect(review.safeParse(sorter({ id: BILLS })).success).toBe(false);
    expect(review.safeParse(sorter({ assetId: 'USDC' })).success).toBe(false);
    expect(review.safeParse(sorter({ legs: [...legs].reverse() })).success).toBe(false);
    expect(review.safeParse(sorter({ legs: [{ spaceId: BILLS, shareBp: 6000 }] })).success).toBe(false);
    expect(review.safeParse(sorter({ status: 'cancelled', cancelledAt: '2026-10-24T18:01:00.000Z' })).success).toBe(false);
  });

  it('confirms a stop only when that sorter comes back stopped', () => {
    const review = bankWriteForReview('sorter.cancel', { sorterId: SORTER });
    expect(review.safeParse(sorter({ status: 'cancelled', cancelledAt: '2026-10-24T18:01:00.000Z' })).success).toBe(true);
    expect(review.safeParse(sorter()).success).toBe(false);
  });
});
