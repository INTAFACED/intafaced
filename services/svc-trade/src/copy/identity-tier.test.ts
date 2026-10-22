/** CB-copy-03 — svc-identity tier reader (accountStateSchema over GET /internal/account/:userId). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdentityTierReader } from './identity-tier.js';

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000009';
const SECRET = 's'.repeat(32);
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function reader(fetcher: (url: URL, init: RequestInit) => Promise<Response>, url = 'http://identity.test') {
  const read = createIdentityTierReader({ url, serviceSecret: SECRET }, fetcher as unknown as typeof fetch);
  if (!read) throw new Error('reader not built');
  return read;
}

afterEach(() => vi.useRealTimers());

describe('createIdentityTierReader', () => {
  it('GETs /internal/account/:userId with service-signed headers and returns kycTier', async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const read = reader(async (url, init) => {
      calls.push({ url, init });
      return ok({ userId: USER, status: 'active', kycTier: 'full' });
    });
    await expect(read(USER)).resolves.toBe('full');
    expect(calls).toHaveLength(1);
    expect(calls[0].url.toString()).toBe(`http://identity.test/internal/account/${USER}`);
    expect(calls[0].init.method).toBe('GET');
    const headers = calls[0].init.headers as Record<string, string>;
    const signed = Object.keys(headers).filter((h) => h !== 'content-type' && h !== 'cache-control');
    expect(signed.length).toBeGreaterThan(0);
    expect(JSON.stringify(headers)).not.toContain(SECRET);
  });

  it('non-2xx throws', async () => {
    await expect(reader(async () => new Response('no', { status: 404 }))(USER)).rejects.toThrow();
    await expect(reader(async () => new Response('no', { status: 503 }))(USER)).rejects.toThrow();
  });

  it('bad shape throws', async () => {
    await expect(reader(async () => ok({ userId: USER, status: 'active', kycTier: 'gold' }))(USER)).rejects.toThrow();
    await expect(reader(async () => ok({ userId: USER }))(USER)).rejects.toThrow();
    await expect(reader(async () => new Response('not json', { status: 200 }))(USER)).rejects.toThrow();
  });

  it('answer for another user throws', async () => {
    await expect(reader(async () => ok({ userId: OTHER, status: 'active', kycTier: 'full' }))(USER)).rejects.toThrow();
  });

  it('transport error throws', async () => {
    await expect(
      reader(async () => {
        throw new TypeError('fetch failed');
      })(USER),
    ).rejects.toThrow();
  });

  it('aborts and throws after the 2000ms timeout', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const read = reader(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init.signal ?? undefined;
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const pending = read(USER);
    const settled = expect(pending).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(1999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await settled;
  });

  it('bad config returns undefined (caller refuses identity_unavailable)', () => {
    const f = (async () => ok({})) as unknown as typeof fetch;
    for (const url of [
      'not a url',
      'ftp://identity.test',
      'http://u:p@identity.test',
      'http://identity.test?x=1',
      'http://identity.test#h',
    ]) {
      expect(createIdentityTierReader({ url, serviceSecret: SECRET }, f)).toBeUndefined();
    }
    expect(createIdentityTierReader({ url: 'http://identity.test', serviceSecret: 'short' }, f)).toBeUndefined();
  });
});
