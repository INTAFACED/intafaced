import { describe, expect, it } from 'vitest';
import { createPayMerchantEmailInviteClaimer } from './merchant-email-invite-claim.js';
import { fetchOwnerPayScopes } from './owner-pay-scopes.js';
import { fetchPayStepUpGrant } from './pay-step-up-grant.js';
import { SHARED, judged, keys, wire, type Wire } from '../s2s-out-keys.testkit.js';

/** The three svc-pay calls from svc-identity, judged by the contracts verifier svc-pay uses, on the wire request. */
const PAY = 'http://pay.test';
const USER = '11111111-1111-4111-8111-111111111111';

function capture() {
  const sent: Wire[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit) => {
    sent.push(wire(input, init));
    const body = String(input).includes('step-up')
      ? { role: 'owner', permissions: { 'refunds.create': true, 'payout.send': false } }
      : { scopes: ['pay:read'] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { sent, fetchImpl };
}

type Out = ReturnType<ReturnType<typeof keys>['s2s']>;
type Call = (s2s: Out | undefined, fetchImpl: typeof fetch) => Promise<unknown>;
const calls: Record<string, { path: string; run: Call }> = {
  'owner pay scopes': {
    path: '/internal/merchant-owner-pay-scopes',
    run: (s2s, fetchImpl) => fetchOwnerPayScopes({ payUrl: PAY, secret: SHARED, userId: USER, fetchImpl, ...(s2s ? { s2s } : {}) }),
  },
  'pay step-up grant': {
    path: '/internal/merchant-pay-step-up-grant',
    run: (s2s, fetchImpl) =>
      fetchPayStepUpGrant({ payUrl: PAY, secret: SHARED, userId: USER, merchantId: 'm-1', fetchImpl, ...(s2s ? { s2s } : {}) }),
  },
  'merchant email invite claim': {
    path: '/internal/merchant-team/claim-email-invites',
    run: (s2s, fetchImpl) => createPayMerchantEmailInviteClaimer(PAY, SHARED, fetchImpl, s2s).claim({ userId: USER, email: 'a@b.test' }),
  },
};

describe.each(Object.entries(calls))('svc-identity -> svc-pay: %s', (_name, { path, run }) => {
  it('without a signing key the call is signed with the shared secret as before', async () => {
    const { sent, fetchImpl } = capture();
    await run(undefined, fetchImpl);
    const k = keys();
    expect(sent[0]!.url.pathname).toBe(path);
    expect(Object.keys(sent[0]!.headers).some((h) => h.startsWith('x-intafaced-s2s-'))).toBe(false);
    expect(judged(sent[0]!, k.verifier('svc-pay'))).toMatchObject({ service: 'svc-identity', scheme: 'shared' });
  });

  it('dual: svc-pay names the caller from the key, and the shared secret rides along', async () => {
    const { sent, fetchImpl } = capture();
    const k = keys();
    await run(k.s2s('dual'), fetchImpl);
    expect(sent[0]!.headers['x-intafaced-service']).toBe('svc-identity');
    expect(judged(sent[0]!, k.verifier('svc-pay'))).toEqual({ service: 'svc-identity', scheme: 'keypair', rejected: null });
  });

  it('keypair: only the key is sent, and a call moved to another path or method is refused', async () => {
    const { sent, fetchImpl } = capture();
    const k = keys();
    await run(k.s2s('keypair'), fetchImpl);
    expect(sent[0]!.headers['x-intafaced-service']).toBeUndefined();
    expect(sent[0]!.headers['x-intafaced-signature']).toBeUndefined();
    expect(judged(sent[0]!, k.verifier('svc-pay'), 'keypair')).toMatchObject({ service: 'svc-identity', scheme: 'keypair' });
    const moved = { ...sent[0]!, url: new URL('http://pay.test/internal/other') };
    expect(judged(moved, k.verifier('svc-pay'), 'keypair')).toMatchObject({ service: null });
    const verb = { ...sent[0]!, method: 'PUT' };
    expect(judged(verb, k.verifier('svc-pay'), 'keypair')).toMatchObject({ service: null });
  });

  it('a call signed for svc-pay is refused by another service', async () => {
    const { sent, fetchImpl } = capture();
    const k = keys();
    await run(k.s2s('keypair'), fetchImpl);
    expect(judged(sent[0]!, k.verifier('svc-bank'), 'keypair')).toMatchObject({ service: null });
  });
});
