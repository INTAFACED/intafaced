import { describe, expect, it } from 'vitest';
import { createApiClient } from '../shared/api';
import { cleanHandle, fetchMe, fetchMyPayQr, resolveHandle, resolvePayQr } from './identity';

const ID = '1f985d42-852d-4b50-a4d9-bdfa0384027c';
const trpc = (data: unknown) => new Response(JSON.stringify({ result: { data } }), { status: 200 });
const error = (status: number, body: unknown = { error: { message: 'x' } }) => new Response(JSON.stringify(body), { status });

function client(answer: (url: string) => Response | Promise<Response>) {
  const urls: string[] = [];
  const api = createApiClient({
    fetch: (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return answer(String(input));
    }) as typeof fetch,
  });
  return { api, urls };
}

describe('cleanHandle', () => {
  it('drops one leading @ and spaces, and keeps the letters as typed', () => {
    expect(cleanHandle(' @Test_Friend ')).toBe('Test_Friend');
    expect(cleanHandle('luffy')).toBe('luffy');
  });
  it('refuses anything that is not 3 to 32 letters, numbers or underscores', () => {
    for (const bad of ['', '@', 'ab', 'a b', 'a-b', '@@abc', 'x'.repeat(33), 'tëst', 'a%', '*']) expect(cleanHandle(bad)).toBeNull();
  });
});

describe('fetchMe', () => {
  it('reads the caller own handle', async () => {
    const { api, urls } = client(() => trpc({ userId: ID, handle: 'test_friend' }));
    expect(await fetchMe(api)).toEqual({ kind: 'ok', userId: ID, handle: 'test_friend' });
    expect(urls[0]).toBe('/api/identity/trpc/me');
  });
  it('passes through emailVerified when the server sends it', async () => {
    const { api } = client(() => trpc({ userId: ID, handle: 'test_friend', emailVerified: false }));
    expect(await fetchMe(api)).toEqual({ kind: 'ok', userId: ID, handle: 'test_friend', emailVerified: false });
  });
  it('is "unavailable" on 404 and 501 (the server is older than this screen)', async () => {
    expect(await fetchMe(client(() => error(404)).api)).toEqual({ kind: 'unavailable' });
    expect(await fetchMe(client(() => error(501)).api)).toEqual({ kind: 'unavailable' });
  });
  it('is "failed" on a server error or an answer of the wrong shape', async () => {
    expect(await fetchMe(client(() => error(500)).api)).toEqual({ kind: 'failed' });
    expect(await fetchMe(client(() => trpc({ userId: 'nope', handle: 'a' })).api)).toEqual({ kind: 'failed' });
  });
});

describe('resolveHandle', () => {
  it('asks for the exact handle without the @', async () => {
    const { api, urls } = client(() => trpc({ found: true, userId: ID, handle: 'Luffy2', self: false }));
    expect(await resolveHandle(api, '@luffy2')).toEqual({ kind: 'found', userId: ID, handle: 'Luffy2', self: false });
    expect(decodeURIComponent(urls[0]!)).toBe('/api/identity/trpc/users.resolveHandle?input={"handle":"luffy2"}');
  });
  it('reports yourself so the screen can refuse', async () => {
    const { api } = client(() => trpc({ found: true, userId: ID, handle: 'test_friend', self: true }));
    expect(await resolveHandle(api, 'test_friend')).toMatchObject({ kind: 'found', self: true });
  });
  it('not found', async () => {
    expect(await resolveHandle(client(() => trpc({ found: false })).api, 'nobody_here')).toEqual({ kind: 'notFound' });
  });
  it('does not spend a lookup on a malformed handle', async () => {
    const { api, urls } = client(() => trpc({ found: false }));
    expect(await resolveHandle(api, 'a b')).toEqual({ kind: 'notFound' });
    expect(urls).toEqual([]);
  });
  it('429 is a rate limit, by status or by code', async () => {
    expect(await resolveHandle(client(() => error(429)).api, 'abc')).toEqual({ kind: 'rateLimited' });
    const coded = error(500, { error: { message: 'slow down', data: { intafacedCode: 'identity.handle_lookup_rate_limited' } } });
    expect(await resolveHandle(client(() => coded).api, 'abc')).toEqual({ kind: 'rateLimited' });
  });
  it('404 and 501 mean the server cannot do handles yet (the screen falls back to Account ID)', async () => {
    expect(await resolveHandle(client(() => error(404)).api, 'abc')).toEqual({ kind: 'unavailable' });
    expect(await resolveHandle(client(() => error(501)).api, 'abc')).toEqual({ kind: 'unavailable' });
  });
  it('403 (an API key) and 5xx are failures, not a reason to fall back', async () => {
    expect(await resolveHandle(client(() => error(403)).api, 'abc')).toEqual({ kind: 'failed' });
    expect(await resolveHandle(client(() => error(500)).api, 'abc')).toEqual({ kind: 'failed' });
  });
  it('an answer about a different handle is refused', async () => {
    const { api } = client(() => trpc({ found: true, userId: ID, handle: 'someone_else', self: false }));
    expect(await resolveHandle(api, 'abc')).toEqual({ kind: 'failed' });
  });
  it('a malformed answer is a failure', async () => {
    expect(await resolveHandle(client(() => trpc({ found: true, handle: 'abc' })).api, 'abc')).toEqual({ kind: 'failed' });
  });
});

describe('signed pay codes', () => {
  const refused = (code: string, status = 400) => error(status, { error: { message: 'x', data: { cause: { code } } } });

  it('reads the caller’s own code, and says when no signing key is set', async () => {
    const { api, urls } = client(() => trpc({ payload: `v1.${ID}.sig` }));
    expect(await fetchMyPayQr(api)).toEqual({ kind: 'ok', payload: `v1.${ID}.sig` });
    expect(urls[0]).toBe('/api/identity/trpc/qr.mine');
    expect(await fetchMyPayQr(client(() => refused('identity.qr_key_unset', 412)).api)).toEqual({ kind: 'unset' });
    expect(await fetchMyPayQr(client(() => error(500)).api)).toEqual({ kind: 'failed' });
  });

  it('resolves a scanned code to its payee, and names each refusal', async () => {
    const { api, urls } = client(() => trpc({ userId: ID, handle: 'test_friend', self: false }));
    expect(await resolvePayQr(api, `v1.${ID}.sig`)).toEqual({ kind: 'found', userId: ID, handle: 'test_friend', self: false });
    expect(decodeURIComponent(urls[0] ?? '')).toContain(`qr.resolve?input={"payload":"v1.${ID}.sig"}`);
    expect(await resolvePayQr(client(() => refused('identity.qr_invalid')).api, 'x')).toEqual({ kind: 'invalid' });
    expect(await resolvePayQr(client(() => refused('identity.qr_payee_unavailable', 404)).api, 'x')).toEqual({ kind: 'payeeUnavailable' });
    expect(await resolvePayQr(client(() => refused('identity.qr_key_unset', 412)).api, 'x')).toEqual({ kind: 'unset' });
    expect(await resolvePayQr(client(() => error(500)).api, 'x')).toEqual({ kind: 'failed' });
  });
});
