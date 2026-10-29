import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeEach } from 'vitest';
import { SESSION_SCOPES, issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createIdentityRouter } from './router.js';
import { requestIpAls } from './auth/auth-service-ip.js';
import { identityActionPayloadHash, stubActionApprovals } from './auth/privileged-dual-control.js';
import { AuthError, type AuthService, type KycRecordView } from './auth/auth-service.js';
import { userCopy } from './user-copy.js';
import type { RankService } from './rank/rank-service.js';
import type { FreezeService } from './affiliates/freeze-service.js';
import { MemoryAccrualStore } from './affiliates/accrual-store.js';
import type { CommissionRow } from './affiliates/commission.js';
import { MemoryLedger, formatAmount, houseFees, parseAmount, recipes, rewardsEngine, userAvailable } from '@intafaced/ledger-client';
import { MemoryKycDocumentStore } from './kyc/document-store.js';
import type { BindProviderRefInput, BindProviderRefResult, DocumentReview } from './kyc/provider-ref-bind.js';
import { MemoryWaitlistStore } from './waitlist/waitlist-store.js';
import { WaitlistService } from './waitlist/waitlist-service.js';
import { MemoryShareStore } from './affiliates/share-service.js';
import { ReferralError } from './affiliates/referral-tree.js';
import { KycCaseError, parseKycRejectReasons } from './kyc/cases.js';
import { KycCapabilityError } from './kyc/capabilities.js';
import { KycAttemptsError } from './kyc/attempts.js';
import { KycProfileError, type KycProfileDesk } from './kyc/profile.js';
import { KycPoaError, type KycPoaDesk } from './kyc/proof-of-address.js';
import { KycSelfieError, type KycSelfieDesk } from './kyc/selfie.js';

/**
 * The tRPC boundary for KYC and step-up.
 *
 * No database: the service is a stub, because what this file is about is
 * AUTHORITY, not the KYC state machine (`identity.test.ts` owns that against
 * real Postgres). The question here is the one the audit answered wrongly for
 * every account on the platform:
 *
 *   · `approveKyc` was reachable from nowhere, so nobody could ever be verified.
 *   · Now that it IS reachable, who is allowed to reach it?
 *
 * Approving a record grants access to every custodial module in the OS. A test
 * that only proves the happy path proves the more dangerous half is unguarded.
 */

const authConfig = {
  secret: 'an-identity-router-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const USER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '22222222-2222-4222-8222-222222222222';
const RECORD = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const CONFIRM_KYC = '66666666-6666-4666-8666-666666666666';
const kycDual = { approvalId: 'appr-1', operationId: 'op-1' };
const capabilitiesRead = {
  mapped: true,
  capabilities: (['custody_crypto', 'custody_fiat', 'transfer_crypto', 'transfer_fiat', 'trade_crypto'] as const).map((capability) => ({
    capability,
    state: 'unrequested' as const,
    grantedAt: null,
    reasonCode: null,
    reasonText: null,
    changedAt: null,
  })),
};

async function ctx(
  scopes: string[],
  opts: { mfa?: boolean; userId?: string; region?: string; service?: string | null; apiKeyId?: string; stepUpScopes?: string[] } = {},
): Promise<Context> {
  const region = opts.region ?? 'DE';
  if (scopes.length === 0) {
    return { principal: null, service: opts.service ?? null, region, requestId: 'req-1' };
  }

  const { token } = await issueAccessToken(
    {
      userId: opts.userId ?? USER,
      sessionId: SESSION,
      scopes,
      tier: 'none',
      mfa: opts.mfa ?? true,
      ...(opts.apiKeyId ? { apiKeyId: opts.apiKeyId } : {}),
      ...(opts.stepUpScopes ? { stepUpScopes: opts.stepUpScopes } : {}),
    },
    authConfig,
  );
  return {
    principal: await verifyAccessToken(token, authConfig),
    service: opts.service ?? null,
    region,
    requestId: 'req-1',
  };
}

// ── The stub ─────────────────────────────────────────────────────────────────

function kycRecord(overrides: Partial<KycRecordView> = {}): KycRecordView {
  return {
    id: RECORD,
    userId: USER,
    tier: 'basic',
    jurisdiction: 'DE',
    providerRef: 'provider-pointer-that-must-not-leak',
    status: 'pending',
    reviewedBy: null,
    reviewedAt: null,
    expiresAt: null,
    createdAt: new Date('2026-07-27T12:00:00.000Z'),
    ...overrides,
  };
}

interface Stub {
  auth: AuthService;
  rank: RankService;
  calls: Array<{ method: string; args: unknown[] }>;
  fail(err: unknown): void;
}

function stubServices(): Stub {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let nextError: unknown = null;

  const record = <T>(method: string, result: (...args: never[]) => T) =>
    ((...args: never[]) => {
      calls.push({ method, args });
      if (nextError) {
        const err = nextError;
        nextError = null;
        return Promise.reject(err);
      }
      return Promise.resolve(result(...args));
    }) as never;

  const auth = {
    submitKyc: record('submitKyc', () => kycRecord()),
    listKycRecords: record('listKycRecords', () => [kycRecord()]),
    listPendingKyc: record('listPendingKyc', () => [kycRecord()]),
    listKycCases: record('listKycCases', () => []),
    assertKycRejectable: record('assertKycRejectable', () => undefined),
    listKycCapabilities: record('listKycCapabilities', () => capabilitiesRead),
    kycAttempts: record('kycAttempts', () => ({ limit: null, denialsInWindow: null, lockedUntil: null })),
    assertKycCapabilityDeactivatable: record('assertKycCapabilityDeactivatable', () => undefined),
    deactivateKycCapability: record('deactivateKycCapability', () => capabilitiesRead),
    getKycRecord: record('getKycRecord', () => kycRecord()),
    kycTier: record('kycTier', () => 'none' as const),
    approveKycRecord: record('approveKycRecord', () =>
      kycRecord({ status: 'approved', reviewedBy: OPERATOR, reviewedAt: new Date('2026-07-28T09:00:00.000Z') }),
    ),
    rejectKycRecord: record('rejectKycRecord', () => kycRecord({ status: 'rejected', reviewedBy: OPERATOR })),
    stepUp: record('stepUp', () => ({
      accessToken: 'elevated.token.value',
      expiresAt: new Date('2026-07-28T09:05:00.000Z'),
      scopes: ['trade:withdraw'],
    })),
    stepUpPay: record('stepUpPay', () => ({
      accessToken: 'pay.step.token',
      expiresAt: new Date('2026-07-28T09:10:00.000Z'),
      scopes: ['identity:read', 'pay:refund'],
      refreshable: false as const,
    })),
    startWebauthnStepUp: record('startWebauthnStepUp', () => ({
      challenge: 'chal-stepup',
      timeout: 60000,
      rpId: 'localhost',
      allowCredentials: [{ type: 'public-key' as const, id: 'cred-1' }],
      userVerification: 'preferred' as const,
    })),
    withApiKeyAction: (input: { proof?: unknown }, run: (scope: unknown) => Promise<unknown>) => {
      if (!input.proof) return Promise.reject(new AuthError('A fresh confirmation is required. Confirm again.', 'auth.step_up_required'));
      return run({
        tx: {},
        createApiKey: (i: unknown) => (auth.createApiKey as (x: unknown) => unknown)(i),
        revokeApiKey: async () => true,
      });
    },
    createApiKey: record('createApiKey', () => ({ id: 'key-1', key: 'ifc_secret', prefix: 'ifc_abc', mode: 'live' as const })),
    exchangeApiKey: record('exchangeApiKey', () => ({
      accessToken: 'api.key.jwt',
      expiresAt: new Date('2026-07-28T09:15:00.000Z'),
      userId: USER,
      keyId: '55555555-5555-4555-8555-555555555555',
      scopes: ['trade:read'],
      mode: 'live' as const,
    })),
    verifyApiKey: record('verifyApiKey', () => ({
      userId: USER,
      scopes: ['trade:read'],
      keyId: '55555555-5555-4555-8555-555555555555',
      mode: 'live' as const,
    })),
    startWebauthnRegistration: record('startWebauthnRegistration', () => ({
      challenge: 'chal-reg',
      rp: { name: 'INTAFACED', id: 'localhost' },
      user: { id: 'dXNlcg', name: 'u@example.com', displayName: 'user' },
      pubKeyCredParams: [{ type: 'public-key' as const, alg: -7 }],
      timeout: 60_000,
      excludeCredentials: [],
      authenticatorSelection: {
        residentKey: 'preferred' as const,
        userVerification: 'required' as const,
        requireResidentKey: false as const,
      },
      attestation: 'none' as const,
    })),
    confirmWebauthnRegistration: record('confirmWebauthnRegistration', () => ({ credentialId: 'cred-1' })),
    startWebauthnAuthentication: record('startWebauthnAuthentication', () => ({
      challenge: 'chal-auth',
      timeout: 60_000,
      rpId: 'localhost',
      allowCredentials: [{ type: 'public-key' as const, id: 'cred-1' }],
      userVerification: 'required' as const,
    })),
    confirmWebauthnAuthentication: record('confirmWebauthnAuthentication', () => ({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: new Date('2026-07-28T09:15:00.000Z'),
      sessionId: SESSION,
      userId: USER,
      mfaRequired: false,
    })),
    listWebauthnCredentials: record('listWebauthnCredentials', () => [{ credentialId: 'cred-1', createdAt: '2026-07-28T09:00:00.000Z' }]),
    register: record('register', () => ({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: new Date('2026-07-28T09:15:00.000Z'),
      sessionId: SESSION,
      userId: USER,
      mfaRequired: false,
    })),
  } as unknown as AuthService;

  const rank = {
    awardXp: record('awardXp', () => ({
      snapshot: { rank: 1, xp: 100n },
      applied: true,
      rankChanged: false,
    })),
    perks: record('perks', () => ({ rank: 1, feeDiscountBps: 0, p2pLimitMultiplier: 1 })),
  } as unknown as RankService;

  return {
    auth,
    rank,
    calls,
    fail: (err) => {
      nextError = err;
    },
  };
}

/** TEST reject reasons: the owner's list is NO DEFAULT, so the router is given one. */
const KYC_REASONS = parseKycRejectReasons(
  JSON.stringify([{ code: 'document_unreadable', reason: 'TEST reason', guidance: 'TEST guidance' }]),
);

let stub: Stub;
let router: ReturnType<typeof createIdentityRouter>;

beforeEach(() => {
  stub = stubServices();
  router = createIdentityRouter(stub.auth, stub.rank, {
    registrationOpen: true,
    actionApprovals: stubActionApprovals(CONFIRM_KYC),
    kycRejectReasons: KYC_REASONS,
  });
});

const caller = async (scopes: string[], opts?: Parameters<typeof ctx>[1]) => router.createCaller(await ctx(scopes, opts));
const codeOf = (err: unknown) => (err as { code?: string }).code;

// ── rank.awardXp is service-only (full audit L2-2) ───────────────────────────

describe('rank.awardXp refuses user sessions, including defaultScopes()', () => {
  const award = {
    userId: USER,
    sourceModule: 'svc-p2p',
    action: 'trade.completed.seller',
    xpDelta: 50,
    idempotencyKey: 'idem-award-1-long-enough',
  };

  it('refuses a session that only holds identity:write', async () => {
    const api = await caller(['identity:write']);
    const err = await api.rank.awardXp(award).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('UNAUTHORIZED');
    expect(stub.calls.filter((c) => c.method === 'awardXp')).toHaveLength(0);
  });

  it('refuses the full default session scope list', async () => {
    const sessionScopes = [...SESSION_SCOPES];
    const api = await caller(sessionScopes);
    const err = await api.rank.awardXp(award).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('UNAUTHORIZED');
    expect(stub.calls.filter((c) => c.method === 'awardXp')).toHaveLength(0);
  });

  it('accepts a service caller with no user principal', async () => {
    const api = router.createCaller({
      principal: null,
      service: 'svc-p2p',
      region: 'DE',
      requestId: 'req-svc-1',
    });
    await expect(api.rank.awardXp(award)).resolves.toMatchObject({ applied: true, rank: 1 });
    expect(stub.calls.filter((c) => c.method === 'awardXp')).toHaveLength(1);
  });
});

// ── Who may grant trading access ─────────────────────────────────────────────

describe('kyc.approve is the operator action that grants custodial access', () => {
  it('serves an operator holding admin:compliance with a second factor', async () => {
    const api = await caller(['admin:compliance'], { userId: OPERATOR });
    await expect(api.kyc.approve({ recordId: RECORD, ...kycDual })).resolves.toMatchObject({ id: RECORD, status: 'approved' });
  });

  it('REFUSES A NORMAL USER SESSION — every scope a session actually carries', async () => {
    // Read from SESSION_SCOPES rather than copied from it. A hand-kept copy
    // tests the list as it was on the day someone typed it out; this tests the
    // list as it is. If approving ever becomes reachable from one of these, a
    // user can verify themselves — including from a scope added next year.
    const sessionScopes = [...SESSION_SCOPES];

    const api = await caller(sessionScopes);
    const err = await api.kyc.approve({ recordId: RECORD }).catch((e: unknown) => e);

    expect(codeOf(err)).toBe('FORBIDDEN');
    expect((err as Error).message).toContain('admin:compliance');
    expect(stub.calls.filter((c) => c.method === 'approveKycRecord')).toHaveLength(0);
  });

  it('refuses an anonymous caller', async () => {
    const api = await caller([]);
    await expect(api.kyc.approve({ recordId: RECORD })).rejects.toThrow(/Authentication required/);
  });

  it('does not accept a neighbouring operator scope', async () => {
    for (const scope of ['admin:read', 'admin:write', 'admin:treasury']) {
      const api = await caller([scope], { userId: OPERATOR });
      const err = await api.kyc.approve({ recordId: RECORD }).catch((e: unknown) => e);
      expect(codeOf(err)).toBe('FORBIDDEN');
    }
    expect(stub.calls.filter((c) => c.method === 'approveKycRecord')).toHaveLength(0);
  });

  it('REQUIRES A SECOND FACTOR, even with the right scope', async () => {
    // `admin:compliance` is interactive-only (no API key) but not in
    // `SESSION_MFA_SCOPES`, so `requireScope` does not demand mfa for a
    // session — this endpoint demands it itself. Approving a record is a
    // privilege-escalation primitive: a leaked operator credential that can
    // self-approve an account to `institutional` unlocks every custodial
    // module in the OS.
    const api = await caller(['admin:compliance'], { userId: OPERATOR, mfa: false });
    const err = await api.kyc.approve({ recordId: RECORD }).catch((e: unknown) => e);

    expect(codeOf(err)).toBe('UNAUTHORIZED');
    expect((err as Error).message).toMatch(/two-factor/i);
    expect(stub.calls.filter((c) => c.method === 'approveKycRecord')).toHaveLength(0);
  });

  it('records the CALLER as the reviewer, not anything the caller sent', async () => {
    const api = await caller(['admin:compliance'], { userId: OPERATOR });
    await api.kyc.approve({ recordId: RECORD, ...kycDual });

    const call = stub.calls.find((c) => c.method === 'approveKycRecord')!;
    expect((call.args[0] as { reviewerId: string }).reviewerId).toBe(OPERATOR);
    expect((call.args[0] as { approvalId?: string }).approvalId).toBe('appr-1');
  });

  it('REFUSES THE PERSON WHOSE KYC IT IS, before the approval is spent', async () => {
    // The record belongs to USER. An operator who is that user cannot decide it, approve or reject,
    // and neither can a second operator named as that user.
    const self = await caller(['admin:compliance'], { userId: USER });
    for (const run of [
      () => self.kyc.approve({ recordId: RECORD, ...kycDual }),
      () => self.kyc.reject({ recordId: RECORD, reasonCode: 'document_unreadable', ...kycDual }),
    ]) {
      const err = await run().catch((e: unknown) => e);
      expect(codeOf(err)).toBe('FORBIDDEN');
      expect((err as { cause?: { code?: string } }).cause?.code).toBe('auth.kyc_self_review');
    }
    const named = await caller(['admin:compliance'], { userId: OPERATOR });
    const err = await named.kyc.approve({ recordId: RECORD, ...kycDual, confirmOperatorId: USER }).catch((e: unknown) => e);
    expect((err as { cause?: { code?: string } }).cause?.code).toBe('auth.kyc_self_review');
    expect(stub.calls.filter((c) => c.method === 'approveKycRecord' || c.method === 'rejectKycRecord')).toHaveLength(0);
  });

  it('refuses a proposer or approver whose KYC it is, a typed-in variant of their id, and a missing record, all without spending the approval', async () => {
    const consumed: string[] = [];
    let parties: { requesterId: string; approverId: string | null } | null = null;
    const approvals = {
      ...stubActionApprovals(CONFIRM_KYC),
      async consume(...args: Parameters<ReturnType<typeof stubActionApprovals>['consume']>) {
        consumed.push(args[1].approvalId);
        return stubActionApprovals(CONFIRM_KYC).consume(...args);
      },
      async partiesOf() {
        return parties;
      },
    };
    const api = createIdentityRouter(stub.auth, stub.rank, { actionApprovals: approvals, kycRejectReasons: KYC_REASONS }).createCaller(
      await ctx(['admin:compliance'], { userId: OPERATOR }),
    );
    const refusals = [
      { requesterId: USER, approverId: CONFIRM_KYC },
      { requesterId: CONFIRM_KYC, approverId: ` ${USER.toUpperCase()} ` },
    ];
    for (const row of refusals) {
      parties = row;
      for (const run of [
        () => api.kyc.approve({ recordId: RECORD, ...kycDual }),
        () => api.kyc.reject({ recordId: RECORD, reasonCode: 'document_unreadable', ...kycDual }),
      ]) {
        const err = await run().catch((e: unknown) => e);
        expect((err as { cause?: { code?: string } }).cause?.code).toBe('auth.kyc_self_review');
      }
    }
    parties = null;
    const typed = await api.kyc.approve({ recordId: RECORD, ...kycDual, confirmOperatorId: USER.toUpperCase() }).catch((e: unknown) => e);
    expect((typed as { cause?: { code?: string } }).cause?.code).toBe('auth.kyc_self_review');

    stub.auth.getKycRecord = async () => null;
    const missing = await api.kyc.approve({ recordId: RECORD, ...kycDual }).catch((e: unknown) => e);
    expect(codeOf(missing)).toBe('NOT_FOUND');

    expect(consumed).toEqual([]);
    expect(stub.calls.filter((c) => c.method === 'approveKycRecord' || c.method === 'rejectKycRecord')).toHaveLength(0);
  });

  it('hands both people on the consumed approval to the decision, which refuses either being the subject', async () => {
    const api = await caller(['admin:compliance'], { userId: OPERATOR });
    await api.kyc.approve({ recordId: RECORD, ...kycDual });
    await api.kyc.reject({ recordId: RECORD, reasonCode: 'document_unreadable', ...kycDual });
    for (const method of ['approveKycRecord', 'rejectKycRecord']) {
      const call = stub.calls.find((c) => c.method === method)!;
      expect((call.args[0] as { approvalParties?: string[] }).approvalParties).toEqual(['requester', CONFIRM_KYC]);
    }
  });

  it('holds the same bar on reject', async () => {
    const unauthorised = await caller(['identity:write']);
    expect(codeOf(await unauthorised.kyc.reject({ recordId: RECORD, reasonCode: 'document_unreadable' }).catch((e: unknown) => e))).toBe(
      'FORBIDDEN',
    );

    const noMfa = await caller(['admin:compliance'], { userId: OPERATOR, mfa: false });
    expect(codeOf(await noMfa.kyc.reject({ recordId: RECORD, reasonCode: 'document_unreadable' }).catch((e: unknown) => e))).toBe(
      'UNAUTHORIZED',
    );

    const operator = await caller(['admin:compliance'], { userId: OPERATOR });
    await expect(operator.kyc.reject({ recordId: RECORD, reasonCode: 'document_unreadable', ...kycDual })).resolves.toMatchObject({
      status: 'rejected',
    });
  });

  it('approve/reject without a distinct confirmOperatorId refuses and does not review', async () => {
    const api = await caller(['admin:compliance'], { userId: OPERATOR });

    const missing = await api.kyc.approve({ recordId: RECORD }).catch((e: unknown) => e);
    expect(codeOf(missing)).toBe('PRECONDITION_FAILED');
    expect(String((missing as { message?: string }).message)).toMatch(/typed-in second name|approvalId/);
    expect((missing as { cause?: { code?: string } }).cause?.code).toBe('action_approval.missing');

    const same = await api.kyc.approve({ recordId: RECORD, confirmOperatorId: OPERATOR }).catch((e: unknown) => e);
    expect(codeOf(same)).toBe('PRECONDITION_FAILED');
    expect((same as { cause?: { code?: string } }).cause?.code).toBe('action_approval.missing');

    const rejectMissing = await api.kyc.reject({ recordId: RECORD, reasonCode: 'document_unreadable' }).catch((e: unknown) => e);
    expect(codeOf(rejectMissing)).toBe('PRECONDITION_FAILED');
    expect((rejectMissing as { cause?: { code?: string } }).cause?.code).toBe('action_approval.missing');

    expect(stub.calls.filter((c) => c.method === 'approveKycRecord')).toHaveLength(0);
    expect(stub.calls.filter((c) => c.method === 'rejectKycRecord')).toHaveLength(0);
  });

  it('keeps the review queue behind the same scope', async () => {
    const user = await caller(['identity:read']);
    expect(codeOf(await user.kyc.pending({ limit: 50 }).catch((e: unknown) => e))).toBe('FORBIDDEN');

    const operator = await caller(['admin:compliance'], { userId: OPERATOR });
    await expect(operator.kyc.pending({ limit: 50 })).resolves.toHaveLength(1);
    const call = stub.calls.find((c) => c.method === 'listPendingKyc');
    expect(call?.args[0]).toBe(50);
  });

  it('kyc.pending omit limit refuses — does not invent 50', async () => {
    const operator = await caller(['admin:compliance'], { userId: OPERATOR });
    const omitted = await (operator.kyc.pending as (input?: unknown) => Promise<unknown>)().catch((e: unknown) => e);
    expect(codeOf(omitted)).toBe('BAD_REQUEST');
    const empty = await operator.kyc.pending({} as never).catch((e: unknown) => e);
    expect(codeOf(empty)).toBe('BAD_REQUEST');
    expect(stub.calls.filter((c) => c.method === 'listPendingKyc')).toHaveLength(0);
  });

  it('maps a record that cannot be approved to CONFLICT, not to a 500', async () => {
    stub.fail(new AuthError('KYC record is rejected', 'auth.kyc_not_pending'));
    const api = await caller(['admin:compliance'], { userId: OPERATOR });
    expect(codeOf(await api.kyc.approve({ recordId: RECORD, ...kycDual }).catch((e: unknown) => e))).toBe('CONFLICT');
  });

  it('maps an unknown record to NOT_FOUND', async () => {
    stub.fail(new AuthError('KYC record not found', 'auth.not_found'));
    const api = await caller(['admin:compliance'], { userId: OPERATOR });
    expect(codeOf(await api.kyc.approve({ recordId: RECORD, ...kycDual }).catch((e: unknown) => e))).toBe('NOT_FOUND');
  });

  it('refuses an agent service caller writing reviewed_by even with compliance + MFA', async () => {
    const api = await caller(['admin:compliance'], { userId: OPERATOR, service: 'svc-agents' });
    const err = await api.kyc.approve({ recordId: RECORD }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
    expect((err as Error).message).toMatch(/agent must never write reviewed_by/);
    expect(stub.calls.filter((c) => c.method === 'approveKycRecord')).toHaveLength(0);

    const rejectErr = await api.kyc.reject({ recordId: RECORD, reasonCode: 'document_unreadable' }).catch((e: unknown) => e);
    expect(codeOf(rejectErr)).toBe('FORBIDDEN');
    expect(stub.calls.filter((c) => c.method === 'rejectKycRecord')).toHaveLength(0);
  });

  it('refuses an API-key (agent) principal writing reviewed_by', async () => {
    const api = await caller(['admin:compliance'], {
      userId: OPERATOR,
      apiKeyId: '55555555-5555-4555-8555-555555555555',
    });
    const err = await api.kyc.approve({ recordId: RECORD }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
    // requireScope refuses the key before the handler's reviewed_by check.
    expect((err as Error).message).toMatch(/cannot be used from an API key/);
    expect((err as { cause?: { code?: string } }).cause?.code).toBe('scope.interactive_only');
    expect(stub.calls.filter((c) => c.method === 'approveKycRecord')).toHaveLength(0);
  });
});

// ── Submitting is the user's own act, and only their own ─────────────────────

describe('kyc.submit', () => {
  it('takes the user id from the token, so there is no id to tamper with', async () => {
    const api = await caller(['identity:write']);
    await api.kyc.submit({ tier: 'basic', jurisdiction: 'DE' });

    const call = stub.calls.find((c) => c.method === 'submitKyc')!;
    expect((call.args[0] as { userId: string }).userId).toBe(USER);
    // Stronger than an ownership check: an input the caller cannot supply
    // cannot be forged. `submit({ userId })` would need a guard; this needs none.
    expect(Object.keys(call.args[0] as object)).not.toContain('targetUserId');
  });

  it('needs identity:write — reading your own status is not asking to be verified', async () => {
    const api = await caller(['identity:read']);
    const err = await api.kyc.submit({ tier: 'basic', jurisdiction: 'DE' }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
  });

  it('rejects a tier of "none" and a jurisdiction that is not ISO-3166 alpha-2', async () => {
    const api = await caller(['identity:write']);
    await expect(api.kyc.submit({ tier: 'none' as never, jurisdiction: 'DE' })).rejects.toThrow();
    await expect(api.kyc.submit({ tier: 'basic', jurisdiction: 'Germany' })).rejects.toThrow();
    await expect(api.kyc.submit({ tier: 'basic', jurisdiction: '' })).rejects.toThrow();
    expect(stub.calls.filter((c) => c.method === 'submitKyc')).toHaveLength(0);
  });

  it('strips a client-supplied providerRef — free text must not enter the pointer column', async () => {
    const api = await caller(['identity:write']);
    // Zod object schema strips unknown keys; body DOB/name fragments never reach submitKyc.
    await api.kyc.submit({ tier: 'basic', jurisdiction: 'DE', providerRef: 'DOB:1990-01-01' } as never);
    const call = stub.calls.find((c) => c.method === 'submitKyc')!;
    expect(call.args[0]).toEqual({ userId: USER, tier: 'basic', jurisdiction: 'DE' });
    expect(call.args[0]).not.toHaveProperty('providerRef');
  });

  it('normalises the jurisdiction, because the matrix is keyed on upper case', async () => {
    const api = await caller(['identity:write']);
    await api.kyc.submit({ tier: 'basic', jurisdiction: 'de' });

    const call = stub.calls.find((c) => c.method === 'submitKyc')!;
    expect((call.args[0] as { jurisdiction: string }).jurisdiction).toBe('DE');
  });
});

describe('kyc.reject names a reason from the owner list (I-kyc-compliance-01)', () => {
  it('passes the code, the note and its visibility to the decision', async () => {
    const api = await caller(['admin:compliance'], { userId: OPERATOR });
    await api.kyc.reject({
      recordId: RECORD,
      reasonCode: 'document_unreadable',
      customerNote: ' TEST note ',
      noteVisible: true,
      ...kycDual,
    });
    const call = stub.calls.find((c) => c.method === 'rejectKycRecord')!;
    expect(call.args[0]).toMatchObject({ reasonCode: 'document_unreadable', customerNote: 'TEST note', noteVisible: true });
  });

  it('refuses a reject without a code, with an unknown code, or while the owner list is unset, before the approval is spent', async () => {
    const consumed: unknown[] = [];
    const approvals = {
      ...stubActionApprovals(CONFIRM_KYC),
      async consume(...args: Parameters<ReturnType<typeof stubActionApprovals>['consume']>) {
        consumed.push(args);
        return stubActionApprovals(CONFIRM_KYC).consume(...args);
      },
    };
    const listed = createIdentityRouter(stub.auth, stub.rank, { actionApprovals: approvals, kycRejectReasons: KYC_REASONS }).createCaller(
      await ctx(['admin:compliance'], { userId: OPERATOR }),
    );
    const none = await listed.kyc.reject({ recordId: RECORD, ...kycDual } as never).catch((e: unknown) => e);
    expect(codeOf(none)).toBe('BAD_REQUEST');
    const unknown = await listed.kyc.reject({ recordId: RECORD, reasonCode: 'not_listed', ...kycDual }).catch((e: unknown) => e);
    expect(codeOf(unknown)).toBe('BAD_REQUEST');
    expect((unknown as { cause?: { code?: string } }).cause?.code).toBe('kyc.reason_code_unknown');
    const unset = createIdentityRouter(stub.auth, stub.rank, { actionApprovals: approvals }).createCaller(
      await ctx(['admin:compliance'], { userId: OPERATOR }),
    );
    const refused = await unset.kyc.reject({ recordId: RECORD, reasonCode: 'document_unreadable', ...kycDual }).catch((e: unknown) => e);
    expect(codeOf(refused)).toBe('PRECONDITION_FAILED');
    expect((refused as { cause?: { code?: string } }).cause?.code).toBe('kyc.reason_codes_unset');
    expect(consumed).toEqual([]);
    expect(stub.calls.filter((c) => c.method === 'rejectKycRecord')).toHaveLength(0);
  });

  it('the four-eyes approval binds the reason, the note and whether it shows, not only the record', async () => {
    const hashes: string[] = [];
    const approvals = {
      ...stubActionApprovals(CONFIRM_KYC),
      async consume(...args: Parameters<ReturnType<typeof stubActionApprovals>['consume']>) {
        hashes.push(args[1].payloadHash);
        return stubActionApprovals(CONFIRM_KYC).consume(...args);
      },
    };
    const api = createIdentityRouter(stub.auth, stub.rank, { actionApprovals: approvals, kycRejectReasons: KYC_REASONS }).createCaller(
      await ctx(['admin:compliance'], { userId: OPERATOR }),
    );
    await api.kyc.reject({
      recordId: RECORD,
      reasonCode: 'document_unreadable',
      customerNote: ' TEST note ',
      noteVisible: true,
      ...kycDual,
    });
    await api.kyc.reject({ recordId: RECORD, reasonCode: 'document_unreadable', ...kycDual });
    expect(hashes).toEqual([
      identityActionPayloadHash('kyc.reject', {
        recordId: RECORD,
        reasonCode: 'document_unreadable',
        customerNote: 'TEST note',
        noteVisible: 'true',
      }),
      identityActionPayloadHash('kyc.reject', {
        recordId: RECORD,
        reasonCode: 'document_unreadable',
        customerNote: '',
        noteVisible: 'false',
      }),
    ]);
    expect(new Set(hashes).size).toBe(2);
  });

  it('refuses a case already rejected with another code before the approval is spent', async () => {
    const consumed: unknown[] = [];
    const approvals = {
      ...stubActionApprovals(CONFIRM_KYC),
      async consume(...args: Parameters<ReturnType<typeof stubActionApprovals>['consume']>) {
        consumed.push(args);
        return stubActionApprovals(CONFIRM_KYC).consume(...args);
      },
    };
    const checked: unknown[] = [];
    const auth: AuthService = Object.assign(Object.create(stub.auth) as AuthService, {
      async assertKycRejectable(...args: unknown[]) {
        checked.push(args);
        throw new KycCaseError('This case is already rejected with document_expired', 'kyc.case_state');
      },
    });
    const api = createIdentityRouter(auth, stub.rank, { actionApprovals: approvals, kycRejectReasons: KYC_REASONS }).createCaller(
      await ctx(['admin:compliance'], { userId: OPERATOR }),
    );
    const refused = await api.kyc.reject({ recordId: RECORD, reasonCode: 'document_unreadable', ...kycDual }).catch((e: unknown) => e);
    expect(codeOf(refused)).toBe('CONFLICT');
    expect((refused as { cause?: { code?: string } }).cause?.code).toBe('kyc.case_state');
    expect(checked).toEqual([[RECORD, { reasonCode: 'document_unreadable', customerNote: null, noteVisible: false }]]);
    expect(consumed).toEqual([]);
    expect(stub.calls.filter((c) => c.method === 'rejectKycRecord')).toHaveLength(0);
  });
});

describe('kyc.proofOfAddress (I-kyc-compliance-11)', () => {
  it('without the desk every door refuses kyc.poa_unconfigured', async () => {
    const api = await caller(['identity:read']);
    const err = await api.kyc.proofOfAddress.read({}).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('PRECONDITION_FAILED');
    expect((err as { cause?: { code?: string } }).cause?.code).toBe('kyc.poa_unconfigured');
  });

  it('submits for the caller only; listFor is behind admin:compliance; refusals keep their codes', async () => {
    const seen: unknown[][] = [];
    const desk = {
      async submit(...args: unknown[]) {
        seen.push(args);
        throw new KycPoaError('too old', 'kyc.poa_too_old', { maxAgeDays: 90 });
      },
      async listFor() {
        return [];
      },
    } as unknown as KycPoaDesk;
    const make = async (scopes: string[]) => createIdentityRouter(stub.auth, stub.rank, { kycPoa: desk }).createCaller(await ctx(scopes));
    const input = { type: 'utility_bill', country: 'DE', issuedOn: '2026-01-01', contentType: 'application/pdf', bytesBase64: 'AQID' };
    const refused = await (await make(['identity:write'])).kyc.proofOfAddress.submit(input).catch((e: unknown) => e);
    expect(codeOf(refused)).toBe('BAD_REQUEST');
    expect((refused as { cause?: { code?: string } }).cause?.code).toBe('kyc.poa_too_old');
    expect(seen[0]![0]).toBe(USER);
    expect(
      codeOf(
        await (await make(['identity:write'])).kyc.proofOfAddress.submit({ ...input, userId: OPERATOR } as never).catch((e: unknown) => e),
      ),
    ).toBe('BAD_REQUEST');
    expect(
      codeOf(await (await make(['identity:read'])).kyc.proofOfAddress.listFor({ userId: USER, limit: 5 }).catch((e: unknown) => e)),
    ).toBe('FORBIDDEN');
    expect(await (await make(['admin:compliance'])).kyc.proofOfAddress.listFor({ userId: USER, limit: 5 })).toEqual({ submissions: [] });
  });
});

describe('kyc.selfie (I-kyc-compliance-09)', () => {
  it('without the desk every door refuses kyc.selfie_unconfigured', async () => {
    const api = await caller(['identity:read', 'identity:write']);
    const err = await api.kyc.selfie.read().catch((e: unknown) => e);
    expect(codeOf(err)).toBe('PRECONDITION_FAILED');
    expect((err as { cause?: { code?: string } }).cause?.code).toBe('kyc.selfie_unconfigured');
    expect(codeOf(await api.kyc.selfie.handoff.start().catch((e: unknown) => e))).toBe('PRECONDITION_FAILED');
  });

  it('acts for the caller only; a used link is CONFLICT, an unknown one NOT_FOUND; listFor is behind admin:compliance', async () => {
    const seen: unknown[][] = [];
    const token = 'A'.repeat(43);
    const desk = {
      async submit(...args: unknown[]) {
        seen.push(args);
        throw new KycSelfieError('used', 'kyc.handoff_used');
      },
      async checkHandoff(...args: unknown[]) {
        seen.push(args);
        throw new KycSelfieError('unknown', 'kyc.handoff_unknown');
      },
      async listFor() {
        return [];
      },
    } as unknown as KycSelfieDesk;
    const make = async (scopes: string[]) =>
      createIdentityRouter(stub.auth, stub.rank, { kycSelfie: desk }).createCaller(await ctx(scopes));
    const input = { contentType: 'image/jpeg', bytesBase64: 'AQID', handoff: token };
    const used = await (await make(['identity:write'])).kyc.selfie.submit(input).catch((e: unknown) => e);
    expect(codeOf(used)).toBe('CONFLICT');
    expect((used as { cause?: { code?: string } }).cause?.code).toBe('kyc.handoff_used');
    expect(seen[0]![0]).toBe(USER);
    expect(seen[0]![1]).toMatchObject({ contentType: 'image/jpeg', handoff: token });
    const unknown = await (await make(['identity:read'])).kyc.selfie.handoff.check({ token }).catch((e: unknown) => e);
    expect(codeOf(unknown)).toBe('NOT_FOUND');
    expect(seen[1]).toEqual([USER, token]);
    expect(
      codeOf(await (await make(['identity:write'])).kyc.selfie.submit({ ...input, userId: OPERATOR } as never).catch((e: unknown) => e)),
    ).toBe('BAD_REQUEST');
    expect(codeOf(await (await make(['identity:write'])).kyc.selfie.submit({ ...input, handoff: 'short' }).catch((e: unknown) => e))).toBe(
      'BAD_REQUEST',
    );
    expect(codeOf(await (await make(['identity:read'])).kyc.selfie.listFor({ userId: USER, limit: 5 }).catch((e: unknown) => e))).toBe(
      'FORBIDDEN',
    );
    expect(await (await make(['admin:compliance'])).kyc.selfie.listFor({ userId: USER, limit: 5 })).toEqual({ selfies: [] });
  });

  it("decide: MFA, never the reviewer's own, refused before the approval is spent; the approval binds selfie and decision", async () => {
    const SELFIE = '77777777-7777-4777-8777-777777777777';
    const hashes: string[] = [];
    const approvals = {
      ...stubActionApprovals(CONFIRM_KYC),
      async consume(...args: Parameters<ReturnType<typeof stubActionApprovals>['consume']>) {
        hashes.push(args[1].payloadHash);
        return stubActionApprovals(CONFIRM_KYC).consume(...args);
      },
    };
    const decided: unknown[] = [];
    const desk = (state: 'provided' | 'decided_other') =>
      ({
        async assertDecidable() {
          if (state === 'decided_other') throw new KycSelfieError('decided', 'kyc.selfie_decided');
          return USER;
        },
        async decide(input: unknown) {
          decided.push(input);
          return {
            id: SELFIE,
            status: 'accepted',
            via: 'this_device',
            createdAt: '2026-10-29T00:00:00.000Z',
            documentId: CONFIRM_KYC,
            captureCheck: 'not_checked',
            decidedAt: '2026-10-29T00:01:00.000Z',
          };
        },
      }) as unknown as KycSelfieDesk;
    const make = async (opts: { mfa?: boolean; userId?: string } = {}, state: 'provided' | 'decided_other' = 'provided') =>
      createIdentityRouter(stub.auth, stub.rank, { actionApprovals: approvals, kycSelfie: desk(state) }).createCaller(
        await ctx(['admin:compliance'], { userId: OPERATOR, ...opts }),
      );
    const input = { selfieId: SELFIE, decision: 'accepted' as const, ...kycDual };
    expect(codeOf(await (await make({ mfa: false })).kyc.selfie.decide(input).catch((e: unknown) => e))).toBe('UNAUTHORIZED');
    const own = await (await make({ userId: USER })).kyc.selfie.decide(input).catch((e: unknown) => e);
    expect((own as { cause?: { code?: string } }).cause?.code).toBe('auth.kyc_self_review');
    const other = await (await make({}, 'decided_other')).kyc.selfie.decide(input).catch((e: unknown) => e);
    expect(codeOf(other)).toBe('CONFLICT');
    expect(hashes).toEqual([]);
    expect(codeOf(await (await caller(['identity:write'])).kyc.selfie.decide(input).catch((e: unknown) => e))).toBe('FORBIDDEN');
    expect(await (await make()).kyc.selfie.decide(input)).toMatchObject({ status: 'accepted', captureCheck: 'not_checked' });
    expect(hashes).toEqual([identityActionPayloadHash('kyc.selfie.decide', { selfieId: SELFIE, decision: 'accepted' })]);
    expect(decided).toEqual([
      { selfieId: SELFIE, decision: 'accepted', reviewerId: OPERATOR, approvalParties: ['requester', CONFIRM_KYC] },
    ]);
  });
});

describe('kyc.profile and kyc.documentTypes (I-kyc-compliance-08)', () => {
  it('without the desk every door refuses kyc.profile_unconfigured', async () => {
    const api = await caller(['identity:read', 'identity:write']);
    for (const call of [
      () => api.kyc.profile.read(),
      () => api.kyc.profile.start({ tier: 'basic' }),
      () => api.kyc.documentTypes.read({ country: 'DE' }),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(codeOf(err)).toBe('PRECONDITION_FAILED');
      expect((err as { cause?: { code?: string } }).cause?.code).toBe('kyc.profile_unconfigured');
    }
  });

  it("acts only on the caller's own draft, and maps each refusal", async () => {
    const seen: unknown[][] = [];
    const desk = {
      async start(...args: unknown[]) {
        seen.push(['start', ...args]);
        throw new KycProfileError('stale', 'kyc.profile_version');
      },
      async upload(...args: unknown[]) {
        seen.push(['upload', ...args]);
        throw new KycProfileError('over', 'kyc.upload_too_large', { maxBytes: 1 });
      },
      async saveStep(...args: unknown[]) {
        seen.push(['saveStep', ...args]);
        throw new KycProfileError('none', 'kyc.document_types_unset');
      },
    } as unknown as KycProfileDesk;
    const api = createIdentityRouter(stub.auth, stub.rank, { kycProfile: desk }).createCaller(await ctx(['identity:write']));
    // There is no id to tamper with: an extra `userId` is refused as input, before the desk.
    expect(codeOf(await api.kyc.profile.start({ tier: 'basic', userId: OPERATOR } as never).catch((e: unknown) => e))).toBe('BAD_REQUEST');
    expect(codeOf(await api.kyc.profile.start({ tier: 'basic' }).catch((e: unknown) => e))).toBe('CONFLICT');
    expect(
      codeOf(await api.kyc.profile.upload({ version: 1, contentType: 'image/png', bytesBase64: 'AQID' }).catch((e: unknown) => e)),
    ).toBe('PAYLOAD_TOO_LARGE');
    const notCanonical = await api.kyc.profile
      .upload({ version: 1, contentType: 'image/png', bytesBase64: 'AQID\n' })
      .catch((e: unknown) => e);
    expect(codeOf(notCanonical)).toBe('BAD_REQUEST');
    expect(codeOf(await api.kyc.profile.saveStep({ step: 'document', version: 1, fields: {} }).catch((e: unknown) => e))).toBe(
      'PRECONDITION_FAILED',
    );
    expect(seen.map((c) => [c[0], c[1]])).toEqual([
      ['start', USER],
      ['upload', USER],
      ['saveStep', USER],
    ]);
    const read = await createIdentityRouter(stub.auth, stub.rank, { kycProfile: desk })
      .createCaller(await ctx(['identity:read']))
      .kyc.profile.start({ tier: 'basic' })
      .catch((e: unknown) => e);
    expect(codeOf(read)).toBe('FORBIDDEN');
  });

  it('submit maps an open request to CONFLICT and an unreadable draft to INTERNAL_SERVER_ERROR, for the caller only', async () => {
    const seen: unknown[][] = [];
    const answers = [
      new KycProfileError('open', 'kyc.profile_request_open', { status: 'pending' }),
      new KycProfileError('unreadable', 'kyc.profile_unreadable'),
    ];
    const desk = {
      async submit(...args: unknown[]) {
        seen.push(args);
        throw answers.shift();
      },
    } as unknown as KycProfileDesk;
    const api = createIdentityRouter(stub.auth, stub.rank, { kycProfile: desk }).createCaller(await ctx(['identity:write']));
    const open = await api.kyc.profile.submit({ version: 3 }).catch((e: unknown) => e);
    expect(codeOf(open)).toBe('CONFLICT');
    expect((open as { cause?: { code?: string } }).cause?.code).toBe('kyc.profile_request_open');
    expect(codeOf(await api.kyc.profile.submit({ version: 3 }).catch((e: unknown) => e))).toBe('INTERNAL_SERVER_ERROR');
    expect(seen).toEqual([
      [USER, 3],
      [USER, 3],
    ]);
  });
});

describe('kyc.attempts (I-kyc-compliance-10)', () => {
  it("read is the caller's own standing, with no id to tamper with", async () => {
    const api = await caller(['identity:read']);
    expect(await api.kyc.attempts.read()).toEqual({ limit: null, denialsInWindow: null, lockedUntil: null });
    expect(stub.calls.find((c) => c.method === 'kycAttempts')!.args).toEqual([USER]);
    await api.kyc.attempts.read({ userId: OPERATOR } as never);
    expect(stub.calls.filter((c) => c.method === 'kycAttempts').map((c) => c.args[0])).toEqual([USER, USER]);
  });

  it('a request at the cap is refused TOO_MANY_REQUESTS, carrying the code and the seconds left', async () => {
    const locked: AuthService = Object.assign(Object.create(stub.auth) as AuthService, {
      async submitKyc() {
        throw new KycAttemptsError('refused for 3600 more seconds', { retryAfterSeconds: 3600 });
      },
    });
    const api = createIdentityRouter(locked, stub.rank, {}).createCaller(await ctx(['identity:write']));
    const refused = await api.kyc.submit({ tier: 'basic', jurisdiction: 'DE' }).catch((e: unknown) => e);
    expect(codeOf(refused)).toBe('TOO_MANY_REQUESTS');
    expect((refused as { cause?: { code?: string; details?: unknown } }).cause).toMatchObject({
      code: 'kyc.attempts_exhausted',
      details: { retryAfterSeconds: 3600 },
    });
  });
});

describe('kyc.capabilities (I-kyc-compliance-07)', () => {
  it("get reads only the caller's own; getFor is behind admin:compliance", async () => {
    const api = await caller(['identity:read']);
    expect(await api.kyc.capabilities.get()).toEqual(capabilitiesRead);
    expect(stub.calls.find((c) => c.method === 'listKycCapabilities')!.args[0]).toBe(USER);
    expect(codeOf(await api.kyc.capabilities.getFor({ userId: OPERATOR }).catch((e: unknown) => e))).toBe('FORBIDDEN');
    const operator = await caller(['admin:compliance'], { userId: OPERATOR });
    await operator.kyc.capabilities.getFor({ userId: USER });
    expect(stub.calls.filter((c) => c.method === 'listKycCapabilities').map((c) => c.args[0])).toEqual([USER, USER]);
  });

  it('set switches one off with a listed code; the four-eyes approval binds the person, the capability and the code', async () => {
    const hashes: string[] = [];
    const approvals = {
      ...stubActionApprovals(CONFIRM_KYC),
      async consume(...args: Parameters<ReturnType<typeof stubActionApprovals>['consume']>) {
        hashes.push(args[1].payloadHash);
        return stubActionApprovals(CONFIRM_KYC).consume(...args);
      },
    };
    const api = createIdentityRouter(stub.auth, stub.rank, { actionApprovals: approvals, kycCapabilityReasons: KYC_REASONS }).createCaller(
      await ctx(['admin:compliance'], { userId: OPERATOR }),
    );
    await api.kyc.capabilities.set({
      userId: USER,
      capability: 'trade_crypto',
      state: 'inactive',
      reasonCode: 'document_unreadable',
      ...kycDual,
    });
    expect(hashes).toEqual([
      identityActionPayloadHash('kyc.capabilities.set', {
        userId: USER,
        capability: 'trade_crypto',
        state: 'inactive',
        reasonCode: 'document_unreadable',
      }),
    ]);
    const call = stub.calls.find((c) => c.method === 'deactivateKycCapability')!;
    expect(call.args[0]).toMatchObject({
      userId: USER,
      capability: 'trade_crypto',
      reasonCode: 'document_unreadable',
      reviewerId: OPERATOR,
    });
  });

  it('refuses before the approval is spent: no MFA, own account, unlisted code, a state other than inactive, a recorded other code', async () => {
    const consumed: unknown[] = [];
    const approvals = {
      ...stubActionApprovals(CONFIRM_KYC),
      async consume(...args: Parameters<ReturnType<typeof stubActionApprovals>['consume']>) {
        consumed.push(args);
        return stubActionApprovals(CONFIRM_KYC).consume(...args);
      },
    };
    const make = async (opts: { mfa?: boolean; userId?: string } = {}, auth: AuthService = stub.auth) =>
      createIdentityRouter(auth, stub.rank, { actionApprovals: approvals, kycCapabilityReasons: KYC_REASONS }).createCaller(
        await ctx(['admin:compliance'], { userId: OPERATOR, ...opts }),
      );
    const input = {
      userId: USER,
      capability: 'trade_crypto' as const,
      state: 'inactive' as const,
      reasonCode: 'document_unreadable',
      ...kycDual,
    };
    expect(codeOf(await (await make({ mfa: false })).kyc.capabilities.set(input).catch((e: unknown) => e))).toBe('UNAUTHORIZED');
    const own = await (await make({ userId: USER })).kyc.capabilities.set(input).catch((e: unknown) => e);
    expect((own as { cause?: { code?: string } }).cause?.code).toBe('auth.kyc_self_review');
    const unlisted = await (await make()).kyc.capabilities.set({ ...input, reasonCode: 'not_listed' }).catch((e: unknown) => e);
    expect((unlisted as { cause?: { code?: string } }).cause?.code).toBe('kyc.reason_code_unknown');
    expect(codeOf(await (await make()).kyc.capabilities.set({ ...input, state: 'active' } as never).catch((e: unknown) => e))).toBe(
      'BAD_REQUEST',
    );
    const recorded: AuthService = Object.assign(Object.create(stub.auth) as AuthService, {
      async assertKycCapabilityDeactivatable() {
        throw new KycCapabilityError('trade_crypto is already inactive with name_mismatch', 'kyc.capability_state');
      },
    });
    const conflict = await (await make({}, recorded)).kyc.capabilities.set(input).catch((e: unknown) => e);
    expect(codeOf(conflict)).toBe('CONFLICT');
    // The reject reasons are not switch-off reasons: with only those published, a switch-off refuses as unset.
    const rejectOnly = createIdentityRouter(stub.auth, stub.rank, {
      actionApprovals: approvals,
      kycRejectReasons: KYC_REASONS,
    }).createCaller(await ctx(['admin:compliance'], { userId: OPERATOR }));
    const unset = await rejectOnly.kyc.capabilities.set(input).catch((e: unknown) => e);
    expect((unset as { cause?: { code?: string } }).cause?.code).toBe('kyc.reason_codes_unset');
    expect(consumed).toEqual([]);
    expect(stub.calls.filter((c) => c.method === 'deactivateKycCapability')).toHaveLength(0);
  });
});

describe('kyc.history and kyc.historyFor', () => {
  it("reads only the caller's own cases, with the owner list", async () => {
    const api = await caller(['identity:read']);
    expect(await api.kyc.history({ limit: 20 })).toEqual({ cases: [] });
    const call = stub.calls.find((c) => c.method === 'listKycCases')!;
    expect(call.args.slice(0, 2)).toEqual([USER, 20]);
    expect(call.args[2]).toBe(KYC_REASONS);
    // There is no userId input: another person's id is not read, it is refused as input.
    const other = await api.kyc.history({ limit: 20, userId: OPERATOR } as never).catch((e: unknown) => e);
    expect(other).toEqual({ cases: [] });
    expect(stub.calls.filter((c) => c.method === 'listKycCases').every((c) => c.args[0] === USER)).toBe(true);
  });

  it("keeps any person's cases behind admin:compliance", async () => {
    const user = await caller(['identity:read']);
    expect(codeOf(await user.kyc.historyFor({ userId: OPERATOR, limit: 5 }).catch((e: unknown) => e))).toBe('FORBIDDEN');
    const operator = await caller(['admin:compliance'], { userId: OPERATOR });
    await operator.kyc.historyFor({ userId: USER, limit: 5 });
    expect(stub.calls.filter((c) => c.method === 'listKycCases').map((c) => c.args[0])).toEqual([USER]);
  });

  it('an unknown person is NOT_FOUND', async () => {
    const operator = await caller(['admin:compliance'], { userId: OPERATOR });
    stub.fail(new AuthError('User not found', 'auth.not_found'));
    expect(codeOf(await operator.kyc.historyFor({ userId: USER, limit: 5 }).catch((e: unknown) => e))).toBe('NOT_FOUND');
  });
});

describe('kyc.status', () => {
  it('reports the caller’s own tier and records', async () => {
    const api = await caller(['identity:read']);
    const status = await api.kyc.status({ limit: 200 });

    expect(status.tier).toBe('none');
    expect(status.records).toHaveLength(1);
    expect(stub.calls.find((c) => c.method === 'listKycRecords')!.args[0]).toBe(USER);
  });

  it('NEVER RETURNS THE PROVIDER POINTER OR THE REVIEWER (§10 PII isolation)', async () => {
    const api = await caller(['identity:read']);
    const status = await api.kyc.status({ limit: 200 });

    // The provider ref points into a document store; the reviewer is a
    // compliance officer the subject of the review has no business naming.
    expect(JSON.stringify(status)).not.toContain('provider-pointer-that-must-not-leak');
    expect(status.records[0]).not.toHaveProperty('providerRef');
    expect(status.records[0]).not.toHaveProperty('reviewedBy');
    expect(status.records[0]).not.toHaveProperty('bytes');
    expect(status.records[0]).not.toHaveProperty('bytesBase64');
    expect(status.records[0]).not.toHaveProperty('ciphertext');
    expect(JSON.stringify(status)).not.toMatch(/"bytes"|"ciphertext"|"provider_ref"/);
  });
});

// ── Step-up ──────────────────────────────────────────────────────────────────

describe('auth.stepUp is what makes a withdrawal reachable at all', () => {
  it('elevates a live session and returns a token carrying trade:withdraw', async () => {
    const api = await caller(['identity:read']);
    const elevated = await api.auth.stepUp({ totpCode: '123456' });

    expect(elevated.scopes).toContain('trade:withdraw');
    expect(elevated.expiresAt).toBe('2026-07-28T09:05:00.000Z');
  });

  it('binds the elevation to the session in the token, not to anything sent', async () => {
    const api = await caller(['identity:read']);
    await api.auth.stepUp({ totpCode: '123456' });

    const call = stub.calls.find((c) => c.method === 'stepUp')!;
    expect(call.args[0]).toMatchObject({ userId: USER, sessionId: SESSION });
  });

  it('does not take a scope list from the caller', async () => {
    const api = await caller(['identity:read']);
    // An elevation endpoint that accepts a scope list is a scope-granting
    // endpoint. zod strips it; the assertion is that it never reaches the service.
    await api.auth.stepUp({ totpCode: '123456', scopes: ['admin:treasury'] } as never);

    const call = stub.calls.find((c) => c.method === 'stepUp')!;
    const args = call.args[0] as Record<string, unknown>;
    expect(args).toMatchObject({ userId: USER, sessionId: SESSION, totpCode: '123456' });
    expect(args).not.toHaveProperty('scopes');
    // webauthn may be present as undefined — never a client-chosen scope list.
    expect(
      Object.keys(args)
        .filter((k) => k !== 'webauthn')
        .sort(),
    ).toEqual(['sessionId', 'totpCode', 'userId'].sort());
  });

  it('accepts a WebAuthn assertion path for passkey-only step-up', async () => {
    const api = await caller(['identity:read']);
    const assertion = {
      id: 'cred-1',
      rawId: 'cred-1',
      type: 'public-key' as const,
      response: {
        clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0',
        authenticatorData: 'YXV0aA',
        signature: 'c2ln',
      },
    };
    await api.auth.stepUp({ webauthn: assertion });
    const call = stub.calls.find((c) => c.method === 'stepUp')!;
    expect(call.args[0]).toMatchObject({ userId: USER, sessionId: SESSION, webauthn: assertion });
  });

  it('exposes stepUpOptions for the WebAuthn ceremony', async () => {
    const api = await caller(['identity:read']);
    await expect(api.auth.stepUpOptions()).resolves.toMatchObject({ challenge: 'chal-stepup' });
    expect(stub.calls.some((c) => c.method === 'startWebauthnStepUp')).toBe(true);
  });

  it('refuses an anonymous caller', async () => {
    const api = await caller([]);
    await expect(api.auth.stepUp({ totpCode: '123456' })).rejects.toThrow(/Authentication required/);
  });

  it('rejects a malformed code at the boundary', async () => {
    const api = await caller(['identity:read']);
    for (const totpCode of ['', '12345', '1234567', 'abcdef', ' 123456 ', 'AAAA-BBBB', 'AAAAA-BBBBBB']) {
      await expect(api.auth.stepUp({ totpCode })).rejects.toThrow();
    }
    expect(stub.calls.filter((c) => c.method === 'stepUp')).toHaveLength(0);
  });

  it('accepts recovery-shaped codes on the same totpCode field as login', async () => {
    const api = await caller(['identity:read']);
    await api.auth.stepUp({ totpCode: 'A1B2C-D3E4F' });
    const call = stub.calls.find((c) => c.method === 'stepUp')!;
    expect(call.args[0]).toMatchObject({
      userId: USER,
      sessionId: SESSION,
      totpCode: 'A1B2C-D3E4F',
    });
  });

  it('tells "wrong code" apart from "you have no second factor"', async () => {
    stub.fail(new AuthError('Invalid two-factor code', 'auth.mfa_invalid'));
    const wrongCode = await caller(['identity:read']);
    expect(codeOf(await wrongCode.auth.stepUp({ totpCode: '123456' }).catch((e: unknown) => e))).toBe('UNAUTHORIZED');

    stub.fail(new AuthError('Enrol two-factor authentication before withdrawing', 'auth.mfa_not_enrolled'));
    const notEnrolled = await caller(['identity:read']);
    // FORBIDDEN, because retrying with another code cannot help — the client has
    // to send the user through enrolment, which is different UI.
    expect(codeOf(await notEnrolled.auth.stepUp({ totpCode: '123456' }).catch((e: unknown) => e))).toBe('FORBIDDEN');
  });

  it('maps a dead session to UNAUTHORIZED', async () => {
    stub.fail(new AuthError('Session is no longer valid', 'auth.session_invalid'));
    const api = await caller(['identity:read']);
    expect(codeOf(await api.auth.stepUp({ totpCode: '123456' }).catch((e: unknown) => e))).toBe('UNAUTHORIZED');
  });
});

describe('auth.stepUpPay is the confirm-it-is-you door for pay:refund and pay:payout', () => {
  const MERCHANT = '55555555-5555-4555-8555-555555555555';

  it('passes the session, the merchant, the scopes, and the factor proof', async () => {
    const api = await caller(['identity:read']);
    const minted = await api.auth.stepUpPay({
      merchantId: MERCHANT,
      scopes: ['pay:refund'],
      factorProof: { totpCode: '123456' },
    });
    expect(minted.refreshable).toBe(false);
    expect(minted.accessToken).toBe('pay.step.token');
    const call = stub.calls.find((c) => c.method === 'stepUpPay');
    expect(call?.args[0]).toMatchObject({
      userId: USER,
      sessionId: SESSION,
      merchantId: MERCHANT,
      scopes: ['pay:refund'],
      factorProof: { totpCode: '123456' },
    });
  });

  it('maps a stale factor and a missing role without minting through a 500', async () => {
    stub.fail(new AuthError('This confirmation timed out. Confirm again.', 'auth.step_up_expired'));
    const stale = await caller(['identity:read']);
    const expired = await stale.auth
      .stepUpPay({ merchantId: MERCHANT, scopes: ['pay:refund'], factorProof: { proofId: '66666666-6666-4666-8666-666666666666' } })
      .catch((e: unknown) => e);
    expect(codeOf(expired)).toBe('PRECONDITION_FAILED');
    expect((expired as Error).message).toMatch(/auth\.step_up_expired/);

    stub.fail(new AuthError('Your role on this merchant does not allow refunds.create', 'pay.role_not_allowed'));
    const refused = await caller(['identity:read']);
    const role = await refused.auth
      .stepUpPay({ merchantId: MERCHANT, scopes: ['pay:refund'], factorProof: { totpCode: '123456' } })
      .catch((e: unknown) => e);
    expect(codeOf(role)).toBe('FORBIDDEN');
    expect((role as Error).message).toMatch(/pay\.role_not_allowed/);
    expect((role as Error).message).toMatch(/refunds\.create/);
  });
});

// ── WebAuthn ─────────────────────────────────────────────────────────────────

describe('webauthn registration requires a live session; auth is public', () => {
  const registrationBody = {
    id: 'cred-1',
    rawId: 'cred-1',
    type: 'public-key' as const,
    response: {
      clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0',
      attestationObject: 'o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YQ',
    },
  };

  const assertionBody = {
    identifier: 'alice',
    credential: {
      id: 'cred-1',
      rawId: 'cred-1',
      type: 'public-key' as const,
      response: {
        clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0',
        authenticatorData: 'authdata',
        signature: 'sig',
      },
    },
  };

  it('registerOptions is protected', async () => {
    await expect(caller([]).then((api) => api.webauthn.registerOptions())).rejects.toThrow(/Authentication required/);
    const api = await caller(['identity:read']);
    await expect(api.webauthn.registerOptions()).resolves.toMatchObject({ challenge: 'chal-reg' });
    expect(stub.calls.some((c) => c.method === 'startWebauthnRegistration')).toBe(true);
  });

  it('registerVerify binds the principal userId, never a body field', async () => {
    const api = await caller(['identity:write']);
    await expect(api.webauthn.registerVerify(registrationBody)).resolves.toEqual({ credentialId: 'cred-1' });
    const call = stub.calls.find((c) => c.method === 'confirmWebauthnRegistration')!;
    expect(call.args[0]).toBe(USER);
  });

  it('authOptions and authVerify are public and return a session', async () => {
    const anon = await caller([]);
    await expect(anon.webauthn.authOptions({ identifier: 'alice' })).resolves.toMatchObject({ challenge: 'chal-auth' });
    await expect(anon.webauthn.authVerify(assertionBody)).resolves.toMatchObject({
      accessToken: 'access',
      refreshToken: 'refresh',
      userId: USER,
    });
  });

  it('maps a bad ceremony to UNAUTHORIZED', async () => {
    stub.fail(new AuthError('signature verification failed', 'auth.webauthn_invalid'));
    const api = await caller(['identity:read']);
    expect(codeOf(await api.webauthn.registerVerify(registrationBody).catch((e: unknown) => e))).toBe('UNAUTHORIZED');
  });

  it('refuses every procedure when WebAuthn is disabled', async () => {
    router = createIdentityRouter(stub.auth, stub.rank, {
      registrationOpen: true,
      webauthnEnabled: false,
      actionApprovals: stubActionApprovals(),
    });
    const api = await caller(['identity:read']);
    expect(codeOf(await api.webauthn.registerOptions().catch((e: unknown) => e))).toBe('FORBIDDEN');
    expect(codeOf(await api.webauthn.authOptions({ identifier: 'alice' }).catch((e: unknown) => e))).toBe('FORBIDDEN');
    expect(stub.calls.filter((c) => c.method.startsWith('startWebauthn') || c.method.startsWith('confirmWebauthn'))).toHaveLength(0);
  });
});

// ── API keys are a delegation, not a wish list ───────────────────────────────

describe('apiKeys.create passes the GRANTING session as the ceiling', () => {
  const factorProof = { proofId: '77777777-7777-4777-8777-777777777777' };
  const argsOf = (method: string) => stub.calls.filter((c) => c.method === method).map((c) => c.args[0] as Record<string, unknown>);

  it('reads the ceiling from the token, never from the request body', async () => {
    // The enforcement lives in `assertDelegatableScopes` and is tested in
    // packages/auth. What this asserts is the wiring, which is the half that
    // can silently regress: if `grantorScopes` ever comes from `input` — or
    // stops being passed at all — the check downstream has nothing to compare
    // against and any account can mint any scope again.
    const api = await caller(['identity:write', 'trade:read']);
    await api.apiKeys.create({ name: 'bot', scopes: ['trade:read'], factorProof });

    const [args] = argsOf('createApiKey');
    expect(args!.grantorScopes).toEqual(['identity:write', 'trade:read']);
    expect(args!.userId).toBe(USER);
  });

  it('cannot be widened by anything in the input', async () => {
    // A body naming its own grantor must not reach the service. `grantorScopes`
    // is spread AFTER `...input` in the router for exactly this reason.
    const api = await caller(['identity:write']);
    await api.apiKeys.create({ name: 'bot', scopes: ['identity:read'], grantorScopes: ['admin:compliance'], factorProof } as never);

    const [args] = argsOf('createApiKey');
    expect(args!.grantorScopes).toEqual(['identity:write']);
  });

  it('refuses create without a fresh factor and never reaches the service', async () => {
    const api = await caller(['identity:write', 'trade:read']);
    const err = await api.apiKeys.create({ name: 'bot', scopes: ['trade:read'] }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('PRECONDITION_FAILED');
    expect((err as Error).message).toMatch(/auth\.step_up_required/);
    expect(argsOf('createApiKey')).toHaveLength(0);
  });

  it('surfaces a refused delegation as BAD_REQUEST, not a 500', async () => {
    stub.fail(new Error('Cannot grant scopes the granting session does not hold: admin:compliance'));
    const api = await caller(['identity:write']);
    const err = await api.apiKeys.create({ name: 'escalate', scopes: ['admin:compliance'], factorProof }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('BAD_REQUEST');
  });

  it('refuses an API-key principal minting a further key', async () => {
    const api = await caller(['identity:write', 'trade:read'], {
      apiKeyId: '55555555-5555-4555-8555-555555555555',
    });
    const err = await api.apiKeys.create({ name: 'nested', scopes: ['trade:read'] }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
    expect((err as Error).message).toMatch(/cannot grant further/);
    expect(argsOf('createApiKey')).toHaveLength(0);
  });

  it('refuses pay:refund on a key unless the access token is a pay step-up', async () => {
    const api = await caller(['identity:write', 'pay:refund']);
    const err = await api.apiKeys.create({ name: 'bot', scopes: ['pay:refund'] }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('PRECONDITION_FAILED');
    expect((err as Error).message).toMatch(/auth\.step_up_required/);
    expect(argsOf('createApiKey')).toHaveLength(0);
  });

  it('passes payStepUp when the token stp claim lists the requested pay scope', async () => {
    const api = await caller(['identity:write', 'pay:refund'], { stepUpScopes: ['pay:refund'] });
    const created = await api.apiKeys.create({ name: 'bot', scopes: ['pay:refund'], factorProof });
    const [args] = argsOf('createApiKey');
    expect(args!.payStepUp).toBe(true);
    expect(args!.scopes).toEqual(['pay:refund']);
    expect(created.scopes).toEqual(['pay:refund']);
  });

  it('session grantor has no kid on the mint call', async () => {
    const api = await caller(['identity:write', 'trade:read']);
    await api.apiKeys.create({ name: 'bot', scopes: ['trade:read'], factorProof });
    const [args] = argsOf('createApiKey');
    expect(args!.grantorKid).toBeUndefined();
  });
});

describe('apiKeys.exchange turns a key into an edge-usable access token', () => {
  const argsOf = (method: string) => stub.calls.filter((c) => c.method === method).map((c) => c.args[0] as unknown);

  it('is public — no principal required', async () => {
    const api = createIdentityRouter(stub.auth, stub.rank, {
      registrationOpen: true,
      actionApprovals: stubActionApprovals(CONFIRM_KYC),
    }).createCaller(await ctx([]));
    const result = await api.apiKeys.exchange({ key: 'ifc_live_secret' });
    expect(result.accessToken).toBe('api.key.jwt');
    expect(result.userId).toBe(USER);
    expect(result.scopes).toEqual(['trade:read']);
    expect(argsOf('exchangeApiKey')).toEqual(['ifc_live_secret']);
  });

  it('maps a bad key to UNAUTHORIZED without leaking whether the key existed', async () => {
    stub.fail(new AuthError('Invalid credentials', 'auth.invalid_credentials'));
    const api = createIdentityRouter(stub.auth, stub.rank, {
      registrationOpen: true,
      actionApprovals: stubActionApprovals(CONFIRM_KYC),
    }).createCaller(await ctx([]));
    const err = await api.apiKeys.exchange({ key: 'ifc_wrong' }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('UNAUTHORIZED');
    expect((err as { message?: string }).message).toBe(userCopy('auth.invalid_credentials'));
  });
});

// ── Register gate: unset vs explicit closed ──────────────────────────────────

describe('auth.register REGISTRATION_OPEN refuse-closed', () => {
  const signup = {
    handle: 'newbie',
    email: 'newbie@example.com',
    password: 'correct horse battery staple',
  };

  it('unset refuses identity.registration_open_unset and does not register', async () => {
    const api = createIdentityRouter(stub.auth, stub.rank, { actionApprovals: stubActionApprovals(CONFIRM_KYC) }).createCaller(
      await ctx([]),
    );
    const err = await api.auth.register(signup).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('PRECONDITION_FAILED');
    expect((err as Error).message).toContain('identity.registration_open_unset');
    expect(stub.calls.filter((c) => c.method === 'register')).toHaveLength(0);
  });

  it('explicit false refuses closed and does not register', async () => {
    const api = createIdentityRouter(stub.auth, stub.rank, {
      registrationOpen: false,
      actionApprovals: stubActionApprovals(CONFIRM_KYC),
    }).createCaller(await ctx([]));
    const err = await api.auth.register(signup).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
    expect((err as Error).message).toContain('Registration is not open yet');
    expect(stub.calls.filter((c) => c.method === 'register')).toHaveLength(0);
  });
});

// ── Register + optional referrer ─────────────────────────────────────────────

describe('auth.register optional referrerId', () => {
  const REFERRER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('records the client address on the session, not the request id', async () => {
    const api = createIdentityRouter(stub.auth, stub.rank, { registrationOpen: true, directRegister: true }).createCaller(await ctx([]));
    await requestIpAls.run('203.0.113.10', () =>
      api.auth.register({
        handle: 'newbie',
        email: 'newbie@example.com',
        password: 'correct horse battery staple',
      }),
    );
    const arg = stub.calls.find((c) => c.method === 'register')!.args[0] as { ip?: string };
    expect(arg.ip).toBe('203.0.113.10');
  });

  it('leaves the session address empty when no client address was seen', async () => {
    const api = createIdentityRouter(stub.auth, stub.rank, { registrationOpen: true, directRegister: true }).createCaller(await ctx([]));
    await api.auth.register({
      handle: 'newbie',
      email: 'newbie@example.com',
      password: 'correct horse battery staple',
    });
    const arg = stub.calls.find((c) => c.method === 'register')!.args[0] as { ip?: string };
    expect(arg.ip).toBeUndefined();
  });

  it('registers without a referrer and does not call attribute', async () => {
    const attributeCalls: unknown[] = [];
    const referral = {
      attribute: async (input: { userId: string; referrerId: string }) => {
        attributeCalls.push(input);
        return { userId: input.userId, referrerId: input.referrerId, attributedAt: new Date() };
      },
    } as unknown as import('./affiliates/referral-service.js').ReferralService;

    const api = createIdentityRouter(stub.auth, stub.rank, { registrationOpen: true, directRegister: true, referral }).createCaller(
      await ctx([]),
    );
    const session = await api.auth.register({
      handle: 'newbie',
      email: 'newbie@example.com',
      password: 'correct horse battery staple',
    });
    expect(session.userId).toBe(USER);
    expect(attributeCalls).toHaveLength(0);
  });

  it('attributes after register when referrerId is supplied', async () => {
    const attributeCalls: Array<{ userId: string; referrerId: string }> = [];
    const referral = {
      attribute: async (input: { userId: string; referrerId: string }) => {
        attributeCalls.push(input);
        return { userId: input.userId, referrerId: input.referrerId, attributedAt: new Date() };
      },
    } as unknown as import('./affiliates/referral-service.js').ReferralService;

    const api = createIdentityRouter(stub.auth, stub.rank, { registrationOpen: true, directRegister: true, referral }).createCaller(
      await ctx([]),
    );
    await api.auth.register({
      handle: 'newbie',
      email: 'newbie@example.com',
      password: 'correct horse battery staple',
      referrerId: REFERRER,
    });
    expect(attributeCalls).toEqual([{ userId: USER, referrerId: REFERRER }]);
  });

  it('refuses self-referral at register (loud)', async () => {
    const { ReferralError } = await import('./affiliates/referral-tree.js');
    const referral = {
      attribute: async () => {
        throw new ReferralError('Self-referral is refused', 'referral.self');
      },
    } as unknown as import('./affiliates/referral-service.js').ReferralService;

    const api = createIdentityRouter(stub.auth, stub.rank, { registrationOpen: true, directRegister: true, referral }).createCaller(
      await ctx([]),
    );
    const err = await api.auth
      .register({
        handle: 'newbie',
        email: 'newbie@example.com',
        password: 'correct horse battery staple',
        referrerId: USER,
      })
      .catch((e: unknown) => e);
    // referral.self maps to CONFLICT (same family as cycle / already_set).
    expect(codeOf(err)).toBe('CONFLICT');
  });
});

// ── Affiliates Stage: admin tree read + payout refuse-closed ─────────────────

describe('affiliates admin tree read (Stage spine, non-pay)', () => {
  const NODE = '55555555-5555-4555-8555-555555555555';
  const REF = '66666666-6666-4666-8666-666666666666';
  const CHILD = '77777777-7777-4777-8777-777777777777';
  const CONFIRM_FREEZE = '88888888-8888-4888-8888-888888888888';
  const freezeDual = { approvalId: 'appr-1', operationId: 'op-1' };

  function affiliatesRouter() {
    const frozen = new Set<string>([NODE]);
    const referral = {
      treeBoard: async (frozenIds?: ReadonlySet<string>) => ({
        edges: 2,
        referrers: 1,
        maxDepth: 2,
        frozenCount: frozenIds?.size ?? 0,
        maxDepthCap: 5,
      }),
      nodeStatus: async (userId: string, frozenIds?: ReadonlySet<string>) => ({
        userId,
        referrerId: REF,
        depth: 1,
        ancestors: [REF],
        directDownline: [],
        directDownlineCount: 0,
        frozen: frozenIds?.has(userId) ?? false,
        attributedAt: '2026-08-07T12:00:00.000Z',
      }),
      listMembers: async (frozenIds?: ReadonlySet<string>, rootId?: string | null, _limit?: number) => {
        const members = [
          {
            userId: NODE,
            referrerId: REF,
            depth: 1,
            frozen: frozenIds?.has(NODE) ?? false,
            attributedAt: '2026-08-07T12:00:00.000Z',
          },
          {
            userId: CHILD,
            referrerId: NODE,
            depth: 2,
            frozen: frozenIds?.has(CHILD) ?? false,
            attributedAt: null,
          },
        ].filter((m) => !rootId || rootId === REF || (rootId === NODE && m.userId === CHILD));
        return {
          members,
          board: {
            total: members.length,
            frozenInList: members.filter((m) => m.frozen).length,
            maxDepthInList: members.reduce((max, m) => Math.max(max, m.depth), 0),
            rootId: rootId ?? null,
          },
        };
      },
    } as unknown as import('./affiliates/referral-service.js').ReferralService;

    const freeze = {
      frozenIds: async () => new Set(frozen),
      list: async (_limit: number) => [],
      freeze: async (input: { beneficiaryId: string; frozenBy: string; reason: string }) => {
        frozen.add(input.beneficiaryId);
        return {
          beneficiaryId: input.beneficiaryId,
          frozenBy: input.frozenBy,
          reason: input.reason,
          frozenAt: new Date('2026-08-07T16:00:00.000Z'),
        };
      },
      unfreeze: async (beneficiaryId: string) => {
        frozen.delete(beneficiaryId);
        return {
          beneficiaryId,
          frozenBy: OPERATOR,
          reason: 'prior',
          frozenAt: new Date('2026-08-07T15:00:00.000Z'),
        };
      },
    } as unknown as import('./affiliates/freeze-service.js').FreezeService;

    return createIdentityRouter(stub.auth, stub.rank, {
      registrationOpen: true,
      referral,
      freeze,
      actionApprovals: stubActionApprovals(CONFIRM_KYC),
    });
  }

  it('treeStatus requires admin:read', async () => {
    const api = affiliatesRouter().createCaller(await ctx(['identity:read']));
    const err = await api.affiliates.treeStatus().catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
  });

  it('treeStatus returns structure board for admin:read', async () => {
    const api = affiliatesRouter().createCaller(await ctx(['admin:read'], { userId: OPERATOR }));
    const board = await api.affiliates.treeStatus();
    expect(board.edges).toBe(2);
    expect(board.frozenCount).toBe(1);
    expect(board.statusLine).toContain('edges=2');
    expect(board.statusLine).toContain('frozen=1');
    // D26-P1-O2 deepen: tip Stage tree + rate authority honesty (no invent %)
    expect(board.rateAuthorityPublished).toBe(false);
    expect(board.rateAuthorityStatusLine).toBe('authority=0 published=0 tiers=0');
  });

  it('node returns place-in-tree for admin:read', async () => {
    const api = affiliatesRouter().createCaller(await ctx(['admin:read'], { userId: OPERATOR }));
    const node = await api.affiliates.node({ userId: NODE });
    expect(node.referrerId).toBe(REF);
    expect(node.depth).toBe(1);
    expect(node.frozen).toBe(true);
    expect(node.ancestors).toEqual([REF]);
  });

  it('members lists attributed roster for admin:read', async () => {
    const api = affiliatesRouter().createCaller(await ctx(['admin:read'], { userId: OPERATOR }));
    const roster = await api.affiliates.members({ limit: 100 });
    expect(roster.total).toBe(2);
    expect(roster.frozenInList).toBe(1);
    expect(roster.members[0]?.userId).toBe(NODE);
    expect(roster.statusLine).toContain('total=2');
    const under = await api.affiliates.members({ rootId: NODE, limit: 100 });
    expect(under.total).toBe(1);
    expect(under.members[0]?.userId).toBe(CHILD);
    expect(under.rootId).toBe(NODE);
  });

  it('members requires admin:read', async () => {
    const api = affiliatesRouter().createCaller(await ctx(['identity:read']));
    const err = await api.affiliates.members({ limit: 100 }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
  });

  it('freeze/unfreeze return honestyLine confirming set membership', async () => {
    const api = affiliatesRouter().createCaller(await ctx(['admin:write'], { userId: OPERATOR }));
    const frozen = await api.affiliates.freeze({ beneficiaryId: CHILD, reason: 'ops hold', ...freezeDual });
    expect(frozen.honestyLine).toContain('action=freeze');
    expect(frozen.honestyLine).toContain('ok=1');
    const thawed = await api.affiliates.unfreeze({ beneficiaryId: CHILD, ...freezeDual });
    expect(thawed.honestyLine).toContain('action=unfreeze');
    expect(thawed.honestyLine).toContain('ok=1');
  });

  it('freeze/unfreeze without a distinct confirmOperatorId refuse and do not write', async () => {
    const held = new Set<string>([NODE]);
    let writes = 0;
    const referral = {
      treeBoard: async () => ({ edges: 0, referrers: 0, maxDepth: 0, frozenCount: 0, maxDepthCap: 5 }),
      nodeStatus: async (userId: string) => ({
        userId,
        referrerId: null,
        depth: 0,
        ancestors: [],
        directDownline: [],
        directDownlineCount: 0,
        frozen: false,
        attributedAt: null,
      }),
      listMembers: async () => ({ members: [], board: { total: 0, frozenInList: 0, maxDepthInList: 0, rootId: null } }),
    } as unknown as import('./affiliates/referral-service.js').ReferralService;
    const freeze = {
      frozenIds: async () => new Set(held),
      list: async () => [],
      freeze: async (input: { beneficiaryId: string; frozenBy: string; reason: string }) => {
        writes += 1;
        held.add(input.beneficiaryId);
        return {
          beneficiaryId: input.beneficiaryId,
          frozenBy: input.frozenBy,
          reason: input.reason,
          frozenAt: new Date('2026-08-07T16:00:00.000Z'),
        };
      },
      unfreeze: async (beneficiaryId: string) => {
        writes += 1;
        held.delete(beneficiaryId);
        return {
          beneficiaryId,
          frozenBy: OPERATOR,
          reason: 'prior',
          frozenAt: new Date('2026-08-07T15:00:00.000Z'),
        };
      },
    } as unknown as import('./affiliates/freeze-service.js').FreezeService;
    const api = createIdentityRouter(stub.auth, stub.rank, {
      registrationOpen: true,
      referral,
      freeze,
      actionApprovals: stubActionApprovals(CONFIRM_KYC),
    }).createCaller(await ctx(['admin:write'], { userId: OPERATOR }));

    const missing = await api.affiliates.freeze({ beneficiaryId: CHILD, reason: 'ops hold' }).catch((e: unknown) => e);
    expect(codeOf(missing)).toBe('PRECONDITION_FAILED');
    expect(String((missing as { message?: string }).message)).toMatch(/typed-in second name|approvalId/);
    expect((missing as { cause?: { code?: string } }).cause?.code).toBe('action_approval.missing');

    const same = await api.affiliates
      .freeze({ beneficiaryId: CHILD, reason: 'ops hold', confirmOperatorId: OPERATOR })
      .catch((e: unknown) => e);
    expect(codeOf(same)).toBe('PRECONDITION_FAILED');
    expect((same as { cause?: { code?: string } }).cause?.code).toBe('action_approval.missing');

    const thawMissing = await api.affiliates.unfreeze({ beneficiaryId: NODE }).catch((e: unknown) => e);
    expect(codeOf(thawMissing)).toBe('PRECONDITION_FAILED');
    const thawSame = await api.affiliates.unfreeze({ beneficiaryId: NODE, confirmOperatorId: OPERATOR }).catch((e: unknown) => e);
    expect(codeOf(thawSame)).toBe('PRECONDITION_FAILED');

    expect(writes).toBe(0);
    expect(held.has(CHILD)).toBe(false);
    expect(held.has(NODE)).toBe(true);
  });

  it('freeze/unfreeze without MFA refuse and do not write', async () => {
    let writes = 0;
    const freeze = {
      frozenIds: async () => new Set<string>(),
      list: async () => [],
      freeze: async () => {
        writes += 1;
        throw new Error('must not freeze without MFA');
      },
      unfreeze: async () => {
        writes += 1;
        throw new Error('must not unfreeze without MFA');
      },
    } as unknown as import('./affiliates/freeze-service.js').FreezeService;
    const api = createIdentityRouter(stub.auth, stub.rank, {
      registrationOpen: true,
      freeze,
      actionApprovals: stubActionApprovals(CONFIRM_KYC),
    }).createCaller(await ctx(['admin:write'], { userId: OPERATOR, mfa: false }));
    const freezeErr = await api.affiliates.freeze({ beneficiaryId: CHILD, reason: 'ops hold', ...freezeDual }).catch((e: unknown) => e);
    expect(codeOf(freezeErr)).toBe('UNAUTHORIZED');
    const thawErr = await api.affiliates.unfreeze({ beneficiaryId: CHILD, ...freezeDual }).catch((e: unknown) => e);
    expect(codeOf(thawErr)).toBe('UNAUTHORIZED');
    expect(writes).toBe(0);
  });

  it('freezes requires an explicit limit — omit never invents 100', async () => {
    const api = affiliatesRouter().createCaller(await ctx(['admin:read'], { userId: OPERATOR }));
    const omitted = await (api.affiliates.freezes as (input?: unknown) => Promise<unknown>)().catch((e: unknown) => e);
    expect(codeOf(omitted)).toBe('BAD_REQUEST');
    await expect(api.affiliates.freezes({ limit: 100 })).resolves.toEqual([]);
  });

  it('payout is refuse-closed (PRECONDITION_FAILED) — no invent rates', async () => {
    const api = affiliatesRouter().createCaller(await ctx(['admin:write'], { userId: OPERATOR }));
    const err = await api.affiliates.payout({}).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('PRECONDITION_FAILED');
    expect(String((err as { message?: string }).message)).toContain('DIRECTION §8');
  });
});

// ── Affiliates residual: myAccruals self-only (durable rows, no invent) ───────

describe('affiliates.myAccruals (self-only durable accruals)', () => {
  const OTHER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const PAYER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  function withAccruals() {
    const store = new MemoryAccrualStore();
    return { store, router: createIdentityRouter(stub.auth, stub.rank, { registrationOpen: true, accruals: store }) };
  }

  it('returns only durable rows for the principal — never foreign beneficiary rows', async () => {
    const { store, router: r } = withAccruals();
    const at = new Date('2026-08-08T12:00:00.000Z');
    await store.saveRows([
      {
        feeEventId: 'fee-mine',
        beneficiaryId: USER,
        payerId: PAYER,
        hop: 0,
        rate: '0.10',
        feeAmount: '100',
        commissionAmount: '10',
        asset: 'USDT',
        accruedAt: at,
        sourceModule: 'trade',
      },
      {
        feeEventId: 'fee-theirs',
        beneficiaryId: OTHER,
        payerId: PAYER,
        hop: 0,
        rate: '0.10',
        feeAmount: '50',
        commissionAmount: '5',
        asset: 'USDT',
        accruedAt: at,
        sourceModule: 'pay',
      },
    ]);

    const api = r.createCaller(await ctx(['identity:read'], { userId: USER }));
    const out = await api.affiliates.myAccruals({ limit: 100 });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.beneficiaryId).toBe(USER);
    expect(out.rows[0]!.commissionAmount).toBe('10');
    // Procedure has no beneficiaryId input — foreign list refused by design (self-only).
  });

  it('empty when no durable rows (does not invent rates or commissions)', async () => {
    const { router: r } = withAccruals();
    const api = r.createCaller(await ctx(['identity:read'], { userId: USER }));
    const out = await api.affiliates.myAccruals({ limit: 100 });
    expect(out.rows).toEqual([]);
  });

  it('requires identity:read', async () => {
    const { router: r } = withAccruals();
    const api = r.createCaller(await ctx([]));
    const err = await api.affiliates.myAccruals({ limit: 100 }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('UNAUTHORIZED');
  });

  it('omit limit refuses — does not invent 100', async () => {
    const { router: r } = withAccruals();
    const api = r.createCaller(await ctx(['identity:read'], { userId: USER }));
    const omitted = await (api.affiliates.myAccruals as (input?: unknown) => Promise<unknown>)().catch((e: unknown) => e);
    expect(codeOf(omitted)).toBe('BAD_REQUEST');
    const empty = await api.affiliates.myAccruals({} as never).catch((e: unknown) => e);
    expect(codeOf(empty)).toBe('BAD_REQUEST');
    const explicit = await api.affiliates.myAccruals({ limit: 100 });
    expect(explicit.rows).toEqual([]);
  });
});

// ── Slice C payout on the mount — the route, not a constructed helper ────────
//
// The engine's own suite (affiliates/payout-engine.test.ts) proves the law.
// THIS file proves an operator can actually reach it: `createIdentityRouter` is
// the same call `src/index.ts:113` makes before registering the router under
// `/trpc`, so a procedure missing here is a 404 in production. That failure has
// bitten this repo three times, which is why the surface is enumerated as well
// as called.
//
// Every assertion about value is a BALANCE READ. A tRPC code proves the request
// was rejected; only the ledger proves no money moved.

describe('affiliates.payout on the mount', () => {
  const PAYER_U = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const BENE0 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const BENE1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const FEE_EVT = 'fee-evt-mount-1';
  const ASSET_U = 'USDT';
  const CONFIRM = '55555555-5555-4555-8555-555555555555';

  /** TEST FIXTURE rates — never a source default. */
  const publishedLaw = {
    published: true as const,
    tiers: [
      { hop: 0, rate: '0.10' },
      { hop: 1, rate: '0.05' },
    ],
  };

  function accrualRow(over: Partial<CommissionRow> = {}): CommissionRow {
    return {
      feeEventId: FEE_EVT,
      beneficiaryId: BENE0,
      payerId: PAYER_U,
      hop: 0,
      rate: '0.10',
      feeAmount: '100',
      commissionAmount: '10',
      asset: ASSET_U,
      accruedAt: new Date('2026-08-09T12:00:00.000Z'),
      sourceModule: 'identity',
      ...over,
    };
  }

  /** Fee pool funded the way production funds it. */
  async function fundedLedger(): Promise<MemoryLedger> {
    const ledger = new MemoryLedger();
    await ledger.post(
      recipes.deposit({ userId: PAYER_U, assetId: ASSET_U, amount: parseAmount('1000'), rail: 'crypto-native', railRef: 'mount-seed' }),
    );
    await ledger.post(
      recipes.feeCharge({
        mode: 'asset',
        chargeId: FEE_EVT,
        userId: PAYER_U,
        module: 'identity',
        assetId: ASSET_U,
        amount: parseAmount('100'),
      }),
    );
    return ledger;
  }

  async function mounted(opts: { law?: typeof publishedLaw | undefined; ledger?: MemoryLedger } = {}) {
    const store = new MemoryAccrualStore();
    await store.saveRows([accrualRow(), accrualRow({ beneficiaryId: BENE1, hop: 1, rate: '0.05', commissionAmount: '5' })]);
    const r = createIdentityRouter(stub.auth, stub.rank, {
      registrationOpen: true,
      accruals: store,
      accrualTierLaw: opts.law,
      ledger: opts.ledger,
      freeze: { frozenIds: async () => new Set<string>() } as unknown as FreezeService,
      actionApprovals: stubActionApprovals(CONFIRM),
    });
    return { store, router: r };
  }

  const bal = async (l: MemoryLedger, ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await l.balance(ref)).amount);

  it('payout IS mounted — it appears on the same router index.ts registers', async () => {
    const { router: r } = await mounted();
    expect(Object.keys(r._def.procedures)).toContain('affiliates.payout');
  });

  it('reaching payout with no published rate refuses by CODE and moves nothing', async () => {
    const ledger = await fundedLedger();
    const { router: r } = await mounted({ law: undefined, ledger });
    const api = r.createCaller(await ctx(['admin:write'], { userId: OPERATOR }));

    const err = await api.affiliates.payout({ feeEventId: FEE_EVT }).catch((e: unknown) => e);
    // The refusal names the owner law rather than a validation complaint.
    expect(codeOf(err)).toBe('PRECONDITION_FAILED');
    expect(String((err as { message?: string }).message)).toContain('DIRECTION §8');
    expect(String((err as { message?: string }).message)).toContain('owner-only');
    // The SPECIFIC code, read off the cause — the residual alone cannot tell
    // `rates_unset` from its neighbours, so asserting the message would let the
    // unpublished-law branch be deleted while this test stayed green.
    expect((err as { cause?: { code?: string } }).cause?.code).toBe('affiliate.payout.rates_unset');
    // THE ASSERTION THAT MATTERS: the book is untouched.
    expect(await bal(ledger, houseFees('identity', ASSET_U))).toBe('100');
    expect(await bal(ledger, userAvailable(BENE0, ASSET_U))).toBe('0');
    expect(await bal(ledger, userAvailable(BENE1, ASSET_U))).toBe('0');
    expect(await bal(ledger, rewardsEngine(ASSET_U))).toBe('0');
  });

  it('the rate refusal wins over a missing feeEventId — the operator hears the real problem', async () => {
    const { router: r } = await mounted({ law: undefined });
    const api = r.createCaller(await ctx(['admin:write'], { userId: OPERATOR }));
    const err = await api.affiliates.payout({}).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('PRECONDITION_FAILED');
    expect(String((err as { message?: string }).message)).toContain('DIRECTION §8');
    // Not `affiliate.payout.invalid` — the rate gate ran first, on zero rows.
    expect((err as { cause?: { code?: string } }).cause?.code).toBe('affiliate.payout.rates_unset');
  });

  it('with a published rate the route pays the whole tree, and balances prove it', async () => {
    const ledger = await fundedLedger();
    const { router: r } = await mounted({ law: publishedLaw, ledger });
    const api = r.createCaller(await ctx(['admin:write'], { userId: OPERATOR }));

    const receipt = await api.affiliates.payout({ feeEventId: FEE_EVT, approvalId: 'appr-1', operationId: 'op-1' });
    expect(receipt.posted).toBe(true);
    expect(receipt.totalCommission).toBe('15');
    expect(receipt.confirmOperatorId).toBe(CONFIRM);

    expect(await bal(ledger, userAvailable(BENE0, ASSET_U))).toBe('10');
    expect(await bal(ledger, userAvailable(BENE1, ASSET_U))).toBe('5');
    expect(await bal(ledger, houseFees('identity', ASSET_U))).toBe('85');
    expect(await bal(ledger, rewardsEngine(ASSET_U))).toBe('0');
  });

  it('a retried request through the route pays once — distinct keys, unchanged balances', async () => {
    const ledger = await fundedLedger();
    const { router: r } = await mounted({ law: publishedLaw, ledger });
    const api = r.createCaller(await ctx(['admin:write'], { userId: OPERATOR }));

    const first = await api.affiliates.payout({ feeEventId: FEE_EVT, approvalId: 'appr-1', operationId: 'op-1' });
    const second = await api.affiliates.payout({ feeEventId: FEE_EVT, approvalId: 'appr-1', operationId: 'op-1' });

    // Distinct keys within a run, identical keys ACROSS runs — that is what makes
    // the retry a no-op. Call counts would prove neither.
    expect(new Set(first.idempotencyKeys).size).toBe(first.idempotencyKeys.length);
    expect(second.idempotencyKeys).toEqual(first.idempotencyKeys);
    for (const key of first.idempotencyKeys) expect(key).toContain(FEE_EVT);

    expect(await bal(ledger, userAvailable(BENE0, ASSET_U))).toBe('10'); // not 20
    expect(await bal(ledger, userAvailable(BENE1, ASSET_U))).toBe('5');
    expect(await bal(ledger, houseFees('identity', ASSET_U))).toBe('85');
  });

  it('dryRun plans without posting — nothing moves', async () => {
    const ledger = await fundedLedger();
    const { router: r } = await mounted({ law: publishedLaw, ledger });
    const api = r.createCaller(await ctx(['admin:write'], { userId: OPERATOR }));

    const plan = await api.affiliates.payout({ feeEventId: FEE_EVT, dryRun: true });
    expect(plan.posted).toBe(false);
    expect(plan.totalCommission).toBe('15');
    expect(plan.idempotencyKeys.length).toBe(4); // sweep + payout per leg

    expect(await bal(ledger, userAvailable(BENE0, ASSET_U))).toBe('0');
    expect(await bal(ledger, houseFees('identity', ASSET_U))).toBe('100');
  });

  it('a published rate with no ledger wired refuses rather than reporting a payment', async () => {
    const { router: r } = await mounted({ law: publishedLaw }); // no ledger
    const api = r.createCaller(await ctx(['admin:write'], { userId: OPERATOR }));
    const err = await api.affiliates.payout({ feeEventId: FEE_EVT }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('PRECONDITION_FAILED');
    expect(String((err as { message?: string }).message)).toContain('no ledger client');
  });

  it('an unknown fee event refuses instead of reporting a paid zero', async () => {
    const ledger = await fundedLedger();
    const { router: r } = await mounted({ law: publishedLaw, ledger });
    const api = r.createCaller(await ctx(['admin:write'], { userId: OPERATOR }));
    const err = await api.affiliates.payout({ feeEventId: 'fee-evt-that-never-happened' }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('PRECONDITION_FAILED');
    expect(await bal(ledger, rewardsEngine(ASSET_U))).toBe('0');
  });

  it('posting without a distinct confirmOperatorId refuses and moves nothing', async () => {
    const ledger = await fundedLedger();
    const { router: r } = await mounted({ law: publishedLaw, ledger });
    const api = r.createCaller(await ctx(['admin:write'], { userId: OPERATOR }));

    const missing = await api.affiliates.payout({ feeEventId: FEE_EVT }).catch((e: unknown) => e);
    expect(codeOf(missing)).toBe('PRECONDITION_FAILED');
    expect(String((missing as { message?: string }).message)).toMatch(/typed-in second name|approvalId/);
    expect((missing as { cause?: { code?: string } }).cause?.code).toBe('action_approval.missing');

    const same = await api.affiliates.payout({ feeEventId: FEE_EVT, confirmOperatorId: OPERATOR }).catch((e: unknown) => e);
    expect(codeOf(same)).toBe('PRECONDITION_FAILED');
    expect((same as { cause?: { code?: string } }).cause?.code).toBe('action_approval.missing');

    expect(await bal(ledger, userAvailable(BENE0, ASSET_U))).toBe('0');
    expect(await bal(ledger, houseFees('identity', ASSET_U))).toBe('100');
  });

  it('posting without MFA refuses and moves nothing', async () => {
    const ledger = await fundedLedger();
    const { router: r } = await mounted({ law: publishedLaw, ledger });
    const api = r.createCaller(await ctx(['admin:write'], { userId: OPERATOR, mfa: false }));

    const err = await api.affiliates.payout({ feeEventId: FEE_EVT, approvalId: 'appr-1', operationId: 'op-1' }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('UNAUTHORIZED');
    expect(await bal(ledger, userAvailable(BENE0, ASSET_U))).toBe('0');
    expect(await bal(ledger, houseFees('identity', ASSET_U))).toBe('100');
  });

  it('payout requires admin:write — a read scope cannot move value', async () => {
    const ledger = await fundedLedger();
    const { router: r } = await mounted({ law: publishedLaw, ledger });
    const api = r.createCaller(await ctx(['admin:read'], { userId: OPERATOR }));

    const err = await api.affiliates.payout({ feeEventId: FEE_EVT }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
    expect(await bal(ledger, userAvailable(BENE0, ASSET_U))).toBe('0');
  });

  it('an anonymous caller cannot reach payout, and no balance changes', async () => {
    const ledger = await fundedLedger();
    const { router: r } = await mounted({ law: publishedLaw, ledger });
    const api = r.createCaller(await ctx([]));

    const err = await api.affiliates.payout({ feeEventId: FEE_EVT }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('UNAUTHORIZED');
    expect(await bal(ledger, userAvailable(BENE0, ASSET_U))).toBe('0');
  });
});

// ── D26-P1-O2 accrual tree under rate authority on the mount ─────────────────

describe('affiliates.accrue / accrueDryRun under rate authority (D26-P1-O2)', () => {
  const PAYER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const BENE0 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const FEE = 'fee-evt-o2-mount';

  const publishedLaw = {
    published: true as const,
    tiers: [{ hop: 0, rate: '0.10' }],
  };

  function mounted(opts: { law?: typeof publishedLaw | undefined } = {}) {
    const parent = new Map<string, string>([[PAYER, BENE0]]);
    const referral = {
      loadParentMap: async () => parent,
      attribute: async () => ({ ok: true }),
      getReferrer: async () => null,
      listDownline: async () => [],
      treeBoard: async () => ({
        edges: 1,
        referrers: 1,
        maxDepth: 1,
        frozenCount: 0,
        maxDepthCap: 5,
      }),
      members: async () => [],
    } as unknown as import('./affiliates/referral-service.js').ReferralService;
    const freeze = {
      frozenIds: async () => new Set<string>(),
      list: async () => [],
      freeze: async () => {
        throw new Error('unused');
      },
      unfreeze: async () => {
        throw new Error('unused');
      },
    } as unknown as import('./affiliates/freeze-service.js').FreezeService;
    const store = new MemoryAccrualStore();
    const r = createIdentityRouter(stub.auth, stub.rank, {
      registrationOpen: true,
      referral,
      freeze,
      accruals: store,
      accrualTierLaw: opts.law,
      actionApprovals: stubActionApprovals(CONFIRM_KYC),
    });
    return { store, router: r };
  }

  it('accrue + accrueDryRun are mounted', async () => {
    const { router: r } = mounted();
    expect(Object.keys(r._def.procedures)).toContain('affiliates.accrue');
    expect(Object.keys(r._def.procedures)).toContain('affiliates.accrueDryRun');
  });

  it('accrueDryRun with unpublished law and no tiers refuses rates_unset', async () => {
    const { router: r } = mounted({ law: undefined });
    const api = r.createCaller(await ctx(['admin:read'], { userId: OPERATOR }));
    const err = await api.affiliates
      .accrueDryRun({ feeEventId: FEE, userId: PAYER, feeAmount: '100', asset: 'USDT' })
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('PRECONDITION_FAILED');
    expect((err as { cause?: { code?: string } }).cause?.code).toBe('affiliate.accrual.rates_unset');
    expect(String((err as { message?: string }).message)).toContain('DIRECTION §8');
  });

  it('durable accrue with per-call tiers invent_refused — store stays empty', async () => {
    const { store, router: r } = mounted({ law: publishedLaw });
    const api = r.createCaller(await ctx(['admin:write'], { userId: OPERATOR }));
    const err = await api.affiliates
      .accrue({
        feeEventId: FEE,
        userId: PAYER,
        feeAmount: '100',
        asset: 'USDT',
        tiers: [{ hop: 0, rate: '0.99' }],
      })
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('PRECONDITION_FAILED');
    expect((err as { cause?: { code?: string } }).cause?.code).toBe('affiliate.accrual.invent_refused');
    expect(await store.listByFeeEvent(FEE)).toEqual([]);
  });

  it('durable accrue under published law walks the tree and persists decimal rows', async () => {
    const { store, router: r } = mounted({ law: publishedLaw });
    const api = r.createCaller(await ctx(['admin:write'], { userId: OPERATOR }));
    const out = await api.affiliates.accrue({
      feeEventId: FEE,
      userId: PAYER,
      feeAmount: '100',
      asset: 'USDT',
      sourceModule: 'trade',
    });
    expect(out.inserted).toBe(1);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({
      beneficiaryId: BENE0,
      rate: '0.10',
      commissionAmount: '10',
      sourceModule: 'trade',
    });
    const stored = await store.listByFeeEvent(FEE);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.commissionAmount).toBe('10');
  });

  it('dry-run simulation tiers allowed when law unpublished (not durable invent)', async () => {
    const { router: r } = mounted({ law: undefined });
    const api = r.createCaller(await ctx(['admin:read'], { userId: OPERATOR }));
    const out = await api.affiliates.accrueDryRun({
      feeEventId: FEE,
      userId: PAYER,
      feeAmount: '50',
      asset: 'USDT',
      tiers: [{ hop: 0, rate: '0.20' }],
    });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.commissionAmount).toBe('10');
  });

  it('treeStatus surfaces rate authority without inventing commission percentages', async () => {
    const unpublished = mounted({ law: undefined }).router.createCaller(await ctx(['admin:read'], { userId: OPERATOR }));
    const dark = await unpublished.affiliates.treeStatus();
    expect(dark.rateAuthorityPublished).toBe(false);
    expect(dark.rateAuthorityStatusLine).toBe('authority=0 published=0 tiers=0');

    const published = mounted({ law: publishedLaw }).router.createCaller(await ctx(['admin:read'], { userId: OPERATOR }));
    const lit = await published.affiliates.treeStatus();
    expect(lit.rateAuthorityPublished).toBe(true);
    expect(lit.rateAuthorityStatusLine).toBe('authority=1 published=1 tiers=1');
    // Never leak the owner rate string into the ops board.
    expect(lit.rateAuthorityStatusLine).not.toContain('0.10');
  });
});

// ── §10 KYC document vault on the tRPC boundary ──────────────────────────────

describe('kyc document procedures — meta only, no free cross-user bytes', () => {
  const DOC_USER = USER;
  const OTHER = '99999999-9999-4999-8999-999999999999';

  function vaultRouter(
    bind?: (input: BindProviderRefInput) => Promise<BindProviderRefResult>,
    reviews: Map<string, DocumentReview> = new Map(),
  ) {
    const store = new MemoryKycDocumentStore(randomBytes(32).toString('base64'));
    const asked: Array<{ userId: string; ids: readonly string[] }> = [];
    const r = createIdentityRouter(stub.auth, stub.rank, {
      registrationOpen: true,
      kycDocs: store,
      bindKycProviderRef: bind,
      kycDocumentReviews: async (userId, ids) => {
        asked.push({ userId, ids });
        return reviews;
      },
      actionApprovals: stubActionApprovals(CONFIRM_KYC),
    });
    return { store, r, asked };
  }

  it('storeDocument requires admin:compliance + MFA and returns meta only', async () => {
    const { r } = vaultRouter();
    const user = r.createCaller(await ctx(['identity:write'], { userId: DOC_USER }));
    expect(
      codeOf(
        await user.kyc
          .storeDocument({
            userId: DOC_USER,
            contentType: 'image/jpeg',
            bytesBase64: Buffer.from('scan').toString('base64'),
          })
          .catch((e: unknown) => e),
      ),
    ).toBe('FORBIDDEN');

    const noMfa = r.createCaller(await ctx(['admin:compliance'], { userId: OPERATOR, mfa: false }));
    expect(
      codeOf(
        await noMfa.kyc
          .storeDocument({
            userId: DOC_USER,
            contentType: 'image/jpeg',
            bytesBase64: Buffer.from('scan').toString('base64'),
          })
          .catch((e: unknown) => e),
      ),
    ).toBe('UNAUTHORIZED');

    const op = r.createCaller(await ctx(['admin:compliance'], { userId: OPERATOR, mfa: true }));
    const meta = await op.kyc.storeDocument({
      userId: DOC_USER,
      contentType: 'image/jpeg',
      bytesBase64: Buffer.from('passport-bytes').toString('base64'),
      ...kycDual,
    });
    expect(meta.userId).toBe(DOC_USER);
    expect(meta.contentType).toBe('image/jpeg');
    expect(meta.byteLength).toBe(Buffer.byteLength('passport-bytes'));
    expect(meta.storedBy).toBe(OPERATOR);
    expect(meta).not.toHaveProperty('bytes');
    expect(meta).not.toHaveProperty('bytesBase64');
    expect(meta).not.toHaveProperty('ciphertext');
  });

  it('storeDocument without a distinct confirmOperatorId refuses and does not put', async () => {
    const { r, store } = vaultRouter();
    const op = r.createCaller(await ctx(['admin:compliance'], { userId: OPERATOR, mfa: true }));
    const bytes = {
      userId: DOC_USER,
      contentType: 'image/jpeg',
      bytesBase64: Buffer.from('scan').toString('base64'),
    };

    const missing = await op.kyc.storeDocument(bytes).catch((e: unknown) => e);
    expect(codeOf(missing)).toBe('PRECONDITION_FAILED');
    expect(String((missing as { message?: string }).message)).toMatch(/typed-in second name|approvalId/);
    expect((missing as { cause?: { code?: string } }).cause?.code).toBe('action_approval.missing');

    const same = await op.kyc.storeDocument({ ...bytes, confirmOperatorId: OPERATOR }).catch((e: unknown) => e);
    expect(codeOf(same)).toBe('PRECONDITION_FAILED');
    expect((same as { cause?: { code?: string } }).cause?.code).toBe('action_approval.missing');

    expect(await store.listMetaForUser(DOC_USER, 200)).toEqual([]);
  });

  it.each(['eA==!', 'eA', 'eA===', 'e A==', 'eB=='])(
    'storeDocument rejects noncanonical base64 %s before storing bytes',
    async (bytesBase64) => {
      const { r, store } = vaultRouter();
      const op = r.createCaller(await ctx(['admin:compliance'], { userId: OPERATOR, mfa: true }));
      const result = await op.kyc
        .storeDocument({ userId: DOC_USER, contentType: 'image/png', bytesBase64, ...kycDual })
        .catch((error: unknown) => error);
      expect(codeOf(result)).toBe('BAD_REQUEST');
      expect(await store.listMetaForUser(DOC_USER, 200)).toEqual([]);
    },
  );

  it('listDocuments is compliance-only and never includes foreign users or bytes', async () => {
    const { r, store } = vaultRouter();
    await store.put({ userId: DOC_USER, contentType: 'image/png', bytes: Buffer.from('a') });
    await store.put({ userId: OTHER, contentType: 'image/png', bytes: Buffer.from('b') });

    const user = r.createCaller(await ctx(['identity:read'], { userId: DOC_USER }));
    expect(codeOf(await user.kyc.listDocuments({ userId: DOC_USER, limit: 200 }).catch((e: unknown) => e))).toBe('FORBIDDEN');

    const op = r.createCaller(await ctx(['admin:compliance'], { userId: OPERATOR }));
    const list = await op.kyc.listDocuments({ userId: DOC_USER, limit: 200 });
    expect(list).toHaveLength(1);
    expect(list[0]!.userId).toBe(DOC_USER);
    expect(list[0]).not.toHaveProperty('bytes');
    expect(list[0]).toMatchObject({ reviewStatus: 'not_attached', reviewRecordId: null, reviewTier: null });
  });

  const KYC_RECORD = '77777777-7777-4777-8777-777777777777';

  it('listDocuments gives each document the review of the KYC record attached to it, asking only for this subject', async () => {
    const reviews = new Map<string, DocumentReview>();
    const { r, store, asked } = vaultRouter(undefined, reviews);
    const bound = await store.put({ userId: DOC_USER, contentType: 'image/png', bytes: Buffer.from('a') });
    const loose = await store.put({ userId: DOC_USER, contentType: 'application/pdf', bytes: Buffer.from('b') });
    reviews.set(bound.id, { recordId: KYC_RECORD, tier: 'full', status: 'pending' });
    const op = r.createCaller(await ctx(['admin:compliance'], { userId: OPERATOR }));
    const list = await op.kyc.listDocuments({ userId: DOC_USER, limit: 200 });
    expect(asked).toEqual([{ userId: DOC_USER, ids: expect.arrayContaining([bound.id, loose.id]) }]);
    expect(list.find((d) => d.id === bound.id)).toMatchObject({ reviewStatus: 'pending', reviewRecordId: KYC_RECORD, reviewTier: 'full' });
    expect(list.find((d) => d.id === loose.id)).toMatchObject({ reviewStatus: 'not_attached', reviewRecordId: null });
  });

  it('listDocuments refuses closed when the vault is wired without its review lookup', async () => {
    const store = new MemoryKycDocumentStore(randomBytes(32).toString('base64'));
    await store.put({ userId: DOC_USER, contentType: 'image/png', bytes: Buffer.from('a') });
    const r = createIdentityRouter(stub.auth, stub.rank, { registrationOpen: true, kycDocs: store });
    const op = r.createCaller(await ctx(['admin:compliance'], { userId: OPERATOR }));
    const refused = await op.kyc.listDocuments({ userId: DOC_USER, limit: 200 }).catch((e: unknown) => e);
    expect(codeOf(refused)).toBe('PRECONDITION_FAILED');
    expect(String((refused as Error).message)).toMatch(/kyc_doc\.reviews_unwired/);
  });

  it('bindDocument refuses when vault bind is unwired; succeeds with opaque pointer only', async () => {
    const unwired = createIdentityRouter(stub.auth, stub.rank, {
      registrationOpen: true,
      kycDocs: new MemoryKycDocumentStore(randomBytes(32).toString('base64')),
      actionApprovals: stubActionApprovals(CONFIRM_KYC),
    });
    const opUnwired = unwired.createCaller(await ctx(['admin:compliance'], { userId: OPERATOR, mfa: true }));
    expect(
      codeOf(
        await opUnwired.kyc
          .bindDocument({ recordId: RECORD, documentId: '55555555-5555-4555-8555-555555555555', ...kycDual })
          .catch((e: unknown) => e),
      ),
    ).toBe('PRECONDITION_FAILED');

    const docId = '55555555-5555-4555-8555-555555555555';
    const bind = async (input: BindProviderRefInput): Promise<BindProviderRefResult> => ({
      recordId: input.recordId,
      userId: DOC_USER,
      providerRef: input.documentId,
      document: {
        id: input.documentId,
        userId: DOC_USER,
        contentType: 'image/jpeg',
        byteLength: 12,
        storedBy: OPERATOR,
        createdAt: new Date('2026-08-10T00:00:00.000Z'),
      },
    });
    const { r } = vaultRouter(bind);
    const op = r.createCaller(await ctx(['admin:compliance'], { userId: OPERATOR, mfa: true }));
    const bound = await op.kyc.bindDocument({ recordId: RECORD, documentId: docId, ...kycDual });
    expect(bound.providerRef).toBe(docId);
    expect(bound.document).not.toHaveProperty('bytes');
  });

  it('bindDocument without a distinct confirmOperatorId refuses and does not bind', async () => {
    const docId = '55555555-5555-4555-8555-555555555555';
    let bound = 0;
    const bind = async (input: BindProviderRefInput): Promise<BindProviderRefResult> => {
      bound += 1;
      return {
        recordId: input.recordId,
        userId: DOC_USER,
        providerRef: input.documentId,
        document: {
          id: input.documentId,
          userId: DOC_USER,
          contentType: 'image/jpeg',
          byteLength: 12,
          storedBy: OPERATOR,
          createdAt: new Date('2026-08-10T00:00:00.000Z'),
        },
      };
    };
    const { r } = vaultRouter(bind);
    const op = r.createCaller(await ctx(['admin:compliance'], { userId: OPERATOR, mfa: true }));

    const missing = await op.kyc.bindDocument({ recordId: RECORD, documentId: docId }).catch((e: unknown) => e);
    expect(codeOf(missing)).toBe('PRECONDITION_FAILED');
    expect(String((missing as { message?: string }).message)).toMatch(/typed-in second name|approvalId/);
    expect((missing as { cause?: { code?: string } }).cause?.code).toBe('action_approval.missing');

    const same = await op.kyc.bindDocument({ recordId: RECORD, documentId: docId, confirmOperatorId: OPERATOR }).catch((e: unknown) => e);
    expect(codeOf(same)).toBe('PRECONDITION_FAILED');
    expect((same as { cause?: { code?: string } }).cause?.code).toBe('action_approval.missing');

    expect(bound).toBe(0);
  });

  it('storeDocument without vault refuses closed with named kyc_doc.unwired — never invents a key', async () => {
    const r = createIdentityRouter(stub.auth, stub.rank, { registrationOpen: true, actionApprovals: stubActionApprovals(CONFIRM_KYC) });
    const op = r.createCaller(await ctx(['admin:compliance'], { userId: OPERATOR, mfa: true }));
    const err = await op.kyc
      .storeDocument({
        userId: DOC_USER,
        contentType: 'image/jpeg',
        bytesBase64: Buffer.from('x').toString('base64'),
        ...kycDual,
      })
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('PRECONDITION_FAILED');
    expect((err as { message?: string }).message).toContain('kyc_doc.unwired');
  });
});

describe('kyc.getDocument is compliance-only bytes, never a public/user read', () => {
  it('getDocument is mounted behind admin:compliance', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'router.ts'), 'utf8');
    expect(src).toMatch(/getDocument:\s*scopedProcedure\('admin:compliance'\)/);
    expect(src).toContain('vault.getFor');
    expect(src).not.toMatch(/readDocument|downloadDocument/);
    expect(src).toContain('storeDocument');
    expect(src).toContain('listDocuments');
    expect(src).toContain('bindDocument');
  });

  it('a user session cannot open document bytes', async () => {
    const store = new MemoryKycDocumentStore(randomBytes(32).toString('base64'));
    const r = createIdentityRouter(stub.auth, stub.rank, {
      registrationOpen: true,
      kycDocs: store,
      actionApprovals: stubActionApprovals(CONFIRM_KYC),
    });
    const user = r.createCaller(await ctx(['identity:read', 'identity:write'], { userId: USER }));
    const err = await user.kyc.getDocument({ documentId: '55555555-5555-4555-8555-555555555555' }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
  });

  it('getDocument without a distinct confirmOperatorId refuses and does not read', async () => {
    const store = new MemoryKycDocumentStore(randomBytes(32).toString('base64'));
    const meta = await store.put({ userId: USER, contentType: 'image/png', bytes: Buffer.from('secret-scan') });
    const r = createIdentityRouter(stub.auth, stub.rank, {
      registrationOpen: true,
      kycDocs: store,
      actionApprovals: stubActionApprovals(CONFIRM_KYC, OPERATOR),
    });
    const op = r.createCaller(await ctx(['admin:compliance'], { userId: OPERATOR, mfa: true }));

    const missing = await op.kyc.getDocument({ documentId: meta.id }).catch((e: unknown) => e);
    expect(codeOf(missing)).toBe('PRECONDITION_FAILED');
    expect(String((missing as { message?: string }).message)).toMatch(/typed-in second name|approvalId/);
    expect((missing as { cause?: { code?: string } }).cause?.code).toBe('action_approval.missing');

    const same = await op.kyc.getDocument({ documentId: meta.id, confirmOperatorId: OPERATOR }).catch((e: unknown) => e);
    expect(codeOf(same)).toBe('PRECONDITION_FAILED');
    expect((same as { cause?: { code?: string } }).cause?.code).toBe('action_approval.missing');

    const opened = await op.kyc.getDocument({ documentId: meta.id, ...kycDual });
    expect(opened.bytesBase64).toBe(Buffer.from('secret-scan').toString('base64'));
  });

  it('getDocument is opened only by the operator who asked: anyone else is refused before the approval is spent, and after', async () => {
    const store = new MemoryKycDocumentStore(randomBytes(32).toString('base64'));
    const meta = await store.put({ userId: USER, contentType: 'image/png', bytes: Buffer.from('secret-scan') });
    const spent: string[] = [];
    const consumeAsRequester = stubActionApprovals(CONFIRM_KYC, CONFIRM_KYC);
    const withParties = createIdentityRouter(stub.auth, stub.rank, {
      registrationOpen: true,
      kycDocs: store,
      actionApprovals: {
        consume: async (service, input) => {
          spent.push(input.approvalId);
          return consumeAsRequester.consume(service, input);
        },
        partiesOf: async () => ({ requesterId: CONFIRM_KYC, approverId: OPERATOR }),
      },
    });
    // The approver (OPERATOR) holds the ids and runs the read: refused, and the approval is not spent.
    const approver = withParties.createCaller(await ctx(['admin:compliance'], { userId: OPERATOR, mfa: true }));
    const before = await approver.kyc.getDocument({ documentId: meta.id, ...kycDual }).catch((e: unknown) => e);
    expect(codeOf(before)).toBe('FORBIDDEN');
    expect(String((before as Error).message)).toMatch(/kyc_doc\.reader_not_requester/);
    expect(spent).toEqual([]);

    // Without the parties read, the consumed approval still names the requester, and nobody else gets the bytes.
    const noParties = createIdentityRouter(stub.auth, stub.rank, {
      registrationOpen: true,
      kycDocs: store,
      actionApprovals: stubActionApprovals(CONFIRM_KYC, CONFIRM_KYC),
    });
    const other = noParties.createCaller(await ctx(['admin:compliance'], { userId: OPERATOR, mfa: true }));
    const after = await other.kyc.getDocument({ documentId: meta.id, ...kycDual }).catch((e: unknown) => e);
    expect(codeOf(after)).toBe('FORBIDDEN');
    expect(after).not.toHaveProperty('bytesBase64');
  });

  it('getDocument refuses a switched-off vault before the approval is spent', async () => {
    const spent: string[] = [];
    const r = createIdentityRouter(stub.auth, stub.rank, {
      registrationOpen: true,
      actionApprovals: {
        consume: async (service, input) => {
          spent.push(input.approvalId);
          return stubActionApprovals(CONFIRM_KYC, OPERATOR).consume(service, input);
        },
      },
    });
    const op = r.createCaller(await ctx(['admin:compliance'], { userId: OPERATOR, mfa: true }));
    const refused = await op.kyc.getDocument({ documentId: '55555555-5555-4555-8555-555555555555', ...kycDual }).catch((e: unknown) => e);
    expect(String((refused as Error).message)).toMatch(/kyc_doc\.unwired/);
    expect(spent).toEqual([]);
  });
});

// ── Drop 0 waitlist + referral queue ─────────────────────────────────────────

function waitlistRouter(overrides: Record<string, boolean> = {}) {
  const store = new MemoryWaitlistStore();
  const waitlist = new WaitlistService(store, { drop: '0', overrides });
  return {
    store,
    api: createIdentityRouter(stub.auth, stub.rank, { registrationOpen: true, waitlist }),
  };
}

describe('waitlist door — unbuilt / flag / operator', () => {
  it('refuses enroll with waitlist.unbuilt when the store is not wired', async () => {
    const api = createIdentityRouter(stub.auth, stub.rank, {
      registrationOpen: true,
      actionApprovals: stubActionApprovals(CONFIRM_KYC),
    }).createCaller(await ctx([]));
    const err = await api.waitlist.enroll({ email: 'ada@example.com' }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('PRECONDITION_FAILED');
    expect(String((err as { message?: string }).message)).toContain('waitlist.unbuilt');
  });

  it('enrolls publicly when the flag is on', async () => {
    const { api } = waitlistRouter();
    const out = await api.createCaller(await ctx([])).waitlist.enroll({ email: 'ada@example.com' });
    expect(out.created).toBe(true);
    expect(out.position).toBe(1);
    expect(out.referralCode).toMatch(/^[a-f0-9]{12}$/);
    expect(out.referredBy).toBeNull();
  });

  it('attaches a referral on a later enroll and refuses a different one', async () => {
    const { api } = waitlistRouter();
    const caller = api.createCaller(await ctx([]));
    const ref = await caller.waitlist.enroll({ email: 'ref@example.com' });
    const other = await caller.waitlist.enroll({ email: 'other@example.com' });
    const first = await caller.waitlist.enroll({ email: 'ada@example.com' });
    const attached = await caller.waitlist.enroll({ email: 'ada@example.com', referralCode: ref.referralCode });
    expect(attached.created).toBe(false);
    expect(attached.position).toBe(first.position);
    expect(attached.referredBy).toBe(ref.referralCode);
    const err = await caller.waitlist.enroll({ email: 'ada@example.com', referralCode: other.referralCode }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('CONFLICT');
    expect(String((err as { message?: string }).message)).toContain('[waitlist.referral_locked]');
    expect(String((err as { message?: string }).message)).toContain('already has a referral code');
  });

  it('refuses enroll when waitlist.enabled is off — no silent capture', async () => {
    const { api, store } = waitlistRouter({ 'waitlist.enabled': false });
    const err = await api
      .createCaller(await ctx([]))
      .waitlist.enroll({ email: 'ada@example.com' })
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('PRECONDITION_FAILED');
    expect(String((err as { message?: string }).message)).toContain('flag.waitlist.enabled.disabled');
    expect(await store.count()).toBe(0);
  });

  it('refuses a referral code when referral.queue is off — does not discard it', async () => {
    const store = new MemoryWaitlistStore();
    const open = new WaitlistService(store, { drop: '0' });
    const ref = await open.enroll({ email: 'ref@example.com' });
    const closed = new WaitlistService(store, { drop: '0', overrides: { 'referral.queue': false } });
    const api = createIdentityRouter(stub.auth, stub.rank, { registrationOpen: true, waitlist: closed });
    const err = await api
      .createCaller(await ctx([]))
      .waitlist.enroll({ email: 'ada@example.com', referralCode: ref.entry.referralCode })
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('PRECONDITION_FAILED');
    expect(String((err as { message?: string }).message)).toContain('flag.referral.queue.disabled');
    expect(await store.getByEmail('ada@example.com')).toBeNull();
  });

  it('list requires admin:read', async () => {
    const { api } = waitlistRouter();
    const err = await api
      .createCaller(await ctx([]))
      .waitlist.list({ limit: 10, offset: 0 })
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('UNAUTHORIZED');
    const userErr = await api
      .createCaller(await ctx(['identity:read']))
      .waitlist.list({ limit: 10, offset: 0 })
      .catch((e: unknown) => e);
    expect(codeOf(userErr)).toBe('FORBIDDEN');
  });

  it('lists FIFO for admin:read including email', async () => {
    const { api } = waitlistRouter();
    const publicApi = api.createCaller(await ctx([]));
    await publicApi.waitlist.enroll({ email: 'a@example.com' });
    await publicApi.waitlist.enroll({ email: 'b@example.com' });
    const list = await api.createCaller(await ctx(['admin:read'], { userId: OPERATOR })).waitlist.list({
      limit: 10,
      offset: 0,
    });
    expect(list.total).toBe(2);
    expect(list.entries.map((e) => e.email)).toEqual(['a@example.com', 'b@example.com']);
  });

  it('waitlist.list omit limit refuses — does not invent 50', async () => {
    const { api, store } = waitlistRouter();
    await api.createCaller(await ctx([])).waitlist.enroll({ email: 'a@example.com' });
    const admin = api.createCaller(await ctx(['admin:read'], { userId: OPERATOR }));
    const omitted = await (admin.waitlist.list as (input?: unknown) => Promise<unknown>)().catch((e: unknown) => e);
    expect(codeOf(omitted)).toBe('BAD_REQUEST');
    const empty = await admin.waitlist.list({ offset: 0 } as never).catch((e: unknown) => e);
    expect(codeOf(empty)).toBe('BAD_REQUEST');
    const explicit = await admin.waitlist.list({ limit: 50, offset: 0 });
    expect(explicit.total).toBe(1);
    expect(explicit.entries).toHaveLength(1);
    expect(await store.count()).toBe(1);
  });
});

// ── Referral-ranked waves (RC-campaigns-03) ─────────────────────────────────

describe('waitlist waves — rank on the public read, second-person release', () => {
  function wavesRouter(waveSize: number | undefined, approvals?: Parameters<typeof createIdentityRouter>[2]['actionApprovals']) {
    const store = new MemoryWaitlistStore();
    const waitlist = new WaitlistService(store, { drop: '0' }, waveSize);
    const api = createIdentityRouter(stub.auth, stub.rank, { registrationOpen: true, waitlist, actionApprovals: approvals });
    return { api, store };
  }

  async function seed(api: ReturnType<typeof createIdentityRouter>) {
    const pub = api.createCaller(await ctx([]));
    const a = await pub.waitlist.enroll({ email: 'a@example.com' });
    const b = await pub.waitlist.enroll({ email: 'b@example.com' });
    const c = await pub.waitlist.enroll({ email: 'c@example.com' });
    await pub.waitlist.enroll({ email: 'c1@example.com', referralCode: c.referralCode });
    return { pub, a, b, c };
  }

  it('the public position read shows the rank: a referral moves its referrer up', async () => {
    const { api } = wavesRouter(2);
    const { pub, a, c } = await seed(api);
    expect(await pub.waitlist.position({ referralCode: c.referralCode })).toMatchObject({ position: 3, rank: 1, release: null });
    expect(await pub.waitlist.position({ referralCode: a.referralCode })).toMatchObject({ position: 1, rank: 2, waiting: 4 });
  });

  it('release without an approval refuses action_approval.missing and releases nobody', async () => {
    const consumed: unknown[] = [];
    const { api } = wavesRouter(2, {
      async consume(service, input) {
        consumed.push(input);
        return stubActionApprovals().consume(service, input);
      },
    });
    const { pub, c } = await seed(api);
    const op = api.createCaller(await ctx(['admin:write'], { userId: OPERATOR }));
    const err = await op.waitlist.waves.release({ waveNumber: 1 }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('PRECONDITION_FAILED');
    expect(String((err as { message?: string }).message)).toContain('action_approval.missing');
    expect((await pub.waitlist.position({ referralCode: c.referralCode })).release).toBeNull();
    expect(consumed).toEqual([]);
  });

  it('release needs admin:write and a second factor', async () => {
    const { api } = wavesRouter(2, stubActionApprovals());
    await seed(api);
    const reader = api.createCaller(await ctx(['admin:read'], { userId: OPERATOR }));
    expect(codeOf(await reader.waitlist.waves.release({ waveNumber: 1, approvalId: 'a', operationId: 'o' }).catch((e: unknown) => e))).toBe(
      'FORBIDDEN',
    );
    const noMfa = api.createCaller(await ctx(['admin:write'], { userId: OPERATOR, mfa: false }));
    const mfaErr = await noMfa.waitlist.waves.release({ waveNumber: 1, approvalId: 'a', operationId: 'o' }).catch((e: unknown) => e);
    expect(String((mfaErr as { message?: string }).message)).toContain('two-factor');
    const user = api.createCaller(await ctx(['identity:read']));
    expect(codeOf(await user.waitlist.waves.list().catch((e: unknown) => e))).toBe('FORBIDDEN');
  });

  it('an approved release binds wave and size, releases the top N once and shows on the position read', async () => {
    const consumed: Array<{ targetId: string; payloadHash: string }> = [];
    const { api } = wavesRouter(2, {
      async consume(service, input) {
        consumed.push(input);
        return stubActionApprovals().consume(service, input);
      },
    });
    const { pub, a, b, c } = await seed(api);
    const op = api.createCaller(await ctx(['admin:write', 'admin:read'], { userId: OPERATOR }));
    expect(await op.waitlist.waves.list()).toMatchObject({ waveSize: 2, nextWave: 1, waiting: 4, waves: [] });
    const out = await op.waitlist.waves.release({ waveNumber: 1, approvalId: 'appr-1', operationId: 'op-1' });
    expect(out).toMatchObject({ created: true, wave: { waveNumber: 1, size: 2, releasedCount: 2, releasedBy: OPERATOR } });
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({
      targetId: 'waitlist.wave.release',
      payloadHash: identityActionPayloadHash('waitlist.wave.release', { wave: '1', size: '2' }),
    });
    const again = await op.waitlist.waves.release({ waveNumber: 1, approvalId: 'appr-1', operationId: 'op-1' });
    expect(again.created).toBe(false);
    expect(consumed).toHaveLength(1);
    expect(await pub.waitlist.position({ referralCode: c.referralCode })).toMatchObject({ rank: null, release: { waveNumber: 1 } });
    expect(await pub.waitlist.position({ referralCode: a.referralCode })).toMatchObject({ rank: null, release: { waveNumber: 1 } });
    expect(await pub.waitlist.position({ referralCode: b.referralCode })).toMatchObject({ rank: 1, release: null });
  });

  it('a blank wave size refuses drop.wave_unset before the approval is spent', async () => {
    const consumed: unknown[] = [];
    const { api } = wavesRouter(undefined, {
      async consume(service, input) {
        consumed.push(input);
        return stubActionApprovals().consume(service, input);
      },
    });
    const { pub, c } = await seed(api);
    const op = api.createCaller(await ctx(['admin:write', 'admin:read'], { userId: OPERATOR }));
    expect((await op.waitlist.waves.list()).waveSize).toBeNull();
    const err = await op.waitlist.waves.release({ waveNumber: 1, approvalId: 'appr-1', operationId: 'op-1' }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('PRECONDITION_FAILED');
    expect(String((err as { message?: string }).message)).toContain('[drop.wave_unset]');
    expect(consumed).toEqual([]);
    expect((await pub.waitlist.position({ referralCode: c.referralCode })).release).toBeNull();
  });
});

// ── Affiliates share tokens (ops.social-promotion) ───────────────────────────

describe('affiliates createShare / revokeShare / shareHits', () => {
  const VISITOR = '99999999-9999-4999-8999-999999999999';

  function shareRouter() {
    const store = new MemoryShareStore();
    store.rememberUser(USER);
    const attributeCalls: Array<{ userId: string; referrerId: string }> = [];
    const share = {
      createShare: async (referrerId: string) => store.createShare(referrerId),
      revokeShare: async (referrerId: string) => store.revokeShare(referrerId),
      shareHits: async (token: string) => store.shareHits(token),
      referrerOf: async (token: string) => store.referrerOf(token),
    } as unknown as import('./affiliates/share-service.js').ShareService;
    const referral = {
      attribute: async (input: { userId: string; referrerId: string }) => {
        attributeCalls.push(input);
        return { userId: input.userId, referrerId: input.referrerId, attributedAt: new Date() };
      },
    } as unknown as import('./affiliates/referral-service.js').ReferralService;
    return {
      api: createIdentityRouter(stub.auth, stub.rank, { registrationOpen: true, share, referral }),
      store,
      attributeCalls,
    };
  }

  it('createShare requires identity:write', async () => {
    const { api } = shareRouter();
    const err = await api
      .createCaller(await ctx([]))
      .affiliates.createShare()
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('UNAUTHORIZED');
  });

  it('Share → URL token; signed-out hit +1; signed-in attributes via affiliates.attribute', async () => {
    const { api, attributeCalls } = shareRouter();
    const owner = api.createCaller(await ctx(['identity:write']));
    const created = await owner.affiliates.createShare();
    expect(created.referrerId).toBe(USER);
    expect(created.hits).toBe(0);

    const anon = api.createCaller(await ctx([]));
    const hit = await anon.affiliates.shareHits({ token: created.token });
    expect(hit.hits).toBe(1);
    expect(hit.attributed).toBe(false);
    expect(attributeCalls).toHaveLength(0);

    const visitor = api.createCaller(await ctx(['identity:write'], { userId: VISITOR }));
    const attributed = await visitor.affiliates.shareHits({ token: created.token });
    expect(attributed.hits).toBe(2);
    expect(attributed.attributed).toBe(true);
    expect(attributeCalls).toEqual([{ userId: VISITOR, referrerId: USER }]);
  });

  it('revokeShare then shareHits refuses and does not attribute', async () => {
    const { api, attributeCalls } = shareRouter();
    const owner = api.createCaller(await ctx(['identity:write']));
    const created = await owner.affiliates.createShare();
    await owner.affiliates.revokeShare();
    const visitor = api.createCaller(await ctx(['identity:write'], { userId: VISITOR }));
    const err = await visitor.affiliates.shareHits({ token: created.token }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
    expect((err as { message?: string }).message).toContain('share.revoked');
    expect(attributeCalls).toHaveLength(0);
  });

  it('the link owner opening their own link is refused (referral.self) and counts no visit', async () => {
    const { api, attributeCalls } = shareRouter();
    const owner = api.createCaller(await ctx(['identity:write']));
    const created = await owner.affiliates.createShare();
    const err = await owner.affiliates.shareHits({ token: created.token }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('CONFLICT');
    expect(((err as { cause?: { code?: string } }).cause ?? {}).code).toBe('referral.self');
    expect(attributeCalls).toHaveLength(0);
    expect((await owner.affiliates.createShare()).hits).toBe(0);
  });

  it('a link attach runs under the owner attach window; same referrer again is the same relationship', async () => {
    const store = new MemoryShareStore();
    store.rememberUser(USER);
    const OTHER_REF = '88888888-8888-4888-8888-888888888888';
    store.rememberUser(OTHER_REF);
    const edges = new Map<string, string>();
    const windows: Array<number | undefined> = [];
    const share = {
      createShare: async (referrerId: string) => store.createShare(referrerId),
      shareHits: async (token: string) => store.shareHits(token),
      referrerOf: async (token: string) => store.referrerOf(token),
    } as unknown as import('./affiliates/share-service.js').ShareService;
    const referral = {
      attribute: async (input: { userId: string; referrerId: string }, late?: { windowSeconds: number | undefined }) => {
        windows.push(late?.windowSeconds);
        if (edges.has(input.userId)) throw new ReferralError('Referral already set for this user', 'referral.already_set');
        edges.set(input.userId, input.referrerId);
        return { userId: input.userId, referrerId: input.referrerId, attributedAt: new Date() };
      },
      edgeOf: async (userId: string) => (edges.has(userId) ? { userId, referrerId: edges.get(userId)!, attributedAt: new Date() } : null),
    } as unknown as import('./affiliates/referral-service.js').ReferralService;
    const api = createIdentityRouter(stub.auth, stub.rank, { registrationOpen: true, share, referral, referralAttachWindowSeconds: 600 });
    const mine = await api.createCaller(await ctx(['identity:write'])).affiliates.createShare();
    const theirs = await api.createCaller(await ctx(['identity:write'], { userId: OTHER_REF })).affiliates.createShare();
    const visitor = api.createCaller(await ctx(['identity:write'], { userId: VISITOR }));

    expect((await visitor.affiliates.shareHits({ token: mine.token })).attributed).toBe(true);
    expect((await visitor.affiliates.shareHits({ token: mine.token })).attributed).toBe(true);
    const err = await visitor.affiliates.shareHits({ token: theirs.token }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('CONFLICT');
    expect(((err as { cause?: { code?: string } }).cause ?? {}).code).toBe('referral.already_set');
    expect(edges.get(VISITOR)).toBe(USER);
    expect(windows).toEqual([600, 600, 600]);
  });

  it('attachWindow reads unset while the owner window is blank, and open or closed from the account age', async () => {
    const created = new Date(Date.now() - 120_000);
    const referral = {
      accountAge: async () => ({ createdAt: created, now: new Date() }),
    } as unknown as import('./affiliates/referral-service.js').ReferralService;
    const unset = createIdentityRouter(stub.auth, stub.rank, { registrationOpen: true, referral });
    expect(await unset.createCaller(await ctx(['identity:read'])).affiliates.attachWindow()).toMatchObject({
      state: 'unset',
      windowSeconds: null,
      closesAt: null,
    });
    const short = createIdentityRouter(stub.auth, stub.rank, { registrationOpen: true, referral, referralAttachWindowSeconds: 60 });
    expect((await short.createCaller(await ctx(['identity:read'])).affiliates.attachWindow()).state).toBe('closed');
    const long = createIdentityRouter(stub.auth, stub.rank, { registrationOpen: true, referral, referralAttachWindowSeconds: 600 });
    expect(await long.createCaller(await ctx(['identity:read'])).affiliates.attachWindow()).toMatchObject({
      state: 'open',
      windowSeconds: 600,
      closesAt: new Date(created.getTime() + 600_000).toISOString(),
    });
  });

  it('attachWindow runs again from a lapsed relationship (reopenedAt), measured from the lapse, not sign-up', async () => {
    const reopened = new Date(Date.now() - 60_000);
    const referral = {
      accountAge: async () => ({ createdAt: new Date(Date.now() - 86_400_000), reopenedAt: reopened, now: new Date() }),
    } as unknown as import('./affiliates/referral-service.js').ReferralService;
    const api = createIdentityRouter(stub.auth, stub.rank, { registrationOpen: true, referral, referralAttachWindowSeconds: 600 });
    expect(await api.createCaller(await ctx(['identity:read'])).affiliates.attachWindow()).toMatchObject({
      state: 'open',
      reopenedAt: reopened.toISOString(),
      closesAt: new Date(reopened.getTime() + 600_000).toISOString(),
    });
  });

  it('myLapse reads the caller only and invents no end date while the period is blank; the lapse log needs an operator with a second factor', async () => {
    const at = new Date('2026-10-24T03:00:00Z');
    const ended = { userId: USER, referrerId: VISITOR, attributedAt: at, lastActivityAt: at, periodSeconds: 600, lapsedAt: at };
    const asked: string[] = [];
    const referralLapse = {
      standingOf: async (userId: string) => {
        asked.push(userId);
        return { state: 'unset' as const };
      },
      latestOf: async () => ended,
      log: async () => [ended],
    } as unknown as import('./affiliates/referral-lapse.js').ReferralLapseService;
    const api = createIdentityRouter(stub.auth, stub.rank, { registrationOpen: true, referralLapse });
    const mine = await api.createCaller(await ctx(['identity:read'])).affiliates.myLapse();
    expect(mine).toEqual({
      state: 'unset',
      periodSeconds: null,
      lastActivityAt: null,
      endsAt: null,
      ended: { ...ended, attributedAt: at.toISOString(), lastActivityAt: at.toISOString(), lapsedAt: at.toISOString() },
    });
    expect(asked).toEqual([USER]);
    const customer = api.createCaller(await ctx(['identity:read']));
    expect(codeOf(await customer.affiliates.lapseLog({ limit: 10 }).catch((e: unknown) => e))).toBe('FORBIDDEN');
    const noFactor = api.createCaller(await ctx(['admin:compliance'], { userId: OPERATOR, mfa: false }));
    expect(codeOf(await noFactor.affiliates.lapseLog({ limit: 10 }).catch((e: unknown) => e))).toBe('UNAUTHORIZED');
    const operator = api.createCaller(await ctx(['admin:compliance'], { userId: OPERATOR }));
    expect(await operator.affiliates.lapseLog({ limit: 10 })).toHaveLength(1);
  });

  it('createCode refuses with referral.code_length_unset while the owner length is blank', async () => {
    const referralCodes = new (await import('./affiliates/referral-code.js')).ReferralCodeService(
      { unsafe: () => undefined } as never,
      undefined,
    );
    referralCodes.codeOf = async () => null;
    const api = createIdentityRouter(stub.auth, stub.rank, { registrationOpen: true, referralCodes });
    const err = await api
      .createCaller(await ctx(['identity:write']))
      .affiliates.createCode()
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('PRECONDITION_FAILED');
    expect((err as { message?: string }).message).toContain('referral.code_length_unset');
  });

  it('requestRebind names the referrer from a live link only; deciding needs an operator with a second factor', async () => {
    const { store } = shareRouter();
    const live = store.createShare(USER);
    store.rememberUser(VISITOR);
    const revoked = store.createShare(VISITOR);
    store.revokeShare(VISITOR);
    const asked: Array<[string, string, string]> = [];
    const decided: Array<[string, string, string]> = [];
    const at = new Date('2026-10-23T10:00:00Z');
    const request = (userId: string, toReferrerId: string) => ({
      id: '99999999-9999-4999-8999-999999999999',
      userId,
      fromReferrerId: null,
      toReferrerId,
      reason: 'TEST reason',
      state: 'under_review' as const,
      approvalId: 'appr-1',
      approvalExpiresAt: at,
      decidedBy: null,
      decisionReason: null,
      createdAt: at,
      decidedAt: null,
      appliedAt: null,
    });
    const referralRebind = {
      request: async (userId: string, to: string, reason: string) => {
        asked.push([userId, to, reason]);
        return request(userId, to);
      },
      decide: async (operatorId: string, id: string, decision: string) => {
        decided.push([operatorId, id, decision]);
        return { ...request(VISITOR, USER), state: 'approved' as const, decidedBy: operatorId };
      },
    } as unknown as import('./affiliates/referral-rebind.js').ReferralRebindService;
    const share = {
      referrerOf: async (token: string) => store.referrerOf(token),
    } as unknown as import('./affiliates/share-service.js').ShareService;
    const api = createIdentityRouter(stub.auth, stub.rank, { registrationOpen: true, share, referralRebind });
    const visitor = api.createCaller(await ctx(['identity:write'], { userId: VISITOR }));

    const mine = await visitor.affiliates.requestRebind({ token: live.token, reason: 'TEST reason' });
    expect(mine).toMatchObject({ state: 'under_review', toReferrerId: USER, reviewEndsAt: at.toISOString() });
    expect(mine).not.toHaveProperty('decidedBy');
    expect(asked).toEqual([[VISITOR, USER, 'TEST reason']]);
    const err = await visitor.affiliates.requestRebind({ token: revoked.token, reason: 'TEST reason' }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
    expect((err as { message?: string }).message).toContain('share.revoked');
    expect(asked).toHaveLength(1);

    const input = { requestId: mine.requestId, decision: 'approve' as const, reason: 'TEST checked' };
    expect(codeOf(await visitor.affiliates.decideRebind(input).catch((e: unknown) => e))).toBe('FORBIDDEN');
    const noFactor = api.createCaller(await ctx(['admin:compliance'], { userId: OPERATOR, mfa: false }));
    expect(codeOf(await noFactor.affiliates.decideRebind(input).catch((e: unknown) => e))).toBe('UNAUTHORIZED');
    const operator = api.createCaller(await ctx(['admin:compliance'], { userId: OPERATOR }));
    expect(await operator.affiliates.decideRebind(input)).toMatchObject({ state: 'approved', decidedBy: OPERATOR });
    expect(decided).toEqual([[OPERATOR, mine.requestId, 'approve']]);
  });

  it('signUpStart from an invitation link names its referrer for the account; a revoked link names no one', async () => {
    const { store } = shareRouter();
    const live = store.createShare(USER);
    const seen: Array<{ referrerId?: string }> = [];
    const auth = {
      ...stub.auth,
      signUpStart: async (input: { referrerId?: string }) => {
        seen.push(input);
        return { accepted: true, next: 'confirm_email', flowId: '77777777-7777-4777-8777-777777777777', resendAfterSeconds: 60 };
      },
    } as unknown as typeof stub.auth;
    const share = {
      referrerOf: async (token: string) => store.referrerOf(token),
    } as unknown as import('./affiliates/share-service.js').ShareService;
    const api = createIdentityRouter(auth, stub.rank, { registrationOpen: true, share });
    const anon = api.createCaller(await ctx([]));
    const form = {
      channel: 'email' as const,
      handle: 'friend_one',
      email: 'friend@example.com',
      password: 'a-long-test-password',
      country: 'DE',
      dateOfBirth: '1990-05-01',
      accountType: 'individual' as const,
    };
    await anon.auth.signUpStart({ ...form, inviteToken: live.token });
    store.revokeShare(USER);
    await anon.auth.signUpStart({ ...form, inviteToken: live.token });
    expect(seen.map((input) => input.referrerId)).toEqual([USER, undefined]);
    expect(seen.every((input) => !('inviteToken' in input))).toBe(true);
  });

  it('deleted profile refuses shareHits (share.profile_gone)', async () => {
    const { api, store, attributeCalls } = shareRouter();
    const owner = api.createCaller(await ctx(['identity:write']));
    const created = await owner.affiliates.createShare();
    store.forgetUser(USER);
    const err = await api
      .createCaller(await ctx([]))
      .affiliates.shareHits({ token: created.token })
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('NOT_FOUND');
    expect((err as { message?: string }).message).toContain('share.profile_gone');
    expect(attributeCalls).toHaveLength(0);
  });
});
