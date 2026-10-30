/**
 * Customer desk blockers and the closed control-disposition set.
 * Sentences stay on copy.opsStatus. Stop never returns a flatten disposition.
 */
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger } from '@intafaced/ledger-client';
import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { CopyService } from '../controls/test-admission.js';
import { createTradeRouter } from '../router.js';
import type { TradeService } from '../spot/trade-service.js';
import { COPY_PLACE_DISABLED_RESIDUAL } from './auto-mirror-place.js';
import { COPY_FLATTEN_DISPOSITION } from './copy-flatten.js';
import { COPY_CONTROL_DISPOSITIONS } from './copy-lifecycle.js';
import {
  COPY_DETACH_DISPOSITIONS,
  COPY_FLATTEN_WIRE_DISPOSITIONS,
  COPY_PAUSE_DISPOSITIONS,
  COPY_RESUME_DISPOSITIONS,
  COPY_STOP_DISPOSITIONS,
  copyStopOutput,
} from './copy-control-wire.js';
import type { CopyFeeShareLaw, CopyJurisdictionLaw } from './fee-share-law.js';
import { CopyError } from './errors.js';
import { MemoryCopyFollowStore } from './follow-store.js';
import { GateOpenLedger, OPEN_FOLLOW_GATE } from './test/follow-gate.fixture.js';
import type { StepUpCheck } from '@intafaced/contracts';

/** Identity's step-up, approving: these tests are about the close-all itself (the gate's own tests are in copy-flatten-step-up.test.ts). */
const approveStepUp: StepUpCheck = { require: async () => ({ stepUpEventId: 'appr-test', consumedAt: null, replayed: false }) };

const SECRET = 'copy-desk-blockers-edge-secret-32chars';
const FOLLOWER = '00000000-0000-4000-8000-0000000000a1';
const LEADER = '00000000-0000-4000-8000-0000000000a2';
const SESSION = '00000000-0000-4000-8000-0000000000a3';
const futureExpiry = '2026-12-01T00:00:00.000Z';
const FORBIDDEN_WIRE = /DIRECTION|D26-|§|leader_share_bps|TRADE_COPY_PLACE_MIRROR|copy\.placeMirror/;

/** Every object key at any depth. Arrays are walked; their indexes are not keys. */
function collectKeys(value: unknown): string[] {
  const keys: string[] = [];
  const walk = (node: unknown) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      keys.push(key);
      walk(child);
    }
  };
  walk(value);
  return keys;
}

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-trade' });

const publishedFee: CopyFeeShareLaw = {
  published: true,
  leaderShareBps: 5_000,
  earningsCapPerFollower: '100',
  decayRoundTrips: 100,
  decayShareBps: 1_000,
};
const publishedJur: CopyJurisdictionLaw = { published: true, allowedRegions: ['SG'] };

function principal(scopes: Principal['scopes']): Principal {
  return {
    sub: FOLLOWER,
    userId: FOLLOWER,
    sid: SESSION,
    scopes,
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function signed(scopes: Principal['scopes'] = ['trade:read', 'trade:write']) {
  const raw = encodePrincipal(principal(scopes));
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'SG'),
      'x-intafaced-region': 'SG',
    },
    id: 'req-copy-blockers',
  });
}

function followInput() {
  return {
    leaderId: LEADER,
    region: 'SG',
    permittedMarkets: ['BTC-USDT'],
    maxNotionalPerOrder: '100',
    maxAggregateExposure: '1000',
    expiresAt: futureExpiry,
    clientRequestId: 'test-request-desk',
  };
}

describe('copy.deskStatus blockers', () => {
  it('both laws blank returns the fee-share and jurisdiction codes and no internal sentence', async () => {
    const copy = new CopyService(new GateOpenLedger(), {
      stepUp: approveStepUp,
      ...OPEN_FOLLOW_GATE,
      store: new MemoryCopyFollowStore(),
      feeShareLaw: { published: false },
      jurisdictionLaw: { published: false },
    });
    const status = await createTradeRouter({} as TradeService, undefined, copy)
      .createCaller(signed())
      .copy.deskStatus();
    const lawCodes = status.blockers.map((b) => b.code).filter((code) => code.endsWith('_blank'));
    expect(lawCodes).toEqual(['trade.copy_fee_share_blank', 'trade.copy_jurisdiction_blank']);
    expect(status.blockers).toEqual([
      { code: 'trade.copy_fee_share_blank' },
      { code: 'trade.copy_jurisdiction_blank' },
      { code: 'trade.copy_place_disabled' },
    ]);
    expect(status.feeSharePublished).toBe(false);
    expect(status.jurisdictionPublished).toBe(false);
    expect(status.leaderShareBps).toBeNull();
    expect(JSON.stringify(status)).not.toMatch(FORBIDDEN_WIRE);
    expect(status).not.toHaveProperty('statusLine');
    expect(status).not.toHaveProperty('residual');
    expect(status).not.toHaveProperty('residuals');
  });

  it('an unmounted copy service returns the same shape and the unavailable blocker', async () => {
    const mounted = await createTradeRouter(
      {} as TradeService,
      undefined,
      new CopyService(new GateOpenLedger(), {
        stepUp: approveStepUp,
        ...OPEN_FOLLOW_GATE,
        store: new MemoryCopyFollowStore(),
        feeShareLaw: { published: false },
        jurisdictionLaw: { published: false },
      }),
    )
      .createCaller(signed())
      .copy.deskStatus();
    const unmounted = await createTradeRouter({} as TradeService)
      .createCaller(signed())
      .copy.deskStatus();
    expect(Object.keys(unmounted).sort()).toEqual(Object.keys(mounted).sort());
    expect(unmounted.blockers).toEqual([{ code: 'trade.copy_unavailable' }]);
    expect(unmounted.feeSharePublished).toBe(false);
    expect(unmounted.leaderShareBps).toBeNull();
    expect(unmounted.jurisdictionPublished).toBe(false);
    expect(JSON.stringify(unmounted)).not.toMatch(FORBIDDEN_WIRE);
    expect(unmounted).not.toHaveProperty('statusLine');
    expect(unmounted).not.toHaveProperty('residual');
    expect(unmounted).not.toHaveProperty('residuals');
  });

  it('opsStatus returns the sentences to an operator and refuses a customer', async () => {
    const copy = new CopyService(new GateOpenLedger(), {
      stepUp: approveStepUp,
      ...OPEN_FOLLOW_GATE,
      store: new MemoryCopyFollowStore(),
      feeShareLaw: { published: false },
      jurisdictionLaw: { published: false },
    });
    const router = createTradeRouter({} as TradeService, undefined, copy);
    await expect(router.createCaller(signed(['trade:read', 'trade:write'])).copy.opsStatus()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const ops = await router.createCaller(signed(['admin:read'])).copy.opsStatus();
    expect(ops.residual).toContain('leader fee share');
    expect(ops.residual).toContain('served regions');
    expect(ops.residuals.rates).toContain('leader fee share');
    expect(ops.residuals.jurisdiction).toContain('served regions');
    expect(ops.statusLine).toContain('feeShare=0');
    expect(ops.blockers.map((b) => b.code)).toEqual([
      'trade.copy_fee_share_blank',
      'trade.copy_jurisdiction_blank',
      'trade.copy_place_disabled',
    ]);
  });

  it('follow with a blank served list refuses jurisdiction_blank with blockers and no internal id', async () => {
    const copy = new CopyService(new GateOpenLedger(), {
      stepUp: approveStepUp,
      ...OPEN_FOLLOW_GATE,
      store: new MemoryCopyFollowStore(),
      feeShareLaw: publishedFee,
      jurisdictionLaw: { published: false },
    });
    const caller = createTradeRouter({} as TradeService, undefined, copy).createCaller(signed());
    const desk = await caller.copy.deskStatus();
    try {
      await caller.copy.follow(followInput());
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      const refusal = err as TRPCError;
      expect(refusal.code).toBe('PRECONDITION_FAILED');
      expect(refusal.message).not.toMatch(FORBIDDEN_WIRE);
      expect(refusal.cause).toBeInstanceOf(CopyError);
      const cause = refusal.cause as CopyError;
      expect(cause.code).toBe('trade.copy_jurisdiction_blank');
      expect(cause.blockers).toEqual(desk.blockers);
      expect(cause.blockers).toEqual([{ code: 'trade.copy_jurisdiction_blank' }, { code: 'trade.copy_place_disabled' }]);
    }
  });

  it('customer desks omit residual at every depth while ops keeps the place sentence', async () => {
    const blankLaws = createTradeRouter(
      {} as TradeService,
      undefined,
      new CopyService(new GateOpenLedger(), {
        stepUp: approveStepUp,
        ...OPEN_FOLLOW_GATE,
        store: new MemoryCopyFollowStore(),
        feeShareLaw: { published: false },
        jurisdictionLaw: { published: false },
      }),
    );
    const publishedPlaceOff = createTradeRouter(
      {} as TradeService,
      undefined,
      new CopyService(new GateOpenLedger(), {
        stepUp: approveStepUp,
        ...OPEN_FOLLOW_GATE,
        store: new MemoryCopyFollowStore(),
        feeShareLaw: publishedFee,
        jurisdictionLaw: publishedJur,
      }),
    );
    const unmounted = createTradeRouter({} as TradeService);
    const placeOff = [blankLaws, publishedPlaceOff];

    for (const router of [...placeOff, unmounted]) {
      const desk = await router.createCaller(signed()).copy.deskStatus();
      const keys = collectKeys(desk);
      expect(keys).not.toContain('residual');
      expect(keys).not.toContain('residuals');
      expect(keys).not.toContain('statusLine');
      expect(JSON.stringify(desk)).not.toMatch(FORBIDDEN_WIRE);
      const ops = await router.createCaller(signed(['admin:read'])).copy.opsStatus();
      expect(ops.residuals.autoMirrorPlace).toBe(COPY_PLACE_DISABLED_RESIDUAL);
    }
    for (const router of placeOff) {
      const desk = await router.createCaller(signed()).copy.deskStatus();
      expect(desk.blockers.map((b) => b.code)).toContain('trade.copy_place_disabled');
    }
  });
});

describe('copy control dispositions', () => {
  it('pins the exact closed list', () => {
    expect([...COPY_CONTROL_DISPOSITIONS, COPY_FLATTEN_DISPOSITION]).toEqual([
      'PAUSE_NEW',
      'STOP_NEW',
      'STOP_CLOSE_ONLY',
      'DETACH_KEEP',
      'RESUME',
      'DETACH_FLATTEN',
    ]);
    expect([...COPY_PAUSE_DISPOSITIONS]).toEqual(['PAUSE_NEW']);
    expect([...COPY_STOP_DISPOSITIONS]).toEqual(['STOP_NEW', 'STOP_CLOSE_ONLY']);
    expect([...COPY_DETACH_DISPOSITIONS]).toEqual(['DETACH_KEEP']);
    expect([...COPY_RESUME_DISPOSITIONS]).toEqual(['RESUME']);
    expect([...COPY_FLATTEN_WIRE_DISPOSITIONS]).toEqual(['DETACH_FLATTEN']);
    expect(copyStopOutput.shape.disposition.safeParse('STOP_NEW').success).toBe(true);
    expect(copyStopOutput.shape.disposition.safeParse('DETACH_FLATTEN').success).toBe(false);
    expect(copyStopOutput.shape.disposition.safeParse('PAUSE_NEW').success).toBe(false);
  });

  it('each control returns one value from its own subset and stop is not flatten', async () => {
    const copy = new CopyService(new GateOpenLedger(), {
      stepUp: approveStepUp,
      ...OPEN_FOLLOW_GATE,
      store: new MemoryCopyFollowStore(),
      feeShareLaw: publishedFee,
      jurisdictionLaw: publishedJur,
      placeMirrorEnabled: true,
      placeFollowerOrder: async () => ({ orderId: 'unused' }),
      flattenCopyPosition: async () => ({ orderIds: ['ord-flat-1'] }),
    });
    const caller = createTradeRouter({} as TradeService, undefined, copy).createCaller(signed());
    const first = await caller.copy.follow(followInput());
    expect((await caller.copy.pause({ followId: first.followId })).disposition).toBe('PAUSE_NEW');
    expect((await caller.copy.resume({ followId: first.followId })).disposition).toBe('RESUME');
    const stopped = await caller.copy.stop({ followId: first.followId });
    expect(stopped.disposition).toBe('STOP_NEW');
    expect(COPY_STOP_DISPOSITIONS).not.toContain('DETACH_FLATTEN');
    expect(copyStopOutput.safeParse({ ...stopped, disposition: 'DETACH_FLATTEN' }).success).toBe(false);

    const kept = await caller.copy.follow({
      ...followInput(),
      leaderId: '00000000-0000-4000-8000-0000000000b2',
    });
    expect((await caller.copy.detach({ followId: kept.followId })).disposition).toBe('DETACH_KEEP');

    const flat = await caller.copy.follow({
      ...followInput(),
      leaderId: '00000000-0000-4000-8000-0000000000b3',
    });
    expect((await caller.copy.flatten({ followId: flat.followId, requestId: 'flatten-0001' })).disposition).toBe('DETACH_FLATTEN');
  });
});
