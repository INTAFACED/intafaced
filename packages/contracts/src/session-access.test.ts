import { describe, expect, it } from 'vitest';
import { AuthError, SESSION_SCOPES, issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { KycTier } from '@intafaced/config';
import { router, scopedProcedure, JurisdictionError, type Context } from './trpc.js';

/**
 * WHAT A REAL SESSION CAN ACTUALLY REACH.
 *
 * Every other authorisation test in the repo hands a router the scopes it wants
 * and checks the guard. That is the right test for a guard, and it is exactly
 * why nobody noticed that `bank:*` and `blueprint:*` were issued to no one:
 * every test that exercised svc-bank passed `['bank:read']` by hand, so the
 * suite proved the door worked while nobody on the platform had a key.
 *
 * So this file starts from SESSION_SCOPES — the list a login actually mints —
 * and asks what a person holding it can open. It is deliberately in
 * packages/contracts, the one place that can see the issuing list, the guard,
 * and the jurisdiction matrix at once.
 *
 * The procedures below MIRROR the real ones. Each is annotated with the file it
 * copies; if a service changes its guard, this file has to change with it, and
 * that coupling is the point — it is what makes an assertion here a claim about
 * the platform rather than about a fixture.
 */

const authConfig = {
  secret: 'a-test-signing-secret-that-is-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const USER = '66666666-6666-4666-8666-666666666666';
const SESSION = '77777777-7777-4777-8777-777777777777';

/** A session token exactly as `AuthService.issueSession` mints it. */
async function session(tier: KycTier, region = 'DE'): Promise<Context> {
  const { token } = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: SESSION_SCOPES, tier }, authConfig);
  return {
    principal: await verifyAccessToken(token, authConfig),
    service: null,
    region,
    requestId: 'req-session-access',
  };
}

const ok = () => ({ ok: true });

const surface = router({
  // services/svc-bank/src/router.ts — `spaces.list`, `spaces.create`
  bankRead: scopedProcedure('bank:read', { module: 'bank' }).query(ok),
  bankWrite: scopedProcedure('bank:write', { module: 'bank' }).mutation(ok),
  // Withheld from every session: interactive-only card spend authority.
  bankCard: scopedProcedure('bank:card', { module: 'bank' }).mutation(ok),

  // services/svc-blueprint/src/router.ts — `me`, `onboard`
  blueprintRead: scopedProcedure('blueprint:read', { module: 'blueprint' }).query(ok),
  blueprintWrite: scopedProcedure('blueprint:write', { module: 'blueprint' }).mutation(ok),

  // services/svc-p2p/src/router.ts — `offers.list`, `offers.create`
  p2pRead: scopedProcedure('p2p:read', { module: 'p2p' }).query(ok),
  p2pWrite: scopedProcedure('p2p:write', { module: 'p2p' }).mutation(ok),

  // services/svc-protocol/src/router.ts — `claimAccount`
  protocolRead: scopedProcedure('protocol:read', { module: 'protocol', plane: 'protocol' }).query(ok),

  // services/svc-agents/src/router.ts — `sessions.open`
  agentsExecute: scopedProcedure('agents:execute', { module: 'agents' }).mutation(ok),

  // services/svc-identity/src/router.ts — `kyc.approve`
  kycApprove: scopedProcedure('admin:compliance').mutation(ok),
});

const call = async (tier: KycTier, region?: string) => surface.createCaller(await session(tier, region));

/** The refusal, unwrapped: tRPC wraps our error as `cause`. */
function refusal(err: unknown): { httpCode: string; code: string | undefined; requiredTier: string | undefined } {
  const cause = (err as { cause?: unknown }).cause;
  return {
    httpCode: (err as { code?: string }).code ?? 'NONE',
    code: cause instanceof AuthError || cause instanceof JurisdictionError ? cause.code : undefined,
    requiredTier: cause instanceof JurisdictionError ? cause.requiredTier : undefined,
  };
}

const failed = async (p: Promise<unknown>) => refusal(await p.catch((e: unknown) => e));

describe('a session with NO verification (tier: none)', () => {
  it('opens Blueprint, both read and write', async () => {
    // §22: non-custodial, `minTier: 'none'`. There is no asset held, so there
    // is nothing to verify anyone against — and erasing your own Blueprint must
    // never be conditional on having filed identity documents.
    const api = await call('none');
    await expect(api.blueprintRead()).resolves.toEqual({ ok: true });
    await expect(api.blueprintWrite()).resolves.toEqual({ ok: true });
  });

  it('reaches the Protocol Plane, which is permissionless by construction', async () => {
    const api = await call('none');
    await expect(api.protocolRead()).resolves.toEqual({ ok: true });
  });

  it('is refused by Bank for VERIFICATION, naming the tier to reach', async () => {
    // The distinction this whole change exists for. The user HOLDS bank:read.
    // What they lack is a KYC file, and the refusal says so — which is a thing
    // a person can go and do, unlike "you lack a scope".
    const api = await call('none');
    for (const denied of [await failed(api.bankRead()), await failed(api.bankWrite())]) {
      expect(denied.httpCode).toBe('FORBIDDEN');
      expect(denied.code).toBe('denied.kyc_required');
      expect(denied.requiredTier).toBe('full');
    }
  });

  it('is refused by P2P for VERIFICATION at tier basic — correct behaviour, not a bug', async () => {
    // p2p is custodial and `OPEN_BASIC`. The scope IS held and always was; the
    // 403 here is the sovereignty law working, not the outage that hid behind
    // an identical status code.
    const api = await call('none');
    const denied = await failed(api.p2pWrite());
    expect(denied.code).toBe('denied.kyc_required');
    expect(denied.requiredTier).toBe('basic');
  });
});

describe('a session verified to tier basic', () => {
  it('opens P2P, both read and write', async () => {
    const api = await call('basic');
    await expect(api.p2pRead()).resolves.toEqual({ ok: true });
    await expect(api.p2pWrite()).resolves.toEqual({ ok: true });
  });

  it('still keeps Blueprint open', async () => {
    const api = await call('basic');
    await expect(api.blueprintWrite()).resolves.toEqual({ ok: true });
  });

  it('is STILL short of Bank, which needs tier full', async () => {
    const api = await call('basic');
    const denied = await failed(api.bankRead());
    expect(denied.code).toBe('denied.kyc_required');
    expect(denied.requiredTier).toBe('full');
  });
});

describe('a fully verified session (tier: full)', () => {
  it('opens Bank, both read and write', async () => {
    const api = await call('full');
    await expect(api.bankRead()).resolves.toEqual({ ok: true });
    await expect(api.bankWrite()).resolves.toEqual({ ok: true });
  });

  it('opens Blueprint and P2P as well — every user-facing module it should', async () => {
    const api = await call('full');
    await expect(api.blueprintRead()).resolves.toEqual({ ok: true });
    await expect(api.blueprintWrite()).resolves.toEqual({ ok: true });
    await expect(api.p2pRead()).resolves.toEqual({ ok: true });
    await expect(api.p2pWrite()).resolves.toEqual({ ok: true });
    await expect(api.protocolRead()).resolves.toEqual({ ok: true });
  });

  it('reaches agent execution from the person’s own session (OWNER 107: every signed-in person, bounded by svc-agents)', async () => {
    const api = await call('full');
    await expect(api.agentsExecute()).resolves.toEqual({ ok: true });
  });

  it('does NOT reach card spend or the compliance desk', async () => {
    // Verification buys custodial access. It does not buy authority, and these
    // refusals must stay `scope.denied` no matter how verified an account
    // becomes — most of all `admin:compliance`, which approves KYC records.
    const api = await call('full');
    for (const denied of [await failed(api.bankCard()), await failed(api.kycApprove())]) {
      expect(denied.httpCode).toBe('FORBIDDEN');
      expect(denied.code).toBe('scope.denied');
      expect(denied.requiredTier).toBeUndefined();
    }
  });
});

describe('the three refusals a 403 used to hide', () => {
  it('tells "wrong region" apart from "not verified" — same status, different cause', async () => {
    // `bank` is BLOCKED in US, at every tier. A user who verifies to full and
    // is still refused must not be told to verify again.
    const blockedRegion = await failed((await call('full', 'US')).bankRead());
    expect(blockedRegion.code).toBe('denied.module_blocked');
    expect(blockedRegion.requiredTier).toBeUndefined();

    const unverified = await failed((await call('none', 'DE')).bankRead());
    expect(unverified.code).toBe('denied.kyc_required');

    // Same HTTP status, and before this change the same everything.
    expect(blockedRegion.httpCode).toBe(unverified.httpCode);
    expect(blockedRegion.code).not.toBe(unverified.code);
  });

  it('tells "you lack the scope" apart from "you hold it but need KYC"', async () => {
    const api = await call('none');
    expect((await failed(api.bankCard())).code).toBe('scope.denied');
    expect((await failed(api.bankRead())).code).toBe('denied.kyc_required');
  });
});
