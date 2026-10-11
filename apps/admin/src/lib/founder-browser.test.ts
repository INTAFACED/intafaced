import { afterEach, describe, expect, it, vi } from 'vitest';
import { founderMutationHeaders } from './founder-browser.js';
import { invokeOperatorToolBrowser } from './operator-tools-browser.js';
import { postKillSwitch } from './control-plane-browser.js';
import { postFreeze } from './ledger-freeze-browser.js';

const CSRF = Buffer.alloc(32, 11).toString('base64url');
const NEVER_CLIENT_TOKEN = 'a-jwt-or-shared-operator-token-must-never-appear';

afterEach(() => vi.unstubAllGlobals());

describe('founder browser mutation nonce', () => {
  it('fetches the current session without caching and returns only mutation headers', async () => {
    const fetchMock = vi.fn(async () => Response.json({ csrf: CSRF }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(founderMutationHeaders()).resolves.toEqual({
      'content-type': 'application/json',
      'x-intafaced-csrf': CSRF,
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/session', { cache: 'no-store', credentials: 'same-origin' });
  });

  it.each([
    ['expired or absent founder session', new Response('{}', { status: 401 })],
    ['malformed nonce', Response.json({ csrf: 'not-a-canonical-nonce' })],
    ['session response with no nonce', Response.json({ userId: 'founder' })],
  ])('prevents all three mutations when /api/session returns %s', async (_case, sessionResponse) => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => sessionResponse.clone());
    vi.stubGlobal('fetch', fetchMock);
    const results = await Promise.all([
      invokeOperatorToolBrowser('identity.kyc.pending', {}),
      postKillSwitch({ module: 'trade', disabled: true, reason: 'incident' }),
      postFreeze({ frozen: true, reason: 'incident' }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([url]) => url === '/api/session')).toBe(true);
    expect(results[0]).toMatchObject({ ok: false, status: 502, delivered: false });
    expect(results[1]).toMatchObject({ ok: false, status: 502 });
    expect(results[2]).toMatchObject({ ok: false, status: 502 });
  });

  it('sends the nonce on each protected mutation and never sends a JWT or shared operator token', async () => {
    const calls: { url: string | URL | Request; init?: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url, init });
      if (String(url) === '/api/session') return Response.json({ csrf: CSRF });
      if (String(url) === '/api/operator-tools') {
        return Response.json({
          ok: true,
          status: 200,
          detail: null,
          delivered: true,
          data: [],
          toolId: 'identity.kyc.pending',
          procedure: 'kyc.pending',
          edgePath: '/api/identity/trpc/kyc.pending',
        });
      }
      if (String(url) === '/api/kill-switch') {
        return Response.json({ ok: true, status: 200, snapshot: { disabledModules: [], reasons: {}, audit: [] }, detail: null });
      }
      return Response.json({
        ok: true,
        status: 200,
        state: { frozen: true, reason: 'incident', actor: 'founder', changedAt: '2026-10-10T00:00:00.000Z' },
        detail: null,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    expect((await invokeOperatorToolBrowser('identity.kyc.pending', {})).ok).toBe(true);
    expect((await postKillSwitch({ module: 'trade', disabled: true, reason: 'incident' })).ok).toBe(true);
    expect((await postFreeze({ frozen: true, reason: 'incident' })).ok).toBe(true);

    const mutations = calls.filter(({ init }) => init?.method === 'POST');
    expect(mutations).toHaveLength(3);
    for (const { init } of mutations) {
      const headers = new Headers(init?.headers);
      expect(headers.get('x-intafaced-csrf')).toBe(CSRF);
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.has('authorization')).toBe(false);
      expect(headers.has('x-intafaced-admin-bff')).toBe(false);
      expect(JSON.stringify(init?.body)).not.toContain(NEVER_CLIENT_TOKEN);
    }
    expect(calls.every(({ url }) => String(url).startsWith('/api/'))).toBe(true);
  });
});
