import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { createMarketRouter, listingOut, reviewPublicOut } from './router.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { userCopy } from './user-copy.js';
import {
  CommerceService,
  assertMyListingsListLimit,
  assertMyPurchasesListLimit,
  assertPublicListingsListLimit,
} from './commerce/commerce-service.js';
import { ReviewsService } from './reviews/reviews-service.js';
import type { SlotEntitlementSource, VendorEntitlement } from './stake-source.js';
import {
  MARKET_OPS_SCOPE,
  MarketError,
  VendorService,
  assertApplicationsListLimit,
  assertHistoryLimit,
  assertListedVendorsListLimit,
} from './vendor-service.js';
import type { PerpProposalService } from './perp-proposal-service.js';
import { MARKET_LISTING_PIN_ENV } from './live-markets.js';

/**
 * REACHABILITY, NOT SHAPE.
 *
 * These tests never construct a `Context` literal. They sign a real principal
 * header the way svc-edge does and go in through `createEdgeContext`, because a
 * hand-built context proves the resolver's types and nothing about whether an
 * unsigned or absent header would have been accepted.
 *
 * Every refusal asserts TWO things: the code the caller receives, and that the
 * service was never called. A guard that throws after the work has happened is
 * not a guard.
 */

const SECRET = 'a-market-mount-test-edge-secret-long';
const USER = '11111111-1111-4111-8111-111111111111';
const OP = '33333333-3333-4333-8333-333333333333';
const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const VENDOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const APPROVAL = { approvalId: 'appr-1', operationId: 'op-1' } as const;

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-market' });

/**
 * `tier: 'basic'` by default because `market` is OPEN_BASIC in
 * DEFAULT_MODULE_RULES. The tier-`none` case is a test of its own below.
 */
function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['market:read', 'market:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });

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

const vendorRow = {
  id: VENDOR,
  userId: USER,
  displayName: 'Acme',
  description: 'I sell things',
  status: 'applied' as const,
  createdAt: '2026-08-08T10:00:00.000Z',
  updatedAt: '2026-08-08T10:00:00.000Z',
};

const slotRow = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  vendorId: VENDOR,
  ref: 'listing-1',
  claimedAt: '2026-08-08T10:00:00.000Z',
  releasedAt: null,
};

/** No `userId`, no `status`, no tier — see `PublicVendorProfile` for each omission. */
const publicRow = {
  id: VENDOR,
  displayName: 'Acme',
  description: 'I sell things',
  createdAt: '2026-08-08T10:00:00.000Z',
};

function stubVendors(overrides: Partial<VendorService> = {}): VendorService {
  return {
    applyAsVendor: vi.fn(async () => vendorRow),
    myVendor: vi.fn(async () => null),
    listApplications: vi.fn(async () => []),
    vet: vi.fn(async () => ({ changed: true, vendor: { ...vendorRow, status: 'approved' as const }, event: null })),
    history: vi.fn(async () => []),
    claimSlot: vi.fn(async () => ({ claimed: true, slot: slotRow })),
    releaseSlot: vi.fn(async () => ({ released: true })),
    slotStatus: vi.fn(async () => ({
      vendorId: VENDOR,
      status: 'approved' as const,
      tier: 'Operator',
      capacity: 3,
      held: 1,
      usable: 1,
      slots: [slotRow],
    })),
    publicProfile: vi.fn(async () => publicRow),
    listedVendors: vi.fn(async () => [publicRow]),
    listingEligibility: vi.fn(async () => ({ vendorId: VENDOR, listed: true })),
    ...overrides,
  } as unknown as VendorService;
}

describe('svc-market mount — perpetual proposal authority', () => {
  it('refuses a signed request under default blank screening before reaching the vendor service', async () => {
    const vendors = stubVendors();
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', undefined);
    vi.stubEnv('INTAFACED_REGION_FAIL_CLOSED', undefined);
    try {
      await expect(createMarketRouter(vendors).createCaller(signed()).mine()).rejects.toMatchObject({
        code: 'FORBIDDEN',
        cause: { decision: { code: 'denied.screening_unconfigured' } },
      });
      expect(vendors.myVendor).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('derives the perpetual proposal proposer from a market:write principal', async () => {
    const proposals = {
      propose: vi.fn(async (input) => ({
        ...input,
        id: input.clientProposalId,
        status: 'proposed',
        orderable: false,
        createdAt: '2026-08-23T12:00:00.000Z',
        updatedAt: '2026-08-23T12:00:00.000Z',
      })),
    } as unknown as PerpProposalService;
    const input = {
      clientProposalId: '22222222-2222-4222-8222-222222222222',
      symbol: 'fixture-perp',
      settle: 'fixture-settle',
      oracleSource: 'fixture-oracle',
      leverageCap: '2.5',
    };
    await createMarketRouter(stubVendors(), undefined, proposals).createCaller(signed()).proposePerpMarket(input);
    expect(proposals.propose).toHaveBeenCalledWith({ ...input, proposerId: USER });
  });

  it('does not reach perpetual proposals without market:write', async () => {
    const proposals = { propose: vi.fn() } as unknown as PerpProposalService;
    const input = {
      clientProposalId: '22222222-2222-4222-8222-222222222222',
      symbol: 'fixture-perp',
      settle: 'fixture-settle',
      oracleSource: 'fixture-oracle',
      leverageCap: '2.5',
    };
    await expect(
      createMarketRouter(stubVendors(), undefined, proposals)
        .createCaller(signed(principal({ scopes: ['market:read'] })))
        .proposePerpMarket(input),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(proposals.propose).not.toHaveBeenCalled();
  });

  it('passes a blank oracle to the domain gate and preserves its typed refusal', async () => {
    const proposals = {
      propose: vi.fn(async () => {
        throw new MarketError('market.oracle_source_unset', 'market.oracle_source_unset');
      }),
    } as unknown as PerpProposalService;
    await expect(
      createMarketRouter(stubVendors(), undefined, proposals).createCaller(signed()).proposePerpMarket({
        clientProposalId: '22222222-2222-4222-8222-222222222222',
        symbol: 'fixture-perp',
        settle: 'fixture-settle',
        oracleSource: '',
        leverageCap: '2.5',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'market.oracle_source_unset' });
    expect(proposals.propose).toHaveBeenCalledOnce();
  });
});

describe('svc-market mount — who may apply', () => {
  it('refuses an anonymous application', async () => {
    const vendors = stubVendors();
    await expect(
      createMarketRouter(vendors).createCaller(anonymous()).applyAsVendor({ displayName: 'Acme', description: 'I sell things' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(vendors.applyAsVendor).not.toHaveBeenCalled();
  });

  it('accepts a signed application with market:write', async () => {
    const vendors = stubVendors();
    const vendor = await createMarketRouter(vendors)
      .createCaller(signed())
      .applyAsVendor({ displayName: 'Acme', description: 'I sell things' });
    expect(vendor.status).toBe('applied');
    // The applicant is the PRINCIPAL, never a field in the body.
    expect(vendors.applyAsVendor).toHaveBeenCalledWith({ userId: USER, displayName: 'Acme', description: 'I sell things' });
  });

  it('refuses an application from a caller holding only market:read', async () => {
    const vendors = stubVendors();
    const reader = principal({ scopes: ['market:read'] });
    await expect(
      createMarketRouter(vendors).createCaller(signed(reader)).applyAsVendor({ displayName: 'Acme', description: 'I sell things' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(vendors.applyAsVendor).not.toHaveBeenCalled();
  });

  /**
   * The jurisdiction guard is LIVE, not decorative. `market` is OPEN_BASIC, so an
   * unverified account is refused with the matrix's own code — which is what lets
   * a screen say "verify to tier basic" instead of "refused".
   */
  it('refuses an unverified applicant with the matrix code, not a scope error', async () => {
    const vendors = stubVendors();
    const unverified = principal({ tier: 'none' });
    await expect(
      createMarketRouter(vendors).createCaller(signed(unverified)).applyAsVendor({ displayName: 'Acme', description: 'I sell things' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', cause: { code: 'denied.kyc_required', requiredTier: 'basic' } });
    expect(vendors.applyAsVendor).not.toHaveBeenCalled();
  });

  it('reads the caller own application back, and null is an answer', async () => {
    const vendors = stubVendors();
    await expect(createMarketRouter(vendors).createCaller(signed()).mine()).resolves.toBeNull();
    expect(vendors.myVendor).toHaveBeenCalledWith(USER);
  });
});

describe('svc-market mount — who may take a listing slot', () => {
  it('refuses an anonymous slot claim', async () => {
    const vendors = stubVendors();
    await expect(createMarketRouter(vendors).createCaller(anonymous()).claimSlot({ ref: 'listing-1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(vendors.claimSlot).not.toHaveBeenCalled();
  });

  /**
   * THE ONE THAT MATTERS MOST HERE. There is no `vendorId` in the input schema at
   * all, so the slot is always spent against the caller's own vendor row. A claim
   * that could name its vendor would let anyone burn somebody else's capacity —
   * and the refusal would land on the victim.
   */
  it('claims against the principal, never against a vendor named in the body', async () => {
    const vendors = stubVendors();
    const result = await createMarketRouter(vendors).createCaller(signed()).claimSlot({ ref: 'listing-1' });
    expect(result.claimed).toBe(true);
    expect(vendors.claimSlot).toHaveBeenCalledWith({ userId: USER, ref: 'listing-1' });
  });

  it('refuses a claim from a caller holding only market:read', async () => {
    const vendors = stubVendors();
    const reader = principal({ scopes: ['market:read'] });
    await expect(createMarketRouter(vendors).createCaller(signed(reader)).claimSlot({ ref: 'listing-1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(vendors.claimSlot).not.toHaveBeenCalled();
  });

  it('refuses an unverified claimant with the matrix code', async () => {
    const vendors = stubVendors();
    const unverified = principal({ tier: 'none' });
    await expect(createMarketRouter(vendors).createCaller(signed(unverified)).claimSlot({ ref: 'listing-1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: { code: 'denied.kyc_required', requiredTier: 'basic' },
    });
    expect(vendors.claimSlot).not.toHaveBeenCalled();
  });

  it('releases against the principal too', async () => {
    const vendors = stubVendors();
    await expect(createMarketRouter(vendors).createCaller(signed()).releaseSlot({ ref: 'listing-1' })).resolves.toEqual({
      released: true,
    });
    expect(vendors.releaseSlot).toHaveBeenCalledWith({ userId: USER, ref: 'listing-1' });
  });

  it('reads the caller own slot position, including what is usable', async () => {
    const vendors = stubVendors();
    await expect(createMarketRouter(vendors).createCaller(signed()).slots()).resolves.toMatchObject({
      tier: 'Operator',
      capacity: 3,
      held: 1,
      usable: 1,
    });
    expect(vendors.slotStatus).toHaveBeenCalledWith(USER);
  });

  it('refuses to read a slot position anonymously', async () => {
    const vendors = stubVendors();
    await expect(createMarketRouter(vendors).createCaller(anonymous()).slots()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(vendors.slotStatus).not.toHaveBeenCalled();
  });

  /**
   * The refusal codes reach the caller distinguishable, because they are three
   * different instructions: stake, wait for a release, or try again later.
   */
  it('maps a stake refusal to FORBIDDEN and a full tier to CONFLICT', async () => {
    const stakeRequired = stubVendors({
      claimSlot: vi.fn(async () => {
        throw new MarketError('Stake to earn a slot', 'market.stake_required');
      }),
    } as unknown as Partial<VendorService>);
    await expect(createMarketRouter(stakeRequired).createCaller(signed()).claimSlot({ ref: 'l' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: { code: 'market.stake_required' },
    });

    const exhausted = stubVendors({
      claimSlot: vi.fn(async () => {
        throw new MarketError('Every slot is in use', 'market.slots_exhausted');
      }),
    } as unknown as Partial<VendorService>);
    await expect(createMarketRouter(exhausted).createCaller(signed()).claimSlot({ ref: 'l' })).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: { code: 'market.slots_exhausted' },
    });
  });

  /**
   * An svc-token outage must NOT read as "go and stake". A 403 would send a
   * vendor who has already staked off to stake again; a 500 says try again.
   */
  it('reports an unreadable stake gate as our failure, not the caller own', async () => {
    const down = stubVendors({
      claimSlot: vi.fn(async () => {
        throw new MarketError('Stake gate unavailable (500)', 'market.stake_unavailable');
      }),
    } as unknown as Partial<VendorService>);
    await expect(createMarketRouter(down).createCaller(signed()).claimSlot({ ref: 'l' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      cause: { code: 'market.stake_unavailable' },
    });
  });
});

describe('svc-market mount — who may vet', () => {
  it('refuses vet, listApplications and history to an ordinary user', async () => {
    const vendors = stubVendors();
    const caller = createMarketRouter(vendors).createCaller(signed());
    await expect(caller.vet({ vendorId: VENDOR, decision: 'approved', reason: 'fine' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.listApplications()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.history({ vendorId: VENDOR })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(vendors.vet).not.toHaveBeenCalled();
    expect(vendors.listApplications).not.toHaveBeenCalled();
    expect(vendors.history).not.toHaveBeenCalled();
  });

  it('refuses an applicant vetting their own application', async () => {
    const vendors = stubVendors();
    const selfVetter = principal({ scopes: ['market:read', 'market:write'] });
    await expect(
      createMarketRouter(vendors).createCaller(signed(selfVetter)).vet({ vendorId: VENDOR, decision: 'approved', reason: 'me' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(vendors.vet).not.toHaveBeenCalled();
  });

  it('lets an operator vet, and records the operator rather than the body', async () => {
    const vendors = stubVendors();
    const operator = principal({ userId: OP, sub: OP, scopes: ['market:ops'], tier: 'none', mfa: true });
    const result = await createMarketRouter(vendors, undefined, undefined, stubApprovalConsumer(CONFIRM))
      .createCaller(signed(operator))
      .vet({
        vendorId: VENDOR,
        decision: 'approved',
        reason: 'documents check out',
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      });
    expect(result.vendor.status).toBe('approved');
    expect(result.confirmOperatorId).toBe(CONFIRM);
    expect(vendors.vet).toHaveBeenCalledWith({
      vendorId: VENDOR,
      decision: 'approved',
      reason: 'documents check out',
      actorId: OP,
      actorScope: 'market:ops',
    });
  });

  it('refuses vet without MFA even when market:ops is held', async () => {
    const vendors = stubVendors();
    const operator = principal({ userId: OP, sub: OP, scopes: ['market:ops'], mfa: false });
    await expect(
      createMarketRouter(vendors, undefined, undefined, stubApprovalConsumer(CONFIRM))
        .createCaller(signed(operator))
        .vet({
          vendorId: VENDOR,
          decision: 'approved',
          reason: 'documents check out',
          confirmOperatorId: CONFIRM,
          ...APPROVAL,
        }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(vendors.vet).not.toHaveBeenCalled();
  });

  it('refuses vet without approval ids — a typed-in second name is not approval', async () => {
    const vendors = stubVendors();
    const operator = principal({ userId: OP, sub: OP, scopes: ['market:ops'], mfa: true });
    const caller = createMarketRouter(vendors, undefined, undefined, stubApprovalConsumer(CONFIRM)).createCaller(signed(operator));
    await expect(caller.vet({ vendorId: VENDOR, decision: 'approved', reason: 'documents check out' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: /typed-in second name is not approval/,
    });
    await expect(
      caller.vet({
        vendorId: VENDOR,
        decision: 'approved',
        reason: 'documents check out',
        confirmOperatorId: CONFIRM,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(
      caller.vet({
        vendorId: VENDOR,
        decision: 'approved',
        reason: 'documents check out',
        confirmOperatorId: CONFIRM,
        approvalId: '',
        operationId: '',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(vendors.vet).not.toHaveBeenCalled();
  });

  it('echoes confirmOperatorId from consumed.approverId, not the typed-in name', async () => {
    const vendors = stubVendors();
    const operator = principal({ userId: OP, sub: OP, scopes: ['market:ops'], mfa: true });
    const result = await createMarketRouter(vendors, undefined, undefined, stubApprovalConsumer(CONFIRM))
      .createCaller(signed(operator))
      .vet({
        vendorId: VENDOR,
        decision: 'approved',
        reason: 'documents check out',
        confirmOperatorId: OP,
        ...APPROVAL,
      });
    expect(result.confirmOperatorId).toBe(CONFIRM);
  });

  /**
   * An operator's authority comes from `market:ops`, not from their own
   * verification tier — a desk operator at tier `none` must still be able to work
   * the queue. This is why the operator procedures carry no `{ module }` guard.
   */
  it('does not gate the operator queue on the operator own verification tier', async () => {
    const vendors = stubVendors();
    const operator = principal({ userId: OP, sub: OP, scopes: ['market:ops'], tier: 'none' });
    await expect(createMarketRouter(vendors).createCaller(signed(operator)).listApplications({ limit: 50 })).resolves.toEqual([]);
    // Defaults to the undecided queue rather than every vendor ever.
    expect(vendors.listApplications).toHaveBeenCalledWith({ status: 'applied', limit: 50 });
  });

  it('listApplications omit is PRECONDITION_FAILED — never invents a 50-application page', async () => {
    const vendors = stubVendors({
      listApplications: async (opts?: { status?: string; limit?: number }) => {
        assertApplicationsListLimit(opts?.limit);
        return [];
      },
    } as unknown as Partial<VendorService>);
    const operator = principal({ userId: OP, sub: OP, scopes: ['market:ops'] });
    const caller = createMarketRouter(vendors).createCaller(signed(operator));
    await expect(caller.listApplications()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'market.applications_list_limit_unset',
    });
    await expect(caller.listApplications({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'market.applications_list_limit_unset',
    });
    await expect(caller.listApplications({ limit: 50 })).resolves.toEqual([]);
  });

  it('history omit is PRECONDITION_FAILED — never invents a 50-event window', async () => {
    const vendors = stubVendors({
      history: async (vendorId: string, limit?: number) => {
        assertHistoryLimit(limit);
        return [];
      },
    } as unknown as Partial<VendorService>);
    const operator = principal({ userId: OP, sub: OP, scopes: ['market:ops'] });
    const caller = createMarketRouter(vendors).createCaller(signed(operator));
    await expect(caller.history({ vendorId: VENDOR })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'market.history_limit_unset',
    });
    await expect(caller.history({ vendorId: VENDOR, limit: 50 })).resolves.toEqual([]);
  });

  it('refuses a vetting decision with a blank reason at the boundary', async () => {
    const vendors = stubVendors();
    const operator = principal({ userId: OP, sub: OP, scopes: ['market:ops'], mfa: true });
    await expect(
      createMarketRouter(vendors)
        .createCaller(signed(operator))
        .vet({ vendorId: VENDOR, decision: 'rejected', reason: '', confirmOperatorId: CONFIRM, ...APPROVAL }),
    ).rejects.toThrow();
    expect(vendors.vet).not.toHaveBeenCalled();
  });
});

/**
 * STAGE 3 — THE PUBLIC HALF.
 *
 * Every other suite in this file asserts that something is REFUSED. These assert
 * the opposite and it is just as load-bearing: a marketplace nobody can look at
 * without an account is not a marketplace, and `publicProcedure` is only public
 * if an anonymous context genuinely reaches the resolver.
 */
describe('svc-market mount — the public marketplace', () => {
  it('serves a listed vendor profile to a caller with no token at all', async () => {
    const vendors = stubVendors();
    await expect(createMarketRouter(vendors).createCaller(anonymous()).profile({ vendorId: VENDOR })).resolves.toEqual(publicRow);
    expect(vendors.publicProfile).toHaveBeenCalledWith(VENDOR);
  });

  it('serves the directory to a caller with no token at all', async () => {
    const vendors = stubVendors();
    await expect(createMarketRouter(vendors).createCaller(anonymous()).listed()).resolves.toEqual([publicRow]);
    expect(vendors.listedVendors).toHaveBeenCalledWith({ limit: undefined });
  });

  /**
   * The output schema is the disclosure gate. A field the service starts
   * returning — a userId, a status, a tier — is stripped here rather than
   * shipped, and this test is what proves the schema is doing that job rather
   * than passing everything through.
   */
  it('strips anything the service returns beyond the four public fields', async () => {
    const leaky = stubVendors({
      publicProfile: vi.fn(async () => ({ ...publicRow, userId: USER, status: 'approved', tier: 'Sovereign' })),
    } as unknown as Partial<VendorService>);
    const profile = await createMarketRouter(leaky).createCaller(anonymous()).profile({ vendorId: VENDOR });
    expect(Object.keys(profile).sort()).toEqual(['createdAt', 'description', 'displayName', 'id']);
  });

  /**
   * ONE 404 FOR EVERY REASON. Suspended, rejected, unstaked, holds no slot, never
   * existed — the caller cannot tell which, so this endpoint cannot be used to
   * enumerate who an operator threw off the marketplace.
   */
  it('answers NOT_FOUND for a vendor who is not listed, whatever the reason', async () => {
    const hidden = stubVendors({ publicProfile: vi.fn(async () => null) } as unknown as Partial<VendorService>);
    await expect(createMarketRouter(hidden).createCaller(anonymous()).profile({ vendorId: VENDOR })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  /**
   * An unreadable stake source is OUR failure and stays distinguishable from
   * "no such vendor". A 404 here would assert a vendor does not exist because
   * svc-token was down, and that answer is exactly the sort a client caches.
   */
  it('reports an unreadable stake gate as a 500, not as a missing vendor', async () => {
    const down = stubVendors({
      publicProfile: vi.fn(async () => {
        throw new MarketError('Stake gate unavailable (500)', 'market.stake_unavailable');
      }),
    } as unknown as Partial<VendorService>);
    await expect(createMarketRouter(down).createCaller(anonymous()).profile({ vendorId: VENDOR })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      cause: { code: 'market.stake_unavailable' },
    });
  });

  it('caps how much of the directory one request can ask for', async () => {
    const vendors = stubVendors();
    await expect(createMarketRouter(vendors).createCaller(anonymous()).listed({ limit: 5_000 })).rejects.toThrow();
    expect(vendors.listedVendors).not.toHaveBeenCalled();
  });

  it('listed omit is PRECONDITION_FAILED — never invents a 20-vendor page', async () => {
    const vendors = stubVendors({
      listedVendors: async (opts?: { limit?: number }) => {
        assertListedVendorsListLimit(opts?.limit);
        return [publicRow];
      },
    } as unknown as Partial<VendorService>);
    const caller = createMarketRouter(vendors).createCaller(anonymous());
    await expect(caller.listed()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'market.listed_vendors_list_limit_unset',
    });
    await expect(caller.listed({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'market.listed_vendors_list_limit_unset',
    });
    await expect(caller.listed({ limit: 20 })).resolves.toEqual([publicRow]);
  });
});

/**
 * market.commerce mount — scopes, not money shape.
 * Money path lives in commerce.test.ts (Postgres). Here: write needs market:write,
 * and the service is never called when the guard refuses.
 */
describe('svc-market mount — commerce scopes', () => {
  const listingId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const purchaseId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const listingRow = {
    id: listingId,
    vendorId: VENDOR,
    title: 'Bot',
    description: 'A bot',
    offerType: 'one_time' as const,
    assetId: 'USDT',
    price: '10',
    periodSeconds: null,
    status: 'active' as const,
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  };

  function stubCommerce(opts?: { commissionBps: number | null }) {
    const commissionBps = opts?.commissionBps === undefined ? 500 : opts.commissionBps;
    return {
      programme: vi.fn(() => ({
        commissionBps,
        commissionConfigured: commissionBps !== null,
        purchaseHold: false,
        refundWindowSeconds: null,
      })),
      createListing: vi.fn(async () => listingRow),
      archiveListing: vi.fn(async () => ({ ...listingRow, status: 'archived' as const })),
      myListings: vi.fn(async (_userId: string, _opts?: { limit?: number }) => [listingRow]),
      publicListings: vi.fn(async () => [listingRow]),
      purchase: vi.fn(async () => ({
        id: purchaseId,
        listingId,
        buyerId: USER,
        vendorId: VENDOR,
        vendorUserId: USER,
        assetId: 'USDT',
        price: '10',
        commissionBps: 500,
        status: 'settled' as const,
        ledgerTxId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        rejectionCode: null,
        createdAt: '2026-08-09T00:00:00.000Z',
        settledAt: '2026-08-09T00:00:00.000Z',
        accessUntil: null,
        periodSeconds: null,
        flow: 'pay' as const,
        refundWindowSeconds: null,
        holdPostedAt: null,
        refundWindowEndsAt: null,
        refundRequestedAt: null,
        outcome: null,
        outcomeTxId: null,
        outcomeAt: null,
      })),
      purchasesOf: vi.fn(async (_buyerId: string, _opts?: { limit?: number }): Promise<never[]> => []),
      cancelSubscription: vi.fn(),
      subscriptionAccess: vi.fn(),
      opsSales: vi.fn(),
      takedownListing: vi.fn(),
      myEarnings: vi.fn(),
    };
  }

  it('refuses createListing without market:write and never calls commerce', async () => {
    const commerce = stubCommerce();
    const reader = principal({ scopes: ['market:read'] });
    await expect(
      createMarketRouter(stubVendors(), commerce as never)
        .createCaller(signed(reader))
        .createListing({ title: 'Bot', description: 'A bot', offerType: 'one_time', assetId: 'USDT', price: '10' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(commerce.createListing).not.toHaveBeenCalled();
  });

  it('accepts createListing with market:write against the principal', async () => {
    const commerce = stubCommerce();
    const result = await createMarketRouter(stubVendors(), commerce as never)
      .createCaller(signed())
      .createListing({ title: 'Bot', description: 'A bot', offerType: 'one_time', assetId: 'USDT', price: '10' });
    expect(result.id).toBe(listingId);
    expect(commerce.createListing).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, title: 'Bot', price: '10' }));
  });

  it('refuses purchase without market:write', async () => {
    const commerce = stubCommerce();
    const reader = principal({ scopes: ['market:read'] });
    await expect(
      createMarketRouter(stubVendors(), commerce as never)
        .createCaller(signed(reader))
        .purchase({ listingId, purchaseId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(commerce.purchase).not.toHaveBeenCalled();
  });

  it('maps a mismatching payment receipt to a typed conflict', async () => {
    const commerce = stubCommerce();
    commerce.purchase = vi.fn(async () => {
      throw new MarketError('Receipt mismatch', 'market.purchase_receipt_mismatch');
    });
    await expect(
      createMarketRouter(stubVendors(), commerce as never)
        .createCaller(signed())
        .purchase({ listingId, purchaseId }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'market.purchase_receipt_mismatch',
      cause: { code: 'market.purchase_receipt_mismatch' },
    });
  });

  it('serves public listings anonymously', async () => {
    const commerce = stubCommerce();
    await expect(
      createMarketRouter(stubVendors(), commerce as never)
        .createCaller(anonymous())
        .listings({ limit: 50 }),
    ).resolves.toEqual([listingRow]);
    expect(commerce.publicListings).toHaveBeenCalled();
  });

  it('reports blank commission config on the public programme', async () => {
    const commerce = stubCommerce({ commissionBps: null });
    await expect(
      createMarketRouter(stubVendors(), commerce as never)
        .createCaller(anonymous())
        .commerceProgramme(),
    ).resolves.toEqual({ commissionBps: null, commissionConfigured: false, purchaseHold: false, refundWindowSeconds: null });
  });

  /**
   * D26-P1-M1 Class M honesty — public doors, not unit-only.
   * Blank commission must surface as PRECONDITION_FAILED on create + purchase
   * and empty catalogue; never invent success / free rate at the mount.
   */
  it('maps unset-period createListing refuse to PRECONDITION_FAILED', async () => {
    const commerce = stubCommerce();
    commerce.createListing = vi.fn(async () => {
      throw new MarketError(
        'Subscription listings need a period in whole seconds — no default cadence is invented',
        'market.subscription_period_unset',
      );
    });
    await expect(
      createMarketRouter(stubVendors(), commerce as never)
        .createCaller(signed())
        .createListing({ title: 'Sub', description: 'monthly', offerType: 'subscription', assetId: 'USDT', price: '10' }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'market.subscription_period_unset',
    });
  });

  it('createStrategyListing writes through createListing as a subscription with periodSeconds', async () => {
    const commerce = stubCommerce();
    const result = await createMarketRouter(stubVendors(), commerce as never)
      .createCaller(signed())
      .createStrategyListing({
        title: 'Mean revert',
        description: 'A listed strategy',
        assetId: 'USDT',
        price: '12.50',
        periodSeconds: 86_400,
      });
    expect(result.id).toBe(listingId);
    expect(commerce.createListing).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        offerType: 'subscription',
        periodSeconds: 86_400,
        price: '12.50',
      }),
    );
  });

  it('refuses createStrategyListing without market:write', async () => {
    const commerce = stubCommerce();
    const reader = principal({ scopes: ['market:read'] });
    await expect(
      createMarketRouter(stubVendors(), commerce as never)
        .createCaller(signed(reader))
        .createStrategyListing({
          title: 'Mean revert',
          description: 'A listed strategy',
          assetId: 'USDT',
          price: '12.50',
          periodSeconds: 86_400,
        }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(commerce.createListing).not.toHaveBeenCalled();
  });

  it('maps unstaked createStrategyListing to FORBIDDEN market.stake_required', async () => {
    const commerce = stubCommerce();
    commerce.createListing = vi.fn(async () => {
      throw new MarketError('Stake is required to hold a listing slot', 'market.stake_required');
    });
    await expect(
      createMarketRouter(stubVendors(), commerce as never)
        .createCaller(signed())
        .createStrategyListing({
          title: 'Mean revert',
          description: 'A listed strategy',
          assetId: 'USDT',
          price: '12.50',
          periodSeconds: 86_400,
        }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'market.stake_required',
    });
  });

  it('rejects a profit-share field on createStrategyListing (strict input)', async () => {
    const commerce = stubCommerce();
    await expect(
      createMarketRouter(stubVendors(), commerce as never)
        .createCaller(signed())
        .createStrategyListing({
          title: 'Mean revert',
          description: 'A listed strategy',
          assetId: 'USDT',
          price: '12.50',
          periodSeconds: 86_400,
          profitShareBps: 200,
        } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(commerce.createListing).not.toHaveBeenCalled();
  });

  it('maps blank-commission createListing refuse to PRECONDITION_FAILED', async () => {
    const commerce = stubCommerce({ commissionBps: null });
    commerce.createListing = vi.fn(async () => {
      throw new MarketError('House commission rate is not configured', 'market.commission_not_configured');
    });
    await expect(
      createMarketRouter(stubVendors(), commerce as never)
        .createCaller(signed())
        .createListing({ title: 'Bot', description: 'A bot', offerType: 'one_time', assetId: 'USDT', price: '10' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'market.commission_not_configured' });
  });

  it('maps blank-commission purchase refuse to PRECONDITION_FAILED', async () => {
    const commerce = stubCommerce({ commissionBps: null });
    commerce.purchase = vi.fn(async () => {
      throw new MarketError('House commission rate is not configured', 'market.commission_not_configured');
    });
    await expect(
      createMarketRouter(stubVendors(), commerce as never)
        .createCaller(signed())
        .purchase({ listingId, purchaseId }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(commerce.purchase).toHaveBeenCalled();
  });

  it('serves empty public catalogue when commerce returns [] for blank commission', async () => {
    const commerce = stubCommerce({ commissionBps: null });
    commerce.publicListings = vi.fn(async () => []);
    await expect(
      createMarketRouter(stubVendors(), commerce as never)
        .createCaller(anonymous())
        .listings({ limit: 50 }),
    ).resolves.toEqual([]);
  });

  it('listings omit is PRECONDITION_FAILED — never invents a 50-listing page', async () => {
    const commerce = stubCommerce();
    commerce.publicListings = vi.fn(async (opts?: { limit?: number }) => {
      assertPublicListingsListLimit(opts?.limit);
      return [listingRow];
    });
    const caller = createMarketRouter(stubVendors(), commerce as never).createCaller(anonymous());
    await expect(caller.listings()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'market.public_listings_list_limit_unset',
    });
    await expect(caller.listings({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'market.public_listings_list_limit_unset',
    });
    await expect(caller.listings({ limit: 50 })).resolves.toEqual([listingRow]);
  });

  it('myListings omit is PRECONDITION_FAILED — never invents a 50-listing page', async () => {
    const commerce = stubCommerce();
    commerce.myListings = vi.fn(async (_userId: string, opts?: { limit?: number }) => {
      assertMyListingsListLimit(opts?.limit);
      return [listingRow];
    });
    const caller = createMarketRouter(stubVendors(), commerce as never).createCaller(signed());
    await expect(caller.myListings()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'market.my_listings_list_limit_unset',
    });
    await expect(caller.myListings({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'market.my_listings_list_limit_unset',
    });
    await expect(caller.myListings({ limit: 50 })).resolves.toEqual([listingRow]);
  });

  it('myPurchases omit is PRECONDITION_FAILED — never invents a 50-purchase page', async () => {
    const commerce = stubCommerce();
    commerce.purchasesOf = vi.fn(async (_buyerId: string, opts?: { limit?: number }) => {
      assertMyPurchasesListLimit(opts?.limit);
      return [];
    });
    const caller = createMarketRouter(stubVendors(), commerce as never).createCaller(signed());
    await expect(caller.myPurchases()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'market.my_purchases_list_limit_unset',
    });
    await expect(caller.myPurchases({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'market.my_purchases_list_limit_unset',
    });
    await expect(caller.myPurchases({ limit: 50 })).resolves.toEqual([]);
  });

  /**
   * D26-P1-M1 — recurring subscribe is a mounted public door, not a missing
   * route. Always named-refuses; never invents a charge or a second book.
   */
  it('exposes subscribe as a callable public procedure', () => {
    const caller = createMarketRouter(stubVendors(), stubCommerce() as never).createCaller(anonymous());
    expect(typeof caller.subscribe).toBe('function');
  });

  it('maps public subscribe refuse to PRECONDITION_FAILED without calling purchase', async () => {
    const commerce = stubCommerce();
    await expect(
      createMarketRouter(stubVendors(), commerce as never)
        .createCaller(anonymous())
        .subscribe({ listingId }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'market.subscription_recurring_not_built',
      cause: { code: 'market.subscription_recurring_not_built' },
    });
    expect(commerce.purchase).not.toHaveBeenCalled();
    expect(commerce.createListing).not.toHaveBeenCalled();
  });

  it('subscribe still named-refuses for a signed writer (not a one-time purchase)', async () => {
    const commerce = stubCommerce();
    await expect(
      createMarketRouter(stubVendors(), commerce as never)
        .createCaller(signed())
        .subscribe(),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'market.subscription_recurring_not_built',
    });
    expect(commerce.purchase).not.toHaveBeenCalled();
  });

  it('maps public recurring alias to the same named refuse', async () => {
    const commerce = stubCommerce();
    await expect(
      createMarketRouter(stubVendors(), commerce as never)
        .createCaller(anonymous())
        .recurring({ listingId }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'market.subscription_recurring_not_built',
      cause: { code: 'market.subscription_recurring_not_built' },
    });
    expect(commerce.purchase).not.toHaveBeenCalled();
  });

  it('maps commerce refuse codes to stable tRPC classes', async () => {
    const cases: Array<{ code: string; trpc: string }> = [
      { code: 'market.commission_not_configured', trpc: 'PRECONDITION_FAILED' },
      { code: 'market.subscription_period_unset', trpc: 'PRECONDITION_FAILED' },
      { code: 'market.subscription_past_due', trpc: 'PRECONDITION_FAILED' },
      { code: 'market.subscription_cancelled', trpc: 'PRECONDITION_FAILED' },
      { code: 'market.listing_slot_missing', trpc: 'PRECONDITION_FAILED' },
      { code: 'market.listing_over_capacity', trpc: 'PRECONDITION_FAILED' },
      { code: 'market.insufficient_funds', trpc: 'PRECONDITION_FAILED' },
      { code: 'market.purchase_self', trpc: 'CONFLICT' },
      { code: 'market.purchase_conflict', trpc: 'CONFLICT' },
      { code: 'market.listing_not_owned', trpc: 'CONFLICT' },
      { code: 'market.listing_not_found', trpc: 'NOT_FOUND' },
    ];
    for (const c of cases) {
      const commerce = stubCommerce();
      commerce.purchase = vi.fn(async () => {
        throw new MarketError('refuse', c.code);
      });
      await expect(
        createMarketRouter(stubVendors(), commerce as never)
          .createCaller(signed())
          .purchase({ listingId, purchaseId }),
      ).rejects.toMatchObject({ code: c.trpc, message: userCopy(c.code) });
    }
  });

  /**
   * Unit card A2 — scopes + edge residual
   * Promise: write scopes edge-signed principal only; buyer/vendor never body-asserted.
   * Done bar: anonymous + read-only cannot purchase; purchase always buyerId=principal.
   */
  it('refuses anonymous purchase and never calls commerce', async () => {
    const commerce = stubCommerce();
    await expect(
      createMarketRouter(stubVendors(), commerce as never)
        .createCaller(anonymous())
        .purchase({ listingId, purchaseId }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(commerce.purchase).not.toHaveBeenCalled();
  });

  it('purchase always uses the edge principal as buyer — never a body userId', async () => {
    const commerce = stubCommerce();
    await createMarketRouter(stubVendors(), commerce as never)
      .createCaller(signed())
      .purchase({ listingId, purchaseId });
    expect(commerce.purchase).toHaveBeenCalledWith({
      buyerId: USER,
      listingId,
      purchaseId,
    });
    // Input schema has no buyerId field — hostile self-assert would be a type error at the boundary.
    expect(Object.keys({ listingId, purchaseId }).sort()).toEqual(['listingId', 'purchaseId']);
  });

  it('refuses archiveListing without market:write', async () => {
    const commerce = stubCommerce();
    const reader = principal({ scopes: ['market:read'] });
    await expect(
      createMarketRouter(stubVendors(), commerce as never)
        .createCaller(signed(reader))
        .archiveListing({ listingId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(commerce.archiveListing).not.toHaveBeenCalled();
  });

  it('refuses ops.sales to a vendor session and a buyer session', async () => {
    const commerce = stubCommerce();
    commerce.opsSales = vi.fn();
    const vendor = principal({ scopes: ['market:write'], mfa: true });
    const buyer = principal({ scopes: ['market:read'] });
    const window = { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', limit: 10 };
    await expect(
      createMarketRouter(stubVendors(), commerce as never)
        .createCaller(signed(vendor))
        .ops.sales(window),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      createMarketRouter(stubVendors(), commerce as never)
        .createCaller(signed(buyer))
        .ops.sales(window),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(commerce.opsSales).not.toHaveBeenCalled();
  });

  it('refuses takedown without MFA even when market:ops is held', async () => {
    const commerce = stubCommerce();
    commerce.takedownListing = vi.fn();
    const operator = principal({ userId: OP, sub: OP, scopes: ['market:ops'], mfa: false });
    await expect(
      createMarketRouter(stubVendors(), commerce as never)
        .createCaller(signed(operator))
        .ops.takedownListing({
          listingId,
          reason: 'this listing breaks the catalogue rules',
          approvalId: 'appr-1',
          operationId: 'op-1',
          clientRequestId: 'td-1',
        }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(commerce.takedownListing).not.toHaveBeenCalled();
  });

  it('refuses myEarnings without market:read', async () => {
    const commerce = stubCommerce();
    commerce.myEarnings = vi.fn();
    const writer = principal({ scopes: ['market:write'] });
    await expect(
      createMarketRouter(stubVendors(), commerce as never)
        .createCaller(signed(writer))
        .myEarnings({ from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(commerce.myEarnings).not.toHaveBeenCalled();
  });

  /**
   * PTX-M06-R06 / R09 — public book/quote door. L3 is named-refused, never invented.
   */
  it('refuses anonymous L3/queue/executable_l3 with market.l3_unavailable', async () => {
    const caller = createMarketRouter(stubVendors()).createCaller(anonymous());
    for (const product of ['L3', 'queue', 'executable_l3'] as const) {
      await expect(caller.marketData.book({ marketId: 'BTC-USDT', product })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'market.l3_unavailable',
        cause: { code: 'market.l3_unavailable' },
      });
    }
  });

  it('serves unserved L1/L2 with null sides — not an empty native book', async () => {
    const view = await createMarketRouter(stubVendors()).createCaller(anonymous()).marketData.book({
      marketId: 'BTC-USDT',
      product: 'L1',
    });
    expect(view.executableNative).toBe(false);
    expect(view.bids).toBeNull();
    expect(view.asks).toBeNull();
    expect(view.orders).toBeNull();
    expect(view.queue).toBeNull();
  });

  it('refuses index-as-bid-ask and implied-as-native-executable by name', async () => {
    const caller = createMarketRouter(stubVendors()).createCaller(anonymous());
    await expect(caller.marketData.quote({ kind: 'index', price: '100', asBidAsk: true })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'market.reference_not_book',
      cause: { code: 'market.reference_not_book' },
    });
    await expect(caller.marketData.quote({ kind: 'implied', price: '100', asNativeExecutable: true })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'market.not_native_executable',
      cause: { code: 'market.not_native_executable' },
    });
  });

  it('index quote is not a bid/ask', async () => {
    const q = await createMarketRouter(stubVendors()).createCaller(anonymous()).marketData.quote({ kind: 'index', price: '30100.25' });
    expect(q.executableNative).toBe(false);
    expect(q.bid).toBeNull();
    expect(q.ask).toBeNull();
    expect(q.index).toBe('30100.25');
  });

  it('refuses invalid decimal quote prices through the actual public mount', async () => {
    const caller = createMarketRouter(stubVendors()).createCaller(anonymous());
    for (const price of [' ', '0', '-1', '1e2']) {
      await expect(caller.marketData.quote({ kind: 'index', price })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
  });
});

describe('svc-market mount — live markets listing pin', () => {
  const savedPin = process.env[MARKET_LISTING_PIN_ENV];
  afterEach(() => {
    if (savedPin === undefined) delete process.env[MARKET_LISTING_PIN_ENV];
    else process.env[MARKET_LISTING_PIN_ENV] = savedPin;
  });

  it('liveMarkets and listedAssets named-refuse unpinned — not a catalogue', async () => {
    delete process.env[MARKET_LISTING_PIN_ENV];
    const caller = createMarketRouter(stubVendors()).createCaller(anonymous());
    await expect(caller.liveMarkets()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'market.listing_pin_unset',
      cause: { code: 'market.listing_pin_unset' },
    });
    await expect(caller.listedAssets()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'market.listing_pin_unset',
      cause: { code: 'market.listing_pin_unset' },
    });
  });
});

/**
 * Mounted-router contract for the shopfront array and the public review shape.
 * Real CommerceService and ReviewsService. Stubs cannot prove the output zod.
 */
describe('svc-market mount — listings array and public reviews', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrations = readdirSync(join(here, '..', 'drizzle'))
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort()
    .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

  const VENDOR_USER = '11111111-1111-4111-8111-111111111111';
  const BUYER_A = '22222222-2222-4222-8222-222222222222';
  const USER_B = '55555555-5555-4555-8555-555555555555';
  const OPERATOR = '33333333-3333-4333-8333-333333333333';

  class FixedEntitlement implements SlotEntitlementSource {
    async entitlementOf(): Promise<VendorEntitlement> {
      return { tierName: 'Operator', vendorSlots: 3 };
    }
  }

  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let commerce!: CommerceService;
  let reviews!: ReviewsService;

  beforeAll(async () => {
    const envUrl = process.env.TEST_DATABASE_URL?.trim();
    if (!envUrl) throw new Error('TEST_DATABASE_URL is required (database name must end with _test)');
    adminStop = async () => undefined;
    db = await createTestDatabase({ service: 'market', url: envUrl, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`
      TRUNCATE market.reviews, market.listing_takedowns, market.subscription_state, market.purchases,
               market.listings, market.vendor_slots, market.vendor_status_events, market.vendors
      RESTART IDENTITY CASCADE
    `;
    const vendors = new VendorService(sql, new FixedEntitlement());
    const ledger = new MemoryLedger();
    commerce = new CommerceService(sql, vendors, ledger, { commissionBps: 500 });
    reviews = new ReviewsService(sql);
    const vendor = await vendors.applyAsVendor({
      userId: VENDOR_USER,
      displayName: 'Acme Bots',
      description: 'I sell trading bots',
    });
    await vendors.vet({
      vendorId: vendor.id,
      decision: 'approved',
      reason: 'looks fine',
      actorId: OPERATOR,
      actorScope: MARKET_OPS_SCOPE,
    });
    await ledger.post(
      recipes.deposit({ userId: BUYER_A, assetId: 'USDT', amount: parseAmount('1000'), rail: 'test', railRef: 'buyer-a-mount' }),
    );
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  function mount() {
    const vendors = new VendorService(sql, new FixedEntitlement());
    return createMarketRouter(vendors, commerce, undefined, stubApprovalConsumer(CONFIRM), reviews);
  }

  it('listings is an oldest-first array', async () => {
    const later = await commerce.createListing({
      userId: VENDOR_USER,
      title: 'Later bot',
      description: 'Created first, dated later',
      offerType: 'one_time',
      assetId: 'USDT',
      price: '12',
    });
    const earlier = await commerce.createListing({
      userId: VENDOR_USER,
      title: 'Earlier bot',
      description: 'Created second, dated earlier',
      offerType: 'one_time',
      assetId: 'USDT',
      price: '8',
    });
    await sql`
      UPDATE market.listings SET created_at = '2026-06-01T00:00:00.000Z'::timestamptz WHERE id = ${later.id}
    `;
    await sql`
      UPDATE market.listings SET created_at = '2026-01-01T00:00:00.000Z'::timestamptz WHERE id = ${earlier.id}
    `;

    const caller = mount().createCaller(anonymous());
    const reply = await caller.listings({ limit: 50 });
    expect(Array.isArray(reply)).toBe(true);
    expect(z.array(listingOut).parse(reply)).toEqual(reply);
    expect(reply.map((row) => row.id)).toEqual([earlier.id, later.id]);
  });

  it('listingsPage refuses an omitted sort', async () => {
    const caller = mount().createCaller(anonymous());
    await expect(caller.listingsPage({ limit: 50 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'market.listings_sort_unset',
    });
  });

  it('reviews.list hides the buyer id and the purchase id from another customer', async () => {
    const listing = await commerce.createListing({
      userId: VENDOR_USER,
      title: 'Reviewed bot',
      description: 'A bot with one review',
      offerType: 'one_time',
      assetId: 'USDT',
      price: '10',
    });
    const purchase = await commerce.purchase({ buyerId: BUYER_A, listingId: listing.id, purchaseId: randomUUID() });
    const buyer = principal({ sub: BUYER_A, userId: BUYER_A, scopes: ['market:write'] });
    const other = principal({ sub: USER_B, userId: USER_B, scopes: ['market:read'] });
    const submitted = await mount()
      .createCaller(signed(buyer))
      .reviews.submit({ purchaseId: purchase.id, score: 5, text: 'Useful', clientRequestId: 'rv-mount-a' });
    expect(submitted.buyerId).toBe(BUYER_A);
    expect(submitted.purchaseId).toBe(purchase.id);

    const listed = await mount().createCaller(signed(other)).reviews.list({ listingId: listing.id, limit: 10 });
    for (const item of listed.reviews) {
      expect(Object.keys(item)).not.toContain('buyerId');
      expect(Object.keys(item)).not.toContain('purchaseId');
    }
    expect(JSON.stringify(listed)).not.toContain(BUYER_A);
    expect(JSON.stringify(listed)).not.toContain(purchase.id);
    expect(z.array(reviewPublicOut).parse(listed.reviews)).toEqual(listed.reviews);
  });
});
