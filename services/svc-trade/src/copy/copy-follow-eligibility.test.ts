/** CB-copy-03 — who may follow (sub-account, copy tier from env, tier read from svc-identity). */
import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger } from '@intafaced/ledger-client';
import { CopyService } from '../controls/test-admission.js';
import { createTradeRouter } from '../router.js';
import type { TradeService } from '../spot/trade-service.js';
import { parseCopyFollowTier, type CopyFollowTier } from './copy-service.js';
import type { CopyFeeShareLaw, CopyJurisdictionLaw } from './fee-share-law.js';
import { MemoryCopyFollowStore } from './follow-store.js';
import type { ReadIdentityTierPort } from './identity-tier.js';

const FOLLOWER = '00000000-0000-4000-8000-000000000001';
const LEADER = '00000000-0000-4000-8000-000000000002';
const SESSION = '22222222-2222-4222-8222-222222222222';
const SECRET = 'a-trade-copy-eligibility-test-edge-secret';
const publishedFee: CopyFeeShareLaw = {
  published: true,
  leaderShareBps: 5_000,
  earningsCapPerFollower: '100',
  decayRoundTrips: 100,
  decayShareBps: 1_000,
};
const publishedJur: CopyJurisdictionLaw = { published: true, allowedRegions: ['SG'] };
const input = {
  leaderId: LEADER,
  region: 'SG',
  permittedMarkets: ['BTC-USDT'],
  maxNotionalPerOrder: '100',
  maxAggregateExposure: '1000',
  expiresAt: '2026-12-01T00:00:00.000Z',
};
const tierIs =
  (tier: Principal['tier']): ReadIdentityTierPort =>
  async () =>
    tier;
const identityDown: ReadIdentityTierPort = async () => {
  throw new Error('ECONNREFUSED');
};

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: FOLLOWER,
    userId: FOLLOWER,
    sid: SESSION,
    scopes: ['trade:read', 'trade:write'],
    tier: 'institutional',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function make(opts: { followTier?: CopyFollowTier | null; read?: ReadIdentityTierPort; jur?: CopyJurisdictionLaw } = {}) {
  const store = new MemoryCopyFollowStore();
  const svc = new CopyService(new MemoryLedger(), {
    feeShareLaw: publishedFee,
    jurisdictionLaw: opts.jur ?? publishedJur,
    followTier: 'followTier' in opts ? opts.followTier : 'basic',
    readIdentityTier: opts.read,
    store,
  });
  return { store, svc };
}

describe('CB-copy-03 who may follow', () => {
  it('identity tier none refuses trade.tier_insufficient before any write (token tier ignored)', async () => {
    const { store, svc } = make({ read: tierIs('none') });
    await expect(svc.follow(principal({ tier: 'institutional' }), input)).rejects.toMatchObject({
      code: 'trade.tier_insufficient',
    });
    expect(await store.listFollowsByFollower(FOLLOWER)).toEqual([]);
  });

  it('sub-account principal refuses trade.copy_subaccount_refused before any write', async () => {
    const { store, svc } = make({ read: tierIs('full') });
    await expect(svc.follow(principal({ sub_account: '00000000-0000-4000-8000-0000000000aa' }), input)).rejects.toMatchObject({
      code: 'trade.copy_subaccount_refused',
    });
    expect(await store.listFollowsByFollower(FOLLOWER)).toEqual([]);
  });

  it('blank country allowlist refuses every follow trade.copy_jurisdiction_blank', async () => {
    const { svc } = make({ read: tierIs('full'), jur: { published: false } });
    await expect(svc.follow(principal(), input)).rejects.toMatchObject({ code: 'trade.copy_jurisdiction_blank' });
  });

  it('copy tier unset (followTier null) refuses trade.copy_follow_tier_unset, no row written', async () => {
    const { store, svc } = make({ followTier: null, read: tierIs('institutional') });
    await expect(svc.follow(principal(), input)).rejects.toMatchObject({ code: 'trade.copy_follow_tier_unset' });
    expect(await store.listFollowsByFollower(FOLLOWER)).toEqual([]);
  });

  it('identity read failing refuses trade.identity_unavailable, no row written', async () => {
    const { store, svc } = make({ read: identityDown });
    await expect(svc.follow(principal(), input)).rejects.toMatchObject({ code: 'trade.identity_unavailable' });
    expect(await store.listFollowsByFollower(FOLLOWER)).toEqual([]);
  });

  it('identity read not wired refuses trade.identity_unavailable', async () => {
    const { svc } = make({});
    await expect(svc.follow(principal(), input)).rejects.toMatchObject({ code: 'trade.identity_unavailable' });
  });

  it('identity tier at the floor creates exactly one follow', async () => {
    const { store, svc } = make({ followTier: 'full', read: tierIs('full') });
    await svc.follow(principal(), input);
    expect(await store.listFollowsByFollower(FOLLOWER)).toHaveLength(1);
  });

  it('parseCopyFollowTier rejects blank, none and unknown; accepts basic/full/institutional/off', () => {
    for (const raw of [undefined, '', '  ', 'none', 'gold']) expect(parseCopyFollowTier(raw)).toBeNull();
    for (const raw of ['basic', 'full', 'institutional', 'off'] as const) expect(parseCopyFollowTier(raw)).toBe(raw);
  });
});

describe('CB-copy-03 trade.copy.follow tRPC codes', () => {
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-trade' });
  function signed(p: Principal) {
    const raw = encodePrincipal(p);
    return edgeContext({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'SG'),
        'x-intafaced-region': 'SG',
      },
      id: 'req-copy-eligibility',
    });
  }
  const cases: [string, Parameters<typeof make>[0], Partial<Principal>, string, TRPCError['code']][] = [
    ['tier_insufficient', { read: tierIs('none') }, {}, 'trade.tier_insufficient', 'FORBIDDEN'],
    [
      'subaccount_refused',
      { read: tierIs('full') },
      { sub_account: '00000000-0000-4000-8000-0000000000aa' },
      'trade.copy_subaccount_refused',
      'FORBIDDEN',
    ],
    ['follow_tier_unset', { followTier: null }, {}, 'trade.copy_follow_tier_unset', 'PRECONDITION_FAILED'],
    ['identity_unavailable', { read: identityDown }, {}, 'trade.identity_unavailable', 'PRECONDITION_FAILED'],
  ];
  for (const [name, opts, over, code, trpc] of cases) {
    it(`${name} → ${trpc}`, async () => {
      const { svc } = make(opts);
      const router = createTradeRouter({} as unknown as TradeService, undefined, svc);
      const err = await router
        .createCaller(signed(principal(over)))
        .copy.follow(input)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe(trpc);
      expect(((err as TRPCError).cause as { code?: string }).code).toBe(code);
    });
  }
});
