import { describe, expect, it } from 'vitest';
import { bankWriteForReview } from './contracts';

// A card round-up into a space (BK-pots-02, J-bank-07 #3) is confirmed only when the bank's rule names that space and
// no pool, and a pool round-up only when it names that pool and no space.
const SPACE = '6f9b1c2a-3d4e-4f50-8a6b-7c8d9e0f1a2b';
const POOL = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const rule = (target: { targetPoolId: string | null; targetSpaceId?: string | null }) => ({
  id: '1d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6',
  kind: 'card_roundup',
  assetId: 'USDT',
  threshold: null,
  buyAssetId: null,
  amount: '1',
  cadence: null,
  nextRunAt: null,
  status: 'active',
  createdAt: '2026-10-24T16:00:00.000Z',
  ...target,
});

describe('card round-up review', () => {
  it('confirms a round-up into the space it was asked for', () => {
    const review = bankWriteForReview('autoInvest.createRoundUp', { assetId: 'USDT', granularity: '1', targetSpaceId: SPACE });
    expect(review.safeParse(rule({ targetPoolId: null, targetSpaceId: SPACE })).success).toBe(true);
    expect(review.safeParse(rule({ targetPoolId: null, targetSpaceId: POOL })).success).toBe(false);
    expect(review.safeParse(rule({ targetPoolId: POOL, targetSpaceId: null })).success).toBe(false);
  });

  it('confirms a pool round-up only with no space named', () => {
    const review = bankWriteForReview('autoInvest.createRoundUp', { assetId: 'USDT', granularity: '1', targetPoolId: POOL });
    expect(review.safeParse(rule({ targetPoolId: POOL, targetSpaceId: null })).success).toBe(true);
    expect(review.safeParse(rule({ targetPoolId: POOL })).success).toBe(true);
    expect(review.safeParse(rule({ targetPoolId: POOL, targetSpaceId: SPACE })).success).toBe(false);
  });
});
