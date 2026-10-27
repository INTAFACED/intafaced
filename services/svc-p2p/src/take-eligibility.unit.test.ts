import { describe, expect, it } from 'vitest';
import { createIdentityContactReader } from './take-eligibility.js';

/** svc-identity's `me`, asked as the person of the request and nobody else. */
describe('identity contact reader', () => {
  const ctx = { forwardedPrincipal: { raw: 'principal-bytes', signature: 'sig', region: 'DE' } };
  const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

  it('forwards the edge-signed principal unchanged and reads emailVerified', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const reader = createIdentityContactReader({
      identityUrl: 'http://identity.test/',
      fetcher: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ result: { data: { userId: 'u', handle: 'h', emailVerified: false } } }), { status: 200 });
      }) as typeof fetch,
    });
    expect(await reader.emailConfirmed(ctx)).toBe(false);
    expect(calls[0]?.url).toBe('http://identity.test/trpc/me');
    expect(calls[0]?.init.headers).toEqual({
      'x-intafaced-principal': 'principal-bytes',
      'x-intafaced-principal-sig': 'sig',
      'x-intafaced-region': 'DE',
    });
  });

  it('a request with no signed principal asks nobody', async () => {
    let asked = false;
    const reader = createIdentityContactReader({
      identityUrl: 'http://identity.test',
      fetcher: (async () => {
        asked = true;
        return new Response('{}');
      }) as typeof fetch,
    });
    await expect(reader.emailConfirmed({})).rejects.toMatchObject({ code: 'p2p.contact_unverifiable' });
    expect(asked).toBe(false);
  });

  it.each([
    ['a refusal', answer(401, { error: {} })],
    ['an answer without the field', answer(200, { result: { data: { userId: 'u' } } })],
    ['an unreachable service', async () => Promise.reject(new Error('ECONNREFUSED'))],
  ])('%s is unverifiable, never confirmed', async (_name, fetcher) => {
    const reader = createIdentityContactReader({ identityUrl: 'http://identity.test', fetcher: fetcher as typeof fetch });
    await expect(reader.emailConfirmed(ctx)).rejects.toMatchObject({ code: 'p2p.contact_unverifiable' });
  });
});
