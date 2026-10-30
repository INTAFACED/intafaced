import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, type CampaignParticipant } from '@intafaced/contracts';
import { parseAmount as amt } from '@intafaced/ledger-client';
import {
  stubApprovalConsumer,
  tokenActionPayloadHash,
  unwiredApprovalConsumer,
  type ActionApprovalConsumer,
} from '../action-approval-consume.js';
import {
  createParticipantClient,
  decideEligibility,
  parseEligibilityRule,
  unwiredParticipants,
  type ParticipantSource,
} from './eligibility.js';
import { LaunchError } from './errors.js';
import type { LaunchEvent, LaunchService } from './launch-service.js';
import { LAUNCH_EVENT_CREATE_ACTION, LAUNCH_EVENT_MOVE_ACTION, createLaunchRouter, launchEventPayload } from './router.js';

/** J-more-catalogue-11 doors: who may call what, the wire shape, and who may take part. Every figure is TEST. */

const SECRET = 'a-token-launch-router-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-token' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['token:read'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}
const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });

const OPEN: LaunchEvent = {
  id: 'test-open-launch',
  issuer: { id: 'test-issuer', name: 'TEST Issuer', state: 'onboarded' },
  type: 'token_sale',
  projectName: 'TEST Project',
  symbol: 'TST',
  periods: {
    announceAt: new Date('2026-11-01T00:00:00Z'),
    snapshotAt: new Date('2026-11-01T01:00:00Z'),
    openAt: new Date('2026-11-01T02:00:00Z'),
    closeAt: new Date('2026-11-01T10:00:00Z'),
    distributionAt: new Date('2026-11-01T11:00:00Z'),
  },
  status: 'open',
  state: 'open',
  allocation: { method: 'pro_rata', perUserCap: amt('250'), ticketSize: null, tierWeights: null },
  terms: { price: amt('0.5'), paymentAsset: 'USDT', rateSource: null },
  snapshot: { count: 1, total: amt('120.5'), hash: 'h', takenAt: new Date('2026-11-01T01:30:00Z') },
  revision: 3,
};

const VERIFIED: CampaignParticipant = { userId: USER, accountType: 'individual', region: 'DE', status: 'active', kycTier: 'basic' };
const RULE_ENV = { TOKEN_LAUNCH_MIN_KYC_TIER: 'basic', TOKEN_LAUNCH_RESTRICTED_REGIONS: 'none' };

function fakeService(overrides: Partial<Record<keyof LaunchService, unknown>> = {}) {
  return {
    listEvents: vi.fn(async () => [OPEN]),
    getEvent: vi.fn(async () => OPEN),
    readBasis: vi.fn(async () => ({
      eventId: OPEN.id,
      method: 'pro_rata',
      perUserCap: amt('250'),
      ticketSize: null,
      tierWeights: null,
      basis: amt('120.5'),
      reason: null,
      takenAt: new Date('2026-11-01T01:30:00Z'),
      tickets: null,
      tierWeight: null,
    })),
    createEvent: vi.fn(async () => ({ id: OPEN.id, status: 'draft', revision: 0 })),
    moveEvent: vi.fn(async () => OPEN),
    checkCreate: vi.fn(async () => undefined),
    checkMove: vi.fn(async () => undefined),
    setIssuer: vi.fn(),
    checkIssuerSet: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as LaunchService & Record<string, ReturnType<typeof vi.fn>>;
}

function caller(
  ctx: ReturnType<typeof signed>,
  service = fakeService(),
  opts: { approvals?: ActionApprovalConsumer; participants?: ParticipantSource; env?: typeof RULE_ENV | Record<string, string> } = {},
) {
  return createLaunchRouter(service, {
    approvals: opts.approvals ?? stubApprovalConsumer(APPROVER),
    participants: opts.participants ?? { read: async () => VERIFIED },
    eligibilityEnv: () => opts.env ?? RULE_ENV,
  }).createCaller(ctx);
}

describe('launch catalogue reads', () => {
  it('reads signed in or out, amounts as decimal strings and times as ISO', async () => {
    const list = await caller(anonymous()).events.list({ state: 'open', limit: 50 });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      issuer: { state: 'onboarded' },
      allocation: { method: 'pro_rata', perUserCap: '250', ticketSize: null },
      terms: { price: '0.5', paymentAsset: 'USDT' },
      periods: { openAt: '2026-11-01T02:00:00.000Z' },
      snapshot: { count: 1, total: '120.5' },
    });
    expect(list[0]).not.toHaveProperty('snapshot.hash');
    expect((await caller(signed()).events.get({ id: OPEN.id })).id).toBe(OPEN.id);
  });

  it('a missing page size reaches the service and refuses with its code', async () => {
    const service = fakeService({
      listEvents: vi.fn(async () => {
        throw new LaunchError('A page size is required', 'launch.events_list_limit_unset');
      }),
    });
    await expect(caller(anonymous(), service).events.list({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'launch.events_list_limit_unset' },
    });
  });

  it('an unknown launch is NOT_FOUND', async () => {
    const service = fakeService({
      getEvent: vi.fn(async () => {
        throw new LaunchError('nope', 'launch.event_not_found');
      }),
    });
    await expect(caller(anonymous(), service).events.get({ id: 'test-missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('basis and eligibility read the signed account only', () => {
  it('anonymous callers are unauthorised and the service is not asked', async () => {
    const service = fakeService();
    await expect(caller(anonymous(), service).basis({ id: OPEN.id })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller(anonymous(), service).eligibility({ id: OPEN.id })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(service.readBasis).not.toHaveBeenCalled();
  });

  it('the basis is the stored row for the principal, the cap a decimal string', async () => {
    const service = fakeService();
    const basis = await caller(signed(), service).basis({ id: OPEN.id });
    expect(service.readBasis).toHaveBeenCalledWith(OPEN.id, USER);
    expect(basis).toMatchObject({ basis: '120.5', perUserCap: '250', method: 'pro_rata', takenAt: '2026-11-01T01:30:00.000Z' });
  });

  it('an unverified account lists identity verification as unmet', async () => {
    // Signed in at tier none: the token module's tier guard would refuse it, so eligibility carries none.
    const result = await caller(signed(principal({ tier: 'none' })), fakeService(), {
      participants: { read: async () => ({ ...VERIFIED, kycTier: 'none' }) },
    }).eligibility({
      id: OPEN.id,
    });
    expect(result.eligible).toBe(false);
    expect(result.requirements.find((r) => r.id === 'identity_verification')).toEqual({
      id: 'identity_verification',
      met: false,
      required: 'basic',
      actual: 'none',
    });
    expect(result.requirements.filter((r) => !r.met).map((r) => r.id)).toEqual(['identity_verification']);
  });

  it('a blank rule refuses before identity is asked; an unread account refuses, never eligible', async () => {
    const read = vi.fn(async () => VERIFIED);
    await expect(caller(signed(), fakeService(), { participants: { read }, env: {} }).eligibility({ id: OPEN.id })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'launch.min_kyc_tier_unset' },
    });
    await expect(
      caller(signed(), fakeService(), { participants: { read }, env: { TOKEN_LAUNCH_MIN_KYC_TIER: 'basic' } }).eligibility({ id: OPEN.id }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'launch.restricted_regions_unset' },
    });
    expect(read).not.toHaveBeenCalled();
    await expect(
      caller(signed(), fakeService(), { participants: unwiredParticipants() }).eligibility({ id: OPEN.id }),
    ).rejects.toMatchObject({
      cause: { code: 'launch.eligibility_unavailable' },
    });
  });

  it('a sub-account is not the main account', async () => {
    const result = await caller(
      signed(principal({ sub_account: '77777777-7777-4777-8777-777777777777' } as Partial<Principal>)),
    ).eligibility({
      id: OPEN.id,
    });
    expect(result.requirements.find((r) => r.id === 'main_account')).toMatchObject({ met: false, actual: 'sub' });
  });
});

describe('operator doors', () => {
  const admin = () => signed(principal({ scopes: ['admin:write'] }));
  const createInput = {
    id: OPEN.id,
    issuerId: 'test-issuer',
    type: 'token_sale' as const,
    projectName: 'TEST Project',
    symbol: 'TST',
    periods: {
      announceAt: '2026-11-01T00:00:00Z',
      snapshotAt: '2026-11-01T01:00:00Z',
      openAt: '2026-11-01T02:00:00Z',
      closeAt: '2026-11-01T10:00:00Z',
      distributionAt: '2026-11-01T11:00:00Z',
    },
    allocation: { method: 'pro_rata' as const, perUserCap: '250', ticketSize: null, tierWeights: null },
    terms: { price: '0.5', paymentAsset: 'USDT', rateSource: null },
  };

  it('need admin:write', async () => {
    await expect(caller(signed()).events.create({ ...createInput, approvalId: 'a' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller(anonymous()).events.move({ id: OPEN.id, to: 'closed', expectedRevision: 3 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('create binds the founders’ approval to the canonical event and needs a second person', async () => {
    const consume = vi.fn(stubApprovalConsumer(APPROVER).consume);
    const service = fakeService();
    const out = await caller(admin(), service, { approvals: { consume } }).events.create({
      ...createInput,
      approvalId: 'approval-1',
      operationId: 'op-1',
    });
    expect(out).toMatchObject({ id: OPEN.id, status: 'draft', confirmOperatorId: APPROVER });
    const payload = launchEventPayload({
      ...createInput,
      periods: Object.fromEntries(Object.entries(createInput.periods).map(([k, v]) => [k, new Date(v)])) as never,
    });
    expect(consume.mock.calls[0]![0]).toMatchObject({
      targetId: LAUNCH_EVENT_CREATE_ACTION,
      targetService: 'svc-token',
      payloadHash: tokenActionPayloadHash(LAUNCH_EVENT_CREATE_ACTION, { event: payload }),
    });
    // The same person cannot approve their own launch.
    await expect(
      caller(admin(), service, { approvals: stubApprovalConsumer(USER) }).events.create({
        ...createInput,
        approvalId: 'a',
        operationId: 'op-3',
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('an invalid launch is refused before an approval is spent; no identity is unwired', async () => {
    const consume = vi.fn(stubApprovalConsumer(APPROVER).consume);
    await expect(
      caller(admin(), fakeService(), { approvals: { consume } }).events.create({ ...createInput, symbol: 'tst', approvalId: 'a' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', cause: { code: 'launch.event_invalid' } });
    expect(consume).not.toHaveBeenCalled();
    const service = fakeService();
    await expect(
      caller(admin(), service, { approvals: unwiredApprovalConsumer() }).events.move({
        id: OPEN.id,
        to: 'closed',
        expectedRevision: 3,
        approvalId: 'a',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(service.moveEvent).not.toHaveBeenCalled();
  });

  it('a launch, move or issuer change the service refuses never spends the approval', async () => {
    const consume = vi.fn(stubApprovalConsumer(APPROVER).consume);
    const service = fakeService({
      checkMove: vi.fn(async () => {
        throw new LaunchError('Launch is at revision 4', 'launch.event_stale');
      }),
      checkIssuerSet: vi.fn(async () => {
        throw new LaunchError('Issuer cannot move from applied to onboarded', 'launch.issuer_move_invalid');
      }),
      checkCreate: vi.fn(async () => {
        throw new LaunchError('Issuer test-issuer not found', 'launch.issuer_not_found');
      }),
    });
    const admin1 = caller(admin(), service, { approvals: { consume } });
    await expect(admin1.events.move({ id: OPEN.id, to: 'closed', expectedRevision: 3, approvalId: 'a' })).rejects.toMatchObject({
      cause: { code: 'launch.event_stale' },
    });
    await expect(
      admin1.issuer.set({ id: 'tst-issuer', name: 'TEST Issuer', state: 'onboarded', expectedRevision: 1, approvalId: 'a' }),
    ).rejects.toMatchObject({ cause: { code: 'launch.issuer_move_invalid' } });
    await expect(admin1.events.create({ ...createInput, approvalId: 'a' })).rejects.toMatchObject({
      cause: { code: 'launch.issuer_not_found' },
    });
    expect(consume).not.toHaveBeenCalled();
    expect(service.moveEvent).not.toHaveBeenCalled();
    expect(service.setIssuer).not.toHaveBeenCalled();
    expect(service.createEvent).not.toHaveBeenCalled();
  });

  it('move passes the actor and the approver to the service', async () => {
    const consume = vi.fn(stubApprovalConsumer(APPROVER).consume);
    const service = fakeService();
    await caller(admin(), service, { approvals: { consume } }).events.move({
      id: OPEN.id,
      to: 'closed',
      expectedRevision: 3,
      approvalId: 'a',
      operationId: 'op-2',
    });
    expect(consume.mock.calls[0]![0]).toMatchObject({
      targetId: LAUNCH_EVENT_MOVE_ACTION,
      expectedVersion: '3',
      payloadHash: tokenActionPayloadHash(LAUNCH_EVENT_MOVE_ACTION, { eventId: OPEN.id, to: 'closed', expectedRevision: '3' }),
    });
    expect(service.moveEvent).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: USER, approverId: APPROVER, to: 'closed', expectedRevision: 3 }),
    );
  });

  it('create passes the actor and the approver to the service', async () => {
    const consume = vi.fn(stubApprovalConsumer(APPROVER).consume);
    const service = fakeService();
    await caller(admin(), service, { approvals: { consume } }).events.create({ ...createInput, approvalId: 'a', operationId: 'op-1' });
    expect(service.createEvent).toHaveBeenCalledWith(expect.anything(), { actorId: USER, approverId: APPROVER });
  });
});

describe('eligibility rule', () => {
  it('a blank or malformed owner value refuses; none means no region is restricted', () => {
    const code = (env: Parameters<typeof parseEligibilityRule>[0]) => {
      try {
        parseEligibilityRule(env);
      } catch (err) {
        return err instanceof LaunchError ? err.code : 'not a LaunchError';
      }
      return 'accepted';
    };
    expect(code({})).toBe('launch.min_kyc_tier_unset');
    expect(code({ TOKEN_LAUNCH_MIN_KYC_TIER: ' ', TOKEN_LAUNCH_RESTRICTED_REGIONS: 'none' })).toBe('launch.min_kyc_tier_unset');
    expect(code({ TOKEN_LAUNCH_MIN_KYC_TIER: 'gold', TOKEN_LAUNCH_RESTRICTED_REGIONS: 'none' })).toBe('launch.min_kyc_tier_unset');
    expect(code({ TOKEN_LAUNCH_MIN_KYC_TIER: 'basic' })).toBe('launch.restricted_regions_unset');
    expect(code({ TOKEN_LAUNCH_MIN_KYC_TIER: 'basic', TOKEN_LAUNCH_RESTRICTED_REGIONS: ' ' })).toBe('launch.restricted_regions_unset');
    expect(code({ TOKEN_LAUNCH_MIN_KYC_TIER: 'basic', TOKEN_LAUNCH_RESTRICTED_REGIONS: 'de' })).toBe('launch.restricted_regions_unset');
    expect(parseEligibilityRule(RULE_ENV)).toEqual({ minKycTier: 'basic', restrictedRegions: [] });
    expect(
      parseEligibilityRule({ TOKEN_LAUNCH_MIN_KYC_TIER: 'full', TOKEN_LAUNCH_RESTRICTED_REGIONS: 'KP, IR' }).restrictedRegions,
    ).toEqual(['KP', 'IR']);
  });

  it('lists every requirement, met or not', () => {
    const rule = { minKycTier: 'full' as const, restrictedRegions: ['KP'] };
    const result = decideEligibility(
      rule,
      { ...OPEN, status: 'snapshot', issuer: { ...OPEN.issuer, state: 'suspended' } },
      { ...VERIFIED, region: 'KP', status: 'frozen' },
      false,
    );
    expect(result.eligible).toBe(false);
    expect(Object.fromEntries(result.requirements.map((r) => [r.id, r.met]))).toEqual({
      identity_verification: false,
      region: false,
      account_active: false,
      main_account: true,
      issuer_onboarded: false,
      event_open: false,
    });
    expect(
      decideEligibility(rule, OPEN, { ...VERIFIED, region: null, kycTier: 'full' }, false).requirements.find((r) => r.id === 'region'),
    ).toMatchObject({
      met: false,
      actual: 'unknown',
    });
    expect(decideEligibility({ minKycTier: 'basic', restrictedRegions: [] }, OPEN, VERIFIED, false).eligible).toBe(true);
  });
});

describe('participant client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('any failure reads as null, and an answer about another user is null', async () => {
    const client = createParticipantClient('http://identity.test', 'secret-long-enough-for-the-legacy-hmac');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    );
    expect(await client.read(USER)).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('down'))),
    );
    expect(await client.read(USER)).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...VERIFIED, userId: APPROVER })),
    );
    expect(await client.read(USER)).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...VERIFIED, kycTier: 'gold' })),
    );
    expect(await client.read(USER)).toBeNull();
    const fetchOk = vi.fn(async () => Response.json(VERIFIED));
    vi.stubGlobal('fetch', fetchOk);
    expect(await client.read(USER)).toEqual(VERIFIED);
    expect(String((fetchOk.mock.calls[0] as unknown[])[0])).toBe(`http://identity.test/internal/campaign-participant/${USER}`);
  });
});

describe('operator lens reads (J-more-catalogue-14)', () => {
  const reader = () => signed(principal({ scopes: ['admin:read'] }));
  const lensService = () =>
    fakeService({
      listAllEvents: vi.fn(async () => [{ ...OPEN, status: 'draft' as const, state: null }]),
      getAnyEvent: vi.fn(async () => ({ ...OPEN, status: 'draft' as const, state: null })),
      listIssuers: vi.fn(async () => [{ id: 'test-issuer', name: 'TEST Issuer', state: 'onboarded' as const, revision: 3 }]),
      moves: vi.fn(async () => [
        {
          ordinal: 4,
          from: 'open',
          to: 'closed',
          actorId: USER,
          approverId: APPROVER,
          cause: 'issuer_suspended',
          at: new Date('2026-11-01T03:00:00Z'),
        },
      ]),
    });

  it('need admin:read: a customer and an anonymous caller never reach the service', async () => {
    const service = lensService();
    await expect(caller(signed(), service).admin.events({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller(anonymous(), service).admin.issuers()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller(signed(), service).admin.moves({ kind: 'event', id: OPEN.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(service.listAllEvents).not.toHaveBeenCalled();
    expect(service.moves).not.toHaveBeenCalled();
  });

  it('list drafts too, and each move with who asked, who approved and why, times as ISO', async () => {
    const service = lensService();
    expect((await caller(reader(), service).admin.events({ limit: 10 }))[0]).toMatchObject({ id: OPEN.id, status: 'draft', state: null });
    expect(await caller(reader(), service).admin.event({ id: OPEN.id })).toMatchObject({ status: 'draft' });
    expect(await caller(reader(), service).admin.issuers()).toEqual([
      { id: 'test-issuer', name: 'TEST Issuer', state: 'onboarded', revision: 3 },
    ]);
    expect(await caller(reader(), service).admin.moves({ kind: 'event', id: OPEN.id })).toEqual([
      {
        ordinal: 4,
        from: 'open',
        to: 'closed',
        actorId: USER,
        approverId: APPROVER,
        cause: 'issuer_suspended',
        at: '2026-11-01T03:00:00.000Z',
      },
    ]);
  });
});
