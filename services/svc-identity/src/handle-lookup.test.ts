import { describe, expect, it, vi } from 'vitest';
import { SESSION_SCOPES, issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createIdentityRouter } from './router.js';
import type { AuthService } from './auth/auth-service.js';
import type { RankService } from './rank/rank-service.js';
import { DEFAULT_HANDLE_LOOKUP_LIMIT, HandleLookupLimiter, normaliseHandleQuery } from './handle-lookup.js';

/**
 * `identity.me` and `identity.users.resolveHandle` at the tRPC boundary, with a
 * stub service. The SQL itself (exact, case-insensitive, frozen and closed
 * accounts) is proved against real Postgres in `handle-lookup.pg.test.ts`.
 */

const authConfig = {
  secret: 'an-identity-router-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const ME = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';
const HIDDEN = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';

async function ctx(opts: { anonymous?: boolean; userId?: string; apiKeyId?: string } = {}): Promise<Context> {
  if (opts.anonymous) return { principal: null, service: null, region: 'DE', requestId: 'req-1' };
  const { token } = await issueAccessToken(
    {
      userId: opts.userId ?? ME,
      sessionId: SESSION,
      scopes: [...SESSION_SCOPES],
      tier: 'none',
      mfa: true,
      ...(opts.apiKeyId ? { apiKeyId: opts.apiKeyId } : {}),
    },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-1' };
}

const users = new Map([
  ['luffy', { userId: FRIEND, handle: 'Luffy', discoverable: true }],
  ['me_self', { userId: ME, handle: 'Me_Self', discoverable: true }],
  ['hidden_one', { userId: HIDDEN, handle: 'Hidden_One', discoverable: false }],
]);

function setup(limiter?: HandleLookupLimiter) {
  const findActiveByHandle = vi.fn(async (handle: string) => users.get(handle.toLowerCase()) ?? null);
  const handleOf = vi.fn(async (userId: string) => (userId === ME ? 'Me_Self' : null));
  const selfView = vi.fn(async (userId: string) => (userId === ME ? { handle: 'Me_Self', emailVerified: false } : null));
  const auth = { findActiveByHandle, handleOf, selfView } as unknown as AuthService;
  const router = createIdentityRouter(auth, {} as unknown as RankService, {
    registrationOpen: true,
    ...(limiter ? { handleLookupLimiter: limiter } : {}),
  });
  return { router, findActiveByHandle, handleOf };
}

describe('identity.users.resolveHandle', () => {
  it('refuses an unauthenticated caller and does not touch the database', async () => {
    const { router, findActiveByHandle } = setup();
    const api = router.createCaller(await ctx({ anonymous: true }));
    await expect(api.users.resolveHandle({ handle: 'luffy' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(api.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(findActiveByHandle).not.toHaveBeenCalled();
  });

  it('refuses an API key: only a signed-in session may probe handles', async () => {
    const { router, findActiveByHandle } = setup();
    const api = router.createCaller(await ctx({ apiKeyId: '55555555-5555-4555-8555-555555555555' }));
    await expect(api.users.resolveHandle({ handle: 'luffy' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(findActiveByHandle).not.toHaveBeenCalled();
  });

  it('resolves an exact handle and returns exactly userId, handle, self', async () => {
    const { router } = setup();
    const api = router.createCaller(await ctx());
    const hit = await api.users.resolveHandle({ handle: 'Luffy' });
    expect(hit).toEqual({ found: true, userId: FRIEND, handle: 'Luffy', self: false });
    expect(Object.keys(hit).sort()).toEqual(['found', 'handle', 'self', 'userId']);
  });

  it('accepts the leading @ the UI shows and ignores surrounding space', async () => {
    const { router, findActiveByHandle } = setup();
    const api = router.createCaller(await ctx());
    await api.users.resolveHandle({ handle: '  @luffy ' });
    expect(findActiveByHandle).toHaveBeenCalledWith('luffy');
  });

  it('marks your own handle self:true so the UI can refuse paying yourself', async () => {
    const { router } = setup();
    const api = router.createCaller(await ctx());
    expect(await api.users.resolveHandle({ handle: '@me_self' })).toEqual({
      found: true,
      userId: ME,
      handle: 'Me_Self',
      self: true,
    });
  });

  it('answers an undiscoverable handle exactly like an unknown one, for everyone but its owner (PP-send-request-03)', async () => {
    const { router } = setup();
    const stranger = router.createCaller(await ctx());
    expect(await stranger.users.resolveHandle({ handle: 'hidden_one' })).toEqual(
      await stranger.users.resolveHandle({ handle: 'nobodyhere' }),
    );
    const owner = router.createCaller(await ctx({ userId: HIDDEN }));
    expect(await owner.users.resolveHandle({ handle: '@Hidden_One' })).toEqual({
      found: true,
      userId: HIDDEN,
      handle: 'Hidden_One',
      self: true,
    });
  });

  it('gives one identical answer for unknown and malformed handles', async () => {
    const { router, findActiveByHandle } = setup();
    const api = router.createCaller(await ctx());
    const unknown = await api.users.resolveHandle({ handle: 'nobodyhere' });
    expect(unknown).toEqual({ found: false });
    for (const bad of ['lu', 'luf%', 'lu*', 'a b c', '@@luffy', '', 'x'.repeat(33)]) {
      expect(await api.users.resolveHandle({ handle: bad })).toEqual(unknown);
    }
    // Malformed handles never reach the database, so they cannot act as patterns.
    expect(findActiveByHandle).toHaveBeenCalledTimes(1);
  });

  it('rate limits per caller: the 31st lookup in a minute is refused with a named code', async () => {
    let now = 1_000_000;
    const { router } = setup(new HandleLookupLimiter(DEFAULT_HANDLE_LOOKUP_LIMIT, () => now));
    const api = router.createCaller(await ctx());
    for (let i = 0; i < 30; i += 1) await api.users.resolveHandle({ handle: 'nobodyhere' });
    const refused = await api.users.resolveHandle({ handle: 'nobodyhere' }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect((refused as Error).message).toContain('identity.handle_lookup_rate_limited');

    // A different caller has their own budget.
    const other = router.createCaller(await ctx({ userId: FRIEND }));
    expect(await other.users.resolveHandle({ handle: 'nobodyhere' })).toEqual({ found: false });

    // The window slides: a minute later the first caller is served again.
    now += 60_001;
    expect(await api.users.resolveHandle({ handle: 'nobodyhere' })).toEqual({ found: false });
  });

  it('counts malformed and unknown lookups against the budget, not only hits', async () => {
    const { router } = setup(new HandleLookupLimiter({ max: 2, windowMs: 60_000 }, () => 5));
    const api = router.createCaller(await ctx());
    await api.users.resolveHandle({ handle: '%%' });
    await api.users.resolveHandle({ handle: 'nobodyhere' });
    await expect(api.users.resolveHandle({ handle: 'luffy' })).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });
});

describe('identity.me', () => {
  it('returns exactly the caller userId and handle', async () => {
    const { router } = setup();
    const me = await router.createCaller(await ctx()).me();
    expect(me).toEqual({ userId: ME, handle: 'Me_Self', emailVerified: false });
  });
});

describe('normaliseHandleQuery', () => {
  it('accepts registration-shaped handles only', () => {
    expect(normaliseHandleQuery('@Abc_123')).toBe('Abc_123');
    expect(normaliseHandleQuery('ab')).toBeNull();
    expect(normaliseHandleQuery('abc%')).toBeNull();
    expect(normaliseHandleQuery('abc def')).toBeNull();
  });
});
