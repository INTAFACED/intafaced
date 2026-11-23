/**
 * A lead order marked not a lead trade (J-copy-bots-otc-04 #6; CB-copy-14): an iceberg, or an order with the Lead trade
 * switch off. Its fill is never copied: the plan refuses with `trade.copy_not_lead_order` (the skip log's
 * `not_lead_order`), and the same fill as a lead trade plans a copy. TEST figures only.
 */
import { describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { CopyService } from '../controls/test-admission.js';
import { type LookupLeaderFillPort } from './copy-service.js';
import type { CopyFeeShareLaw, CopyJurisdictionLaw } from './fee-share-law.js';

const FOLLOWER = '00000000-0000-4000-8000-000000000001';
const LEADER = '00000000-0000-4000-8000-000000000002';
const principal = { userId: FOLLOWER } as import('@intafaced/auth').Principal;
const publishedFee: CopyFeeShareLaw = {
  published: true,
  leaderShareBps: 5_000,
  earningsCapPerFollower: '100',
  decayRoundTrips: 100,
  decayShareBps: 1_000,
};
const publishedJur: CopyJurisdictionLaw = { published: true, allowedRegions: ['SG'] };

function svc() {
  const lookupLeaderFill: LookupLeaderFillPort = async (fillId) => ({
    fillId,
    userId: LEADER,
    marketId: 'BTC-USDT',
    side: 'buy',
    qty: parseAmount('0.001'),
    notional: parseAmount('10'),
    notLead: fillId === 'fill-iceberg',
  });
  return new CopyService(new MemoryLedger(), { feeShareLaw: publishedFee, jurisdictionLaw: publishedJur, lookupLeaderFill });
}

const follow = {
  leaderId: LEADER,
  region: 'SG',
  permittedMarkets: ['BTC-USDT'],
  maxNotionalPerOrder: '100',
  maxAggregateExposure: '1000',
  maxLoss: '50',
  expiresAt: '2026-12-01T00:00:00.000Z',
};
const fill = (fillId: string) => ({ fillId, marketId: 'BTC-USDT', side: 'buy' as const, qty: '0.001', notional: '10', sessionLoss: '0' });

describe('a leader fill marked not a lead trade', () => {
  it('is never copied: the plan refuses by its code', async () => {
    const copy = svc();
    const { followId } = await copy.follow(principal, follow);
    await expect(copy.planMirrorForFollow(principal, { followId, ...fill('fill-iceberg') })).rejects.toMatchObject({
      code: 'trade.copy_not_lead_order',
    });
  });

  it('the same fill as a lead trade plans a copy', async () => {
    const copy = svc();
    const { followId } = await copy.follow(principal, follow);
    await expect(copy.planMirrorForFollow(principal, { followId, ...fill('fill-lead') })).resolves.toBeTruthy();
  });
});
