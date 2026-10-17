/**
 * D26-P1-P1 Done bar — PSP path without third-party money lib; merchant durability.
 *
 * Public-door proof via tRPC createCaller on `kyb.*` / `psp.*` (merged router).
 * Break: missing live operator decide, invent fees, or a forbidden money lib dep.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createKybPspRouter } from './kyb-router.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { assertNoThirdPartyMoneyLibrary, FORBIDDEN_THIRD_PARTY_MONEY_LIBS, PspModeError, type PspModeService } from './psp-mode.js';
import { KybError, type KybService } from './kyb-service.js';

const authConfig = {
  secret: 'a-test-signing-secret-that-is-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const USER = '66666666-6666-4666-8666-666666666666';
const CONFIRM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const APPROVED = { approvalId: 'appr-1', operationId: 'op-1' };
const MERCHANT = '55555555-5555-4555-8555-555555555555';
const here = dirname(fileURLToPath(import.meta.url));

async function ctx(scopes: string[], opts: { mfa?: boolean } = {}): Promise<Context> {
  const { token } = await issueAccessToken(
    {
      userId: USER,
      sessionId: '77777777-7777-4777-8777-777777777777',
      scopes,
      tier: 'full',
      mfa: opts.mfa ?? true,
    },
    authConfig,
  );
  return {
    principal: await verifyAccessToken(token, authConfig),
    service: null,
    region: 'DE',
    requestId: 'psp-done-bar',
  };
}

function stubKyb(): KybService {
  const events: Array<{
    id: string;
    seq: string;
    merchantId: string;
    fromStatus: 'none' | 'pending' | 'approved' | 'rejected';
    toStatus: 'none' | 'pending' | 'approved' | 'rejected';
    kybRef: string | null;
    reason: string;
    actorId: string;
    actorScope: string;
    createdAt: Date;
  }> = [];
  let status: 'none' | 'pending' | 'approved' | 'rejected' = 'none';
  let kybRef: string | null = null;

  return {
    submit: async (input: Parameters<KybService['submit']>[0]) => {
      if (status === 'pending') throw new KybError('already pending', 'pay.kyb_already_pending');
      const from = status;
      status = 'pending';
      kybRef = input.kybRef;
      const event = {
        id: '11111111-1111-4111-8111-111111111111',
        seq: String(events.length + 1),
        merchantId: input.merchantId,
        fromStatus: from,
        toStatus: 'pending' as const,
        kybRef: input.kybRef,
        reason: input.reason ?? 'submit',
        actorId: input.actorId,
        actorScope: input.actorScope,
        createdAt: new Date('2026-08-12T12:00:00.000Z'),
      };
      events.push(event);
      return { changed: true, kybStatus: status, kybRef: input.kybRef, event };
    },
    decide: async (input: Parameters<KybService['decide']>[0]) => {
      if (status !== 'pending') throw new KybError('not pending', 'pay.kyb_not_pending');
      const from = status;
      status = input.decision;
      const event = {
        id: '22222222-2222-4222-8222-222222222222',
        seq: String(events.length + 1),
        merchantId: input.merchantId,
        fromStatus: from,
        toStatus: input.decision,
        kybRef,
        reason: input.reason,
        actorId: input.actorId,
        actorScope: input.actorScope,
        createdAt: new Date('2026-08-12T12:05:00.000Z'),
      };
      events.push(event);
      return { changed: true, kybStatus: status, event };
    },
    history: async () => events,
    currentStatus: async () => ({ kybStatus: status, kybRef, mode: 'psp' as const }),
    decisionBinding: async (merchantId: string) => {
      const identityHash = 'sha256:' + '0'.repeat(64);
      return {
        merchantId,
        profileVersion: '0',
        identityHash,
        fields: (decision: 'approved' | 'rejected') => ({
          decision,
          identityHash,
          merchantId,
          profileVersion: '0',
        }),
      };
    },
  } as unknown as KybService;
}

function stubPsp(): PspModeService {
  let feeBps = 250;
  let mode: 'gateway' | 'psp' = 'gateway';
  const pricingEvents: Array<{
    id: string;
    seq: string;
    merchantId: string;
    fromFeeBps: number;
    toFeeBps: number;
    reason: string;
    actorId: string;
    actorScope: string;
    createdAt: Date;
  }> = [];

  return {
    setPricing: async (input: Parameters<PspModeService['setPricing']>[0]) => {
      if (!input.reason?.trim()) throw new PspModeError('blank reason', 'pay.psp_pricing_reason_required');
      const from = feeBps;
      const changed = from !== input.feeBps;
      feeBps = input.feeBps;
      const event = changed
        ? {
            id: '33333333-3333-4333-8333-333333333333',
            seq: String(pricingEvents.length + 1),
            merchantId: input.merchantId,
            fromFeeBps: from,
            toFeeBps: input.feeBps,
            reason: input.reason,
            actorId: input.actorId,
            actorScope: input.actorScope,
            createdAt: new Date('2026-08-12T12:10:00.000Z'),
          }
        : null;
      if (event) pricingEvents.push(event);
      return { changed, feeBps, event };
    },
    pricingHistory: async () => pricingEvents,
    enablePspMode: async (input: Parameters<PspModeService['enablePspMode']>[0]) => {
      if (feeBps === undefined || feeBps === null) {
        throw new PspModeError('feeBps required', 'pay.psp_fee_bps_required');
      }
      const changed = mode !== 'psp';
      mode = 'psp';
      return { mode: 'psp' as const, feeBps, changed, reason: input.reason, actorId: input.actorId };
    },
  } as unknown as PspModeService;
}

describe('D26-P1-P1 PSP Done bar — public doors', () => {
  it('boot seal refuses third-party money / orchestrator libs (D-S-10)', () => {
    expect(() => assertNoThirdPartyMoneyLibrary()).not.toThrow();
    const pkg = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
    for (const forbidden of FORBIDDEN_THIRD_PARTY_MONEY_LIBS) {
      expect(names.has(forbidden)).toBe(false);
    }
  });

  it('KYB submission refuses another merchant before changing its dossier', async () => {
    const kyb = stubKyb();
    const api = createKybPspRouter(kyb, stubPsp(), stubApprovalConsumer(CONFIRM), {
      getMerchant: async () => ({ userId: 'another-owner' }),
    }).createCaller(await ctx(['pay:write']));
    await expect(api.kyb.submit({ merchantId: MERCHANT, kybRef: 'dossier-other' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await kyb.history(MERCHANT, 50)).toHaveLength(0);
  });

  it('KYB submission refuses when its ownership lookup is unavailable', async () => {
    const kyb = stubKyb();
    const api = createKybPspRouter(kyb, stubPsp(), stubApprovalConsumer(CONFIRM)).createCaller(await ctx(['pay:write']));
    await expect(api.kyb.submit({ merchantId: MERCHANT, kybRef: 'dossier-unavailable' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await kyb.history(MERCHANT, 50)).toHaveLength(0);
  });

  it('kyb.submit → kyb.decide is reachable on the live operator door', async () => {
    const router = createKybPspRouter(stubKyb(), stubPsp(), stubApprovalConsumer(CONFIRM), { getMerchant: async () => ({ userId: USER }) });
    const merchant = await router.createCaller(await ctx(['pay:write'])).kyb.submit({
      merchantId: MERCHANT,
      kybRef: 'dossier-acme',
    });
    expect(merchant.kybStatus).toBe('pending');
    expect(merchant.changed).toBe(true);

    const decided = await router.createCaller(await ctx(['admin:compliance'])).kyb.decide({
      merchantId: MERCHANT,
      decision: 'approved',
      reason: 'docs complete',
      confirmOperatorId: CONFIRM,
      ...APPROVED,
    });
    expect(decided.kybStatus).toBe('approved');
    expect(decided.event?.reason).toBe('docs complete');
    expect(decided.confirmOperatorId).toBe(CONFIRM);

    const history = await router.createCaller(await ctx(['admin:read'])).kyb.history({ merchantId: MERCHANT, limit: 50 });
    expect(history).toHaveLength(2);
    expect(history.map((e) => e.toStatus)).toEqual(['pending', 'approved']);
  });

  it('psp.setPricing + enableMode refuse invent blank reason and record durability', async () => {
    const router = createKybPspRouter(stubKyb(), stubPsp(), stubApprovalConsumer(CONFIRM), { getMerchant: async () => ({ userId: USER }) });
    const priced = await router.createCaller(await ctx(['admin:write'])).psp.setPricing({
      merchantId: MERCHANT,
      feeBps: 300,
      reason: 'enterprise tier',
      confirmOperatorId: CONFIRM,
      ...APPROVED,
    });
    expect(priced.changed).toBe(true);
    expect(priced.feeBps).toBe(300);
    expect(priced.confirmOperatorId).toBe(CONFIRM);

    const enabled = await router.createCaller(await ctx(['admin:write'])).psp.enableMode({
      merchantId: MERCHANT,
      reason: 'psp onboarding',
      confirmOperatorId: CONFIRM,
      ...APPROVED,
    });
    expect(enabled.mode).toBe('psp');
    expect(enabled.feeBps).toBe(300);
    expect(enabled.confirmOperatorId).toBe(CONFIRM);

    const hist = await router.createCaller(await ctx(['admin:read'])).psp.pricingHistory({ merchantId: MERCHANT, limit: 50 });
    expect(hist[0]?.reason).toBe('enterprise tier');
  });

  it('kyb.decide / psp.setPricing / enableMode refuse missing approval ids and no MFA without writing', async () => {
    const router = createKybPspRouter(stubKyb(), stubPsp(), stubApprovalConsumer(CONFIRM), { getMerchant: async () => ({ userId: USER }) });
    await router.createCaller(await ctx(['pay:write'])).kyb.submit({ merchantId: MERCHANT, kybRef: 'dossier-acme' });

    const compliance = router.createCaller(await ctx(['admin:compliance']));
    await expect(
      compliance.kyb.decide({
        merchantId: MERCHANT,
        decision: 'approved',
        reason: 'docs complete',
        confirmOperatorId: CONFIRM,
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(
      compliance.kyb.decide({
        merchantId: MERCHANT,
        decision: 'approved',
        reason: 'docs complete',
        confirmOperatorId: USER,
        approvalId: 'appr-1',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(
      router.createCaller(await ctx(['admin:compliance'], { mfa: false })).kyb.decide({
        merchantId: MERCHANT,
        decision: 'approved',
        reason: 'docs complete',
        confirmOperatorId: CONFIRM,
        ...APPROVED,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await router.createCaller(await ctx(['admin:read'])).kyb.history({ merchantId: MERCHANT, limit: 50 })).toHaveLength(1);

    const write = router.createCaller(await ctx(['admin:write']));
    await expect(
      write.psp.setPricing({ merchantId: MERCHANT, feeBps: 300, reason: 'enterprise tier', confirmOperatorId: CONFIRM }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(
      write.psp.enableMode({ merchantId: MERCHANT, reason: 'psp onboarding', confirmOperatorId: CONFIRM }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(await router.createCaller(await ctx(['admin:read'])).psp.pricingHistory({ merchantId: MERCHANT, limit: 50 })).toEqual([]);
  });
});
