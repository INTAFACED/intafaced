import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryLedger } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { CopyService } from '../controls/test-admission.js';
import { parseCopyFollowTier } from './copy-service.js';
import { MemoryCopyFollowStore } from './follow-store.js';

const FOLLOWER = '00000000-0000-4000-8000-000000000001';
const LEADER = '00000000-0000-4000-8000-000000000002';
const futureExpiry = new Date(Date.now() + 86_400_000).toISOString();
const publishedFee = {
  published: true,
  leaderShareBps: 5_000,
  earningsCapPerFollower: '100',
  decayRoundTrips: 100,
  decayShareBps: 1_000,
} as never;
const publishedJur = { published: true, allowedRegions: ['SG'] } as never;
const input = {
  leaderId: LEADER,
  region: 'SG',
  permittedMarkets: ['BTC-USDT'],
  maxNotionalPerOrder: '100',
  maxAggregateExposure: '1000',
  expiresAt: futureExpiry,
};

function svc(store: MemoryCopyFollowStore, jurisdictionLaw: unknown = publishedJur) {
  return new CopyService(new MemoryLedger(), {
    feeShareLaw: publishedFee,
    jurisdictionLaw: jurisdictionLaw as never,
    followTier: 'basic',
    store,
  });
}

describe('CB-copy-03 who may follow', () => {
  it('tier none refuses trade.tier_insufficient before any write', async () => {
    const store = new MemoryCopyFollowStore();
    const p = { userId: FOLLOWER, tier: 'none' } as Principal;
    await expect(svc(store).follow(p, input)).rejects.toMatchObject({ code: 'trade.tier_insufficient' });
    expect(await store.listFollowsByFollower(FOLLOWER)).toEqual([]);
  });

  it('sub-account principal refuses trade.copy_subaccount_refused before any write', async () => {
    const store = new MemoryCopyFollowStore();
    const p = { userId: FOLLOWER, tier: 'full', sub_account: '00000000-0000-4000-8000-0000000000aa' } as Principal;
    await expect(svc(store).follow(p, input)).rejects.toMatchObject({ code: 'trade.copy_subaccount_refused' });
    expect(await store.listFollowsByFollower(FOLLOWER)).toEqual([]);
  });

  it('blank country allowlist refuses every follow trade.copy_jurisdiction_blank', async () => {
    const store = new MemoryCopyFollowStore();
    const p = { userId: FOLLOWER, tier: 'full' } as Principal;
    await expect(svc(store, { published: false }).follow(p, input)).rejects.toMatchObject({
      code: 'trade.copy_jurisdiction_blank',
    });
  });

  it('tier at or above the copy tier passes the gate', async () => {
    const store = new MemoryCopyFollowStore();
    const p = { userId: FOLLOWER, tier: 'basic' } as Principal;
    await svc(store).follow(p, input);
    expect(await store.listFollowsByFollower(FOLLOWER)).toHaveLength(1);
  });

  describe('TRADE_COPY_FOLLOW_TIER refuse-closed', () => {
    afterEach(() => vi.unstubAllEnvs());
    for (const raw of ['', '   ', 'gold']) {
      it(`env ${JSON.stringify(raw)} refuses every follow trade.copy_follow_tier_unset, no write`, async () => {
        vi.stubEnv('TRADE_COPY_FOLLOW_TIER', raw);
        const store = new MemoryCopyFollowStore();
        const s = new CopyService(new MemoryLedger(), { feeShareLaw: publishedFee, jurisdictionLaw: publishedJur, store });
        const p = { userId: FOLLOWER, tier: 'institutional' } as Principal;
        await expect(s.follow(p, input)).rejects.toMatchObject({ code: 'trade.copy_follow_tier_unset' });
        expect(await store.listFollowsByFollower(FOLLOWER)).toEqual([]);
      });
    }
    it('unset env refuses', () => {
      expect(parseCopyFollowTier(undefined)).toBeNull();
    });
    it('env full is read and gates a basic principal', async () => {
      vi.stubEnv('TRADE_COPY_FOLLOW_TIER', 'full');
      const store = new MemoryCopyFollowStore();
      const s = new CopyService(new MemoryLedger(), { feeShareLaw: publishedFee, jurisdictionLaw: publishedJur, store });
      await expect(s.follow({ userId: FOLLOWER, tier: 'basic' } as Principal, input)).rejects.toMatchObject({
        code: 'trade.tier_insufficient',
      });
    });
  });
});
