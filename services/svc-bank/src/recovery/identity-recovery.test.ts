/**
 * RC-identity-08: svc-bank's port to identity's recovery claim doors. Each ask is signed as svc-bank for svc-identity;
 * any answer that is not a readable 2xx in the contract's shape is `bank.recovery_unavailable`, never "claimable".
 */
import { describe, expect, it } from 'vitest';
import { RECOVERY_CLAIM_VERIFY_PATH, recoveryEstatesPath } from '@intafaced/contracts';
import { createIdentityRecovery, unconfiguredIdentityRecovery } from './identity-recovery.js';

const SECRET = 's'.repeat(32);
const HEIR = '72222222-2222-4222-8222-222222222222';
const OWNER = '71111111-1111-4111-8111-111111111111';
const NOTICE = '74444444-4444-4444-8444-444444444444';
const CLAIM = '76666666-6666-4666-8666-666666666666';
const REQUEST = {
  userId: OWNER,
  heirUserId: HEIR,
  claimId: CLAIM,
  signatures: [
    { publicKey: { kty: 'EC' as const, crv: 'P-256' as const, x: 'A'.repeat(43), y: 'B'.repeat(43) }, signature: 'C'.repeat(86) },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function identityAnswering(answer: () => Response) {
  const asked: Array<{ url: string; method: string; headers: Record<string, string>; body: string | null }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return answer();
  }) as typeof globalThis.fetch;
  return { asked, fetchFn };
}

describe('identity recovery port', () => {
  it('asks for the caller’s estates with a signed GET and reads the list', async () => {
    const estate = { userId: OWNER, handle: 'owner_test', noticeId: NOTICE, threshold: 2, liveKeys: 3 };
    const { asked, fetchFn } = identityAnswering(() => json({ estates: [estate] }));
    await expect(createIdentityRecovery('http://identity.test/', SECRET, fetchFn).estates(HEIR)).resolves.toEqual([estate]);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe(`http://identity.test${recoveryEstatesPath(HEIR)}`);
    expect(asked[0]!.method).toBe('GET');
    expect(Object.keys(asked[0]!.headers).some((h) => h.toLowerCase().startsWith('x-intafaced-'))).toBe(true);
  });

  it('posts the claim as JSON with a signed body and reads both kinds of verdict', async () => {
    let verdict: unknown = { ok: true, noticeId: NOTICE, threshold: 1, signerKeyIds: [CLAIM] };
    const { asked, fetchFn } = identityAnswering(() => json(verdict));
    const port = createIdentityRecovery('http://identity.test', SECRET, fetchFn);
    await expect(port.verify(REQUEST)).resolves.toEqual(verdict);
    expect(asked[0]).toMatchObject({
      url: `http://identity.test${RECOVERY_CLAIM_VERIFY_PATH}`,
      method: 'POST',
      body: JSON.stringify(REQUEST),
    });
    expect(asked[0]!.headers['content-type']).toBe('application/json');
    verdict = { ok: false, code: 'identity.recovery_key_revoked' };
    await expect(port.verify(REQUEST)).resolves.toEqual(verdict);
  });

  it.each([
    ['a 403', () => json({ code: 'identity.recovery_verifier_refused' }, 403)],
    ['a 500', () => json({ error: 'boom' }, 500)],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['a body outside the schema', () => json({ ok: true })],
    ['a refusal code identity does not have', () => json({ ok: false, code: 'identity.recovery_anything' })],
    [
      'no answer at all',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('refuses as unavailable on %s', async (_case, answer) => {
    const { fetchFn } = identityAnswering(answer);
    const port = createIdentityRecovery('http://identity.test', SECRET, fetchFn);
    await expect(port.verify(REQUEST)).rejects.toMatchObject({ code: 'bank.recovery_unavailable' });
    await expect(port.estates(HEIR)).rejects.toMatchObject({ code: 'bank.recovery_unavailable' });
  });

  it('refuses every ask when no identity is configured', async () => {
    await expect(unconfiguredIdentityRecovery().estates(HEIR)).rejects.toMatchObject({ code: 'bank.recovery_unavailable' });
    await expect(unconfiguredIdentityRecovery().verify(REQUEST)).rejects.toMatchObject({ code: 'bank.recovery_unavailable' });
  });
});
