/**
 * CB-copy-12: lead trader application and missions (service + tRPC mount).
 * Spec Test row: follows-master refuse, blank threshold refuse, same-key resubmit
 * returns the same row, disapproved -> resubmit after the owner window (blank
 * refuses), blank mission minimum -> not_set_by_platform and listing blocked.
 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { createTradeRouter } from '../router.js';
import type { TradeService } from '../spot/trade-service.js';
import { CopyError } from './errors.js';
import { BLANK_COPY_LEAD_LAW, parseCopyLeadLawJson, type CopyLeadLaw } from './lead-law.js';
import {
  LeaderApplicationService,
  MemoryLeaderApplicationStore,
  leaderApplyKey,
  type LeaderEligibilityPorts,
  type LeaderApplyInput,
} from './leader-application.js';

const USER = '00000000-0000-4000-8000-0000000012a1';
const REVIEWER = '00000000-0000-4000-8000-0000000012f0';

const LAW: CopyLeadLaw = {
  spotMarkets: ['BTC/USDT', 'ETH/USDT'],
  futuresMarkets: null,
  verificationLevel: 'full',
  balanceAsset: 'USDT',
  balanceThreshold: '1000',
  resubmitDays: 30,
  missionTransferMinimum: '500',
  missionDaysToList: 14,
};

const INPUT: LeaderApplyInput = {
  mode: 'spot',
  nickname: 'Steady',
  contact: 'steady@example.test',
  tradingStyle: 'swing, low leverage',
  markets: ['BTC/USDT'],
};

function ports(over: Partial<LeaderEligibilityPorts> = {}): LeaderEligibilityPorts {
  return {
    activeFollowCount: async () => 0,
    copyAccountCount: async () => 0,
    verificationLevel: async () => 'full',
    freeBalance: async () => parseAmount('1500'),
    ...over,
  };
}

function svc(
  opts: { law?: CopyLeadLaw; ports?: Partial<LeaderEligibilityPorts>; now?: () => Date; store?: MemoryLeaderApplicationStore } = {},
) {
  const store = opts.store ?? new MemoryLeaderApplicationStore();
  return { store, service: new LeaderApplicationService(store, ports(opts.ports), opts.law ?? LAW, opts.now) };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof CopyError) return err.code;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('CB-copy-12 lead application eligibility', () => {
  it('a user who follows a master is refused trade.copy_lead_follows_master before any write', async () => {
    const { service, store } = svc({ ports: { activeFollowCount: async () => 1 } });
    expect(await code(service.apply(USER, INPUT))).toBe('trade.copy_lead_follows_master');
    expect(await store.listByUser(USER)).toEqual([]);
  });

  it('a blank balance threshold refuses trade.copy_lead_threshold_not_set (never a default)', async () => {
    const { service, store } = svc({ law: { ...LAW, balanceThreshold: null } });
    expect(await code(service.apply(USER, INPUT))).toBe('trade.copy_lead_threshold_not_set');
    expect(await store.listByUser(USER)).toEqual([]);
  });

  it('a blank balance asset also refuses trade.copy_lead_threshold_not_set', async () => {
    const { service } = svc({ law: { ...LAW, balanceAsset: null } });
    expect(await code(service.apply(USER, INPUT))).toBe('trade.copy_lead_threshold_not_set');
  });

  it('a free balance below the owner threshold refuses', async () => {
    const { service } = svc({ ports: { freeBalance: async () => parseAmount('999.999999') } });
    expect(await code(service.apply(USER, INPUT))).toBe('trade.copy_lead_balance_below_threshold');
  });

  it('an existing copy account (any past follow) refuses', async () => {
    const { service } = svc({ ports: { copyAccountCount: async () => 1 } });
    expect(await code(service.apply(USER, INPUT))).toBe('trade.copy_lead_has_copy_account');
  });

  it('blank owner market list refuses; a market outside the list refuses', async () => {
    expect(await code(svc().service.apply(USER, { ...INPUT, mode: 'futures' }))).toBe('trade.copy_lead_markets_not_set');
    expect(await code(svc().service.apply(USER, { ...INPUT, markets: ['DOGE/USDT'] }))).toBe('trade.copy_lead_market_not_permitted');
  });

  it('verification: blank owner level, unwired read, failing read and a lower level all refuse', async () => {
    expect(await code(svc({ law: { ...LAW, verificationLevel: null } }).service.apply(USER, INPUT))).toBe(
      'trade.copy_lead_verification_not_set',
    );
    const unwired = new LeaderApplicationService(
      new MemoryLeaderApplicationStore(),
      { activeFollowCount: async () => 0, copyAccountCount: async () => 0, freeBalance: async () => parseAmount('5000') },
      LAW,
    );
    expect(await code(unwired.apply(USER, INPUT))).toBe('trade.copy_lead_verification_unavailable');
    const failing = svc({ ports: { verificationLevel: async () => Promise.reject(new Error('identity down')) } });
    expect(await code(failing.service.apply(USER, INPUT))).toBe('trade.copy_lead_verification_unavailable');
    expect(await code(svc({ ports: { verificationLevel: async () => 'basic' } }).service.apply(USER, INPUT))).toBe(
      'trade.copy_lead_verification_insufficient',
    );
    expect(await code(svc({ ports: { verificationLevel: async () => 'mystery' } }).service.apply(USER, INPUT))).toBe(
      'trade.copy_lead_verification_insufficient',
    );
  });
});

describe('CB-copy-12 lead application state and idempotency', () => {
  it('a valid application is submitted under the business key; a second submit returns the same row', async () => {
    const { service, store } = svc();
    const first = await service.apply(USER, INPUT);
    expect(first.state).toBe('submitted');
    expect(first.idempotencyKey).toBe(leaderApplyKey(USER, 'spot'));
    expect(first.idempotencyKey).toBe(`copy.leader_apply:${USER}:spot`);
    const again = await service.apply(USER, { ...INPUT, nickname: 'Changed' });
    expect(again).toEqual(first);
    expect(await store.listByUser(USER)).toHaveLength(1);
  });

  it('two concurrent identical applies write exactly one row', async () => {
    const { service, store } = svc();
    const [a, b] = await Promise.all([service.apply(USER, INPUT), service.apply(USER, INPUT)]);
    expect(a.id).toBe(b.id);
    expect(await store.listByUser(USER)).toHaveLength(1);
  });

  it('disapproved: resubmit refused inside the owner window, allowed after it, on the same row', async () => {
    let now = new Date('2026-10-01T00:00:00.000Z');
    const { service, store } = svc({ now: () => now });
    const app = await service.apply(USER, INPUT);
    const rejected = await service.decide(app.id, { state: 'disapproved', actorId: REVIEWER, reason: 'record too short' });
    expect(rejected.state).toBe('disapproved');
    expect(rejected.decisionReason).toBe('record too short');

    now = new Date('2026-10-30T23:59:59.000Z');
    expect(await code(service.apply(USER, INPUT))).toBe('trade.copy_lead_resubmit_too_early');

    now = new Date('2026-10-31T00:00:00.000Z');
    const resubmitted = await service.apply(USER, { ...INPUT, tradingStyle: 'longer record now' });
    expect(resubmitted.id).toBe(app.id);
    expect(resubmitted.state).toBe('submitted');
    expect(resubmitted.tradingStyle).toBe('longer record now');
    expect(resubmitted.decidedAt).toBeNull();
    expect(await store.listByUser(USER)).toHaveLength(1);
  });

  it('disapproved with a blank resubmit window refuses resubmit (blank never means "any time")', async () => {
    const { service } = svc({ law: { ...LAW, resubmitDays: null } });
    const app = await service.apply(USER, INPUT);
    await service.decide(app.id, { state: 'disapproved', actorId: REVIEWER, reason: 'no' });
    expect(await code(service.apply(USER, INPUT))).toBe('trade.copy_lead_resubmit_not_set');
  });

  it('decide: only legal moves, reason required, unknown id refused', async () => {
    const { service } = svc();
    const app = await service.apply(USER, INPUT);
    expect(await code(service.decide(app.id, { state: 'approved', actorId: REVIEWER, reason: '  ' }))).toBe(
      'trade.copy_lead_state_invalid',
    );
    const review = await service.decide(app.id, { state: 'under_review', actorId: REVIEWER, reason: 'picked up' });
    expect(review.state).toBe('under_review');
    const approved = await service.decide(app.id, { state: 'approved', actorId: REVIEWER, reason: 'ok' });
    expect(approved.state).toBe('approved');
    expect(await code(service.decide(app.id, { state: 'disapproved', actorId: REVIEWER, reason: 'late' }))).toBe(
      'trade.copy_lead_state_invalid',
    );
    expect(await code(service.decide('nope', { state: 'approved', actorId: REVIEWER, reason: 'x' }))).toBe(
      'trade.copy_lead_application_not_found',
    );
    // An approved application is returned as stored on re-apply.
    expect((await service.apply(USER, INPUT)).state).toBe('approved');
  });
});

describe('CB-copy-12 missions', () => {
  it('blank mission minimum and days-to-list report not_set_by_platform and keep the listing step blocked', async () => {
    const { service } = svc({ law: { ...LAW, missionTransferMinimum: null, missionDaysToList: null } });
    const m = await service.missions(USER, 'spot');
    expect(m.applicationState).toBeNull();
    expect(m.steps.find((s) => s.key === 'transfer_minimum')).toEqual({
      key: 'transfer_minimum',
      state: 'blocked',
      value: null,
      reason: 'not_set_by_platform',
    });
    expect(m.steps.find((s) => s.key === 'days_to_list')?.reason).toBe('not_set_by_platform');
    expect(m.listingStep).toEqual({ state: 'blocked', reason: 'not_set_by_platform' });
  });

  it('published owner values are listed as decimal strings; the apply and approval steps follow the application', async () => {
    const { service } = svc();
    const before = await service.missions(USER, 'spot');
    expect(before.steps.map((s) => [s.key, s.state])).toEqual([
      ['apply', 'pending'],
      ['approval', 'pending'],
      ['transfer_minimum', 'pending'],
      ['days_to_list', 'pending'],
    ]);
    expect(before.steps[2]!.value).toBe('500');
    expect(typeof before.steps[2]!.value).toBe('string');
    await service.apply(USER, INPUT);
    const after = await service.missions(USER, 'spot');
    expect(after.applicationState).toBe('submitted');
    expect(after.steps[0]!.state).toBe('done');
    expect(after.steps[1]!.reason).toBe('awaiting_review');
    expect(after.listingStep).toEqual({ state: 'pending', reason: 'awaiting_steps' });
  });
});

describe('CB-copy-12 owner law parsing', () => {
  it('empty env is all blank; amounts must be decimal strings, never numbers', () => {
    expect(parseCopyLeadLawJson('')).toEqual(BLANK_COPY_LEAD_LAW);
    expect(parseCopyLeadLawJson('{"balanceThreshold":"  ","spotMarkets":[]}')).toEqual(BLANK_COPY_LEAD_LAW);
    expect(() => parseCopyLeadLawJson('{"balanceThreshold":1000}')).toThrow(/string/);
    expect(() => parseCopyLeadLawJson('{"resubmitDays":1.5}')).toThrow(/days/);
    expect(parseCopyLeadLawJson(JSON.stringify(LAW))).toEqual(LAW);
  });
});

const SECRET = 'a-trade-copy-lead-test-edge-secret-long';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-trade' });
function signed(scopes: string[] = ['trade:read', 'trade:write']) {
  const p = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'SG'),
      'x-intafaced-region': 'SG',
    },
    id: 'req-copy-lead',
  });
}

function mount(service?: LeaderApplicationService) {
  return createTradeRouter({} as unknown as TradeService, undefined, undefined, undefined, undefined, undefined, undefined, service);
}

describe('CB-copy-12 tRPC mount (copy.leaderApply / leaderApplications / leaderMissions)', () => {
  it('apply -> mine -> missions through the router; wire carries no contact or user id', async () => {
    const caller = mount(svc().service).createCaller(signed());
    const app = await caller.copy.leaderApply({ ...INPUT, nickname: '  Steady  ' });
    expect(app.state).toBe('submitted');
    expect(app.nickname).toBe('Steady');
    expect(app).not.toHaveProperty('contact');
    expect(app).not.toHaveProperty('userId');
    const mine = await caller.copy.leaderApplications();
    expect(mine.applications.map((a) => a.id)).toEqual([app.id]);
    const missions = await caller.copy.leaderMissions({ mode: 'spot' });
    expect(missions.applicationState).toBe('submitted');
  });

  it('a refusal reaches the caller with its typed code', async () => {
    const caller = mount(svc({ ports: { activeFollowCount: async () => 2 } }).service).createCaller(signed());
    await expect(caller.copy.leaderApply(INPUT)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: { code: 'trade.copy_lead_follows_master' },
    });
    const blank = mount(svc({ law: BLANK_COPY_LEAD_LAW }).service).createCaller(signed());
    await expect(blank.copy.leaderApply(INPUT)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'trade.copy_lead_markets_not_set' },
    });
  });

  it('unmounted service refuses trade.copy_unavailable; apply needs trade:write', async () => {
    await expect(mount().createCaller(signed()).copy.leaderMissions({ mode: 'spot' })).rejects.toMatchObject({
      cause: { code: 'trade.copy_unavailable' },
    });
    await expect(
      mount(svc().service)
        .createCaller(signed(['trade:read']))
        .copy.leaderApply(INPUT),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
