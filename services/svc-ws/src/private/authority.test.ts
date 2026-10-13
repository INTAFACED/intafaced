import { describe, expect, it } from 'vitest';
import { verifyServiceHeaders, type CurrentAuthorityInput } from '@intafaced/contracts';
import { createIdentityAuthorityClient } from './authority.js';
import { eligibleAuthority } from '../test-support/authority.js';

const secret = 'identity-authority-test-secret-long-enough';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const subject: CurrentAuthorityInput = { userId: USER, credential: { kind: 'session', sessionId: SESSION } };
describe('owned identity HTTP authority', () => {
  it('signs exact plain POST bytes with v2 service authentication and reads the actual tRPC envelope', async () => {
    const client = createIdentityAuthorityClient({
      baseUrl: 'http://identity.test/',
      secret,
      fetch: async (url, init) => {
        expect(String(url)).toBe('http://identity.test/trpc/accountControls.currentAuthority');
        expect(init?.method).toBe('POST');
        expect(init?.redirect).toBe('error');
        expect(new Headers(init?.headers).get('cache-control')).toBe('no-store');
        expect(init?.body).toBe(JSON.stringify(subject));
        expect(
          verifyServiceHeaders(init?.headers as Record<string, string>, secret, {
            mode: 'require',
            rawBody: { retained: true, bytes: Buffer.from(String(init?.body)) },
          }).service,
        ).toBe('svc-ws');
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return Response.json({ result: { data: eligibleAuthority(subject) } });
      },
    });
    expect(await client.read(subject, new AbortController().signal)).toMatchObject({ status: 'eligible', subject });
  });
  it('refuses unavailable, malformed, wrapped and unknown responses', async () => {
    for (const response of [
      new Response('', { status: 401 }),
      new Response('invalid'),
      Response.json({ result: { data: { json: eligibleAuthority(subject) } } }),
      Response.json({ result: { data: { status: 'unknown' } } }),
    ]) {
      const client = createIdentityAuthorityClient({ baseUrl: 'http://identity.test', secret, fetch: async () => response });
      await expect(client.read(subject, new AbortController().signal)).rejects.toThrow();
    }
  });
  it('preserves key IP, origin, product, expiry and account policies using identity-owned metadata', async () => {
    const keySubject: CurrentAuthorityInput = { userId: USER, credential: { kind: 'api_key', apiKeyId: KEY } };
    const policy = {
      userId: USER,
      sessionId: SESSION,
      apiKeyId: KEY,
      callerIp: '203.0.113.8',
      requestOrigin: 'https://terminal.test',
      accountId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    };
    const key = {
      id: KEY,
      userId: USER,
      revoked: false,
      ipAllowlist: ['203.0.113.8'],
      originAllowlist: ['https://terminal.test'],
      productAllowlist: ['trade'],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      accountId: policy.accountId,
    };
    const client = createIdentityAuthorityClient({
      baseUrl: 'http://identity.test',
      secret,
      fetch: async (url) => Response.json(String(url).includes('/trpc/') ? { result: { data: eligibleAuthority(keySubject) } } : key),
    });
    expect(await client.read(keySubject, new AbortController().signal, policy)).toMatchObject({ status: 'eligible' });
    for (const wrong of [
      { ...policy, callerIp: '192.0.2.1' },
      { ...policy, requestOrigin: 'https://foreign.test' },
      { ...policy, accountId: undefined },
    ])
      await expect(client.read(keySubject, new AbortController().signal, wrong)).rejects.toThrow();
    for (const altered of [
      { ...key, productAllowlist: ['pay'] },
      { ...key, expiresAt: new Date(0).toISOString() },
      { ...key, revoked: true },
    ]) {
      const denied = createIdentityAuthorityClient({
        baseUrl: 'http://identity.test',
        secret,
        fetch: async (url) => Response.json(String(url).includes('/trpc/') ? { result: { data: eligibleAuthority(keySubject) } } : altered),
      });
      await expect(denied.read(keySubject, new AbortController().signal, policy)).rejects.toThrow();
    }
  });
});
