import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import {
  BUSINESS_DIRECTORY_HANDLES_PATH,
  BUSINESS_DIRECTORY_RECIPIENT_PATH,
  BusinessDirectoryError,
  createIdentityBusinessDirectory,
  memoryBusinessDirectory,
  normaliseEmailQuery,
  normaliseHandleQuery,
  unconfiguredBusinessDirectory,
} from './business-directory.js';

const SECRET = 'a'.repeat(32);

describe('business directory', () => {
  it('treats a badly shaped handle or email as no query', () => {
    expect(normaliseHandleQuery('  @Ada_Admin ')).toBe('Ada_Admin');
    expect(normaliseHandleQuery('%')).toBeNull();
    expect(normaliseHandleQuery('ab')).toBeNull();
    expect(normaliseEmailQuery(' Pat@Example.com ')).toBe('Pat@Example.com');
    expect(normaliseEmailQuery('not-an-email')).toBeNull();
    expect(normaliseEmailQuery('a@b')).toBeNull();
  });

  it('refuses when identity is not connected and names that', async () => {
    const directory = unconfiguredBusinessDirectory();
    await expect(directory.handlesOf(['u'])).rejects.toMatchObject({
      reason: 'unset',
      message: expect.stringContaining('IDENTITY_URL is unset'),
    });
    await expect(directory.findActive({ handle: 'ada' })).rejects.toBeInstanceOf(BusinessDirectoryError);
  });

  it('a memory directory is exact and hides frozen accounts on lookup', async () => {
    const directory = memoryBusinessDirectory([
      { userId: 'a', handle: 'Ada_Admin', email: 'Ada@Example.com', status: 'active' },
      { userId: 'f', handle: 'Fro_Zen', email: 'fro@example.com', status: 'frozen' },
    ]);
    expect(await directory.handlesOf(['a', 'f', 'missing'])).toEqual(
      new Map([
        ['a', 'Ada_Admin'],
        ['f', 'Fro_Zen'],
      ]),
    );
    expect(await directory.findActive({ handle: 'ada_admin' })).toEqual({ userId: 'a', handle: 'Ada_Admin' });
    expect(await directory.findActive({ email: 'ada@example.com' })).toEqual({ userId: 'a', handle: 'Ada_Admin' });
    expect(await directory.findActive({ handle: 'Fro_Zen' })).toBeNull();
    expect(await directory.findActive({ email: 'nobody@example.com' })).toBeNull();
  });

  it('reads identity and treats a missing route as unset', async () => {
    // The signed headers carry a whole-second timestamp: one clock for the code and the check, so a second boundary between
    // them can't fail the comparison (issue #6598).
    vi.useFakeTimers({ now: new Date('2026-10-29T06:00:00.500Z'), toFake: ['Date'] });
    onTestFinished(() => void vi.useRealTimers());
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      const body = String(init.body);
      expect(init.headers).toMatchObject(serviceAuthHeadersForBody('svc-bank', SECRET, body));
      if (String(url).endsWith(BUSINESS_DIRECTORY_HANDLES_PATH)) {
        return new Response(JSON.stringify({ handles: [{ userId: 'a', handle: 'Ada_Admin' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ found: true, userId: 'a', handle: 'Ada_Admin' }), { status: 200 });
    });
    const directory = createIdentityBusinessDirectory('http://identity.test', SECRET, fetchFn as typeof fetch);
    expect([...(await directory.handlesOf(['a'])).entries()]).toEqual([['a', 'Ada_Admin']]);
    expect(await directory.findActive({ email: 'ada@example.com' })).toEqual({ userId: 'a', handle: 'Ada_Admin' });
    expect(String(fetchFn.mock.calls[1]?.[0])).toContain(BUSINESS_DIRECTORY_RECIPIENT_PATH);
  });

  it('a 404 names the unpublished directory route', async () => {
    const fetchFn = vi.fn(async () => new Response('no', { status: 404 }));
    const directory = createIdentityBusinessDirectory('http://identity.test', SECRET, fetchFn as typeof fetch);
    await expect(directory.handlesOf(['a'])).rejects.toMatchObject({
      reason: 'unset',
      message: expect.stringContaining(BUSINESS_DIRECTORY_HANDLES_PATH),
    });
  });

  it('a transport failure is unavailable and does not invent a handle', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const directory = createIdentityBusinessDirectory('http://identity.test', SECRET, fetchFn as typeof fetch);
    await expect(directory.findActive({ handle: 'ada' })).rejects.toMatchObject({
      reason: 'unavailable',
      message: expect.stringContaining('bank.business_directory_unavailable'),
    });
  });
});
