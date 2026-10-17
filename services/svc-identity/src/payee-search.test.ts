import { describe, expect, it, vi } from 'vitest';
import { SESSION_SCOPES, issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createIdentityRouter } from './router.js';
import type { AuthService } from './auth/auth-service.js';
import type { RankService } from './rank/rank-service.js';
import { HandleLookupLimiter } from './handle-lookup.js';

/**
 * `identity.users.searchPayees` at the tRPC boundary. The SQL (exact match,
 * consent, frozen) is proved in `payee-search.pg.test.ts`.
 */

const authConfig = {
  secret: 'an-identity-payee-search-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const ME = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';

async function ctx(opts: { anonymous?: boolean; apiKeyId?: string } = {}): Promise<Context> {
  if (opts.anonymous) return { principal: null, service: null, region: 'DE', requestId: 'req-1' };
  const { token } = await issueAccessToken(
    {
      userId: ME,
      sessionId: '44444444-4444-4444-8444-444444444444',
      scopes: [...SESSION_SCOPES],
      tier: 'none',
      mfa: true,
      ...(opts.apiKeyId ? { apiKeyId: opts.apiKeyId } : {}),
    },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-1' };
}

function setup(found: { userId: string; handle: string } | null = { userId: FRIEND, handle: 'Luffy' }) {
  const searchPayee = vi.fn(async () => found);
  const auth = { searchPayee, findActiveByHandle: vi.fn(), selfView: vi.fn(), handleOf: vi.fn() } as unknown as AuthService;
  const router = createIdentityRouter(auth, {} as unknown as RankService, { registrationOpen: true });
  return { router, searchPayee };
}

describe('identity.users.searchPayees', () => {
  it('refuses a signed-out caller and an API key before any lookup', async () => {
    const { router, searchPayee } = setup();
    await expect(router.createCaller(await ctx({ anonymous: true })).users.searchPayees({ email: 'a@b.co' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      router.createCaller(await ctx({ apiKeyId: '55555555-5555-4555-8555-555555555555' })).users.searchPayees({ email: 'a@b.co' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(searchPayee).not.toHaveBeenCalled();
  });

  it('returns handle, user id and self, and not the email', async () => {
    const { router, searchPayee } = setup();
    const hit = await router.createCaller(await ctx()).users.searchPayees({ email: 'Luffy@Example.com' });
    expect(hit).toEqual({ found: true, userId: FRIEND, handle: 'Luffy', self: false });
    expect(Object.keys(hit).sort()).toEqual(['found', 'handle', 'self', 'userId']);
    expect(searchPayee).toHaveBeenCalledWith({ email: 'luffy@example.com' });
  });

  it('uses one miss for a malformed address and does not query', async () => {
    const { router, searchPayee } = setup();
    expect(await router.createCaller(await ctx()).users.searchPayees({ email: 'not-an-email' })).toEqual({ found: false });
    expect(await router.createCaller(await ctx()).users.searchPayees({ phone: '555' })).toEqual({ found: false });
    expect(searchPayee).not.toHaveBeenCalled();
  });

  it('refuses both an email and a phone in one call', async () => {
    const { router } = setup();
    await expect(router.createCaller(await ctx()).users.searchPayees({ email: 'a@b.co', phone: '+14155552671' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('shares the handle-lookup budget', async () => {
    const limiter = new HandleLookupLimiter({ max: 1, windowMs: 60_000 }, () => 1_000);
    const searchPayee = vi.fn(async () => null);
    const auth = {
      searchPayee,
      findActiveByHandle: vi.fn(async () => null),
      selfView: vi.fn(),
      handleOf: vi.fn(),
    } as unknown as AuthService;
    const api = createIdentityRouter(auth, {} as unknown as RankService, {
      registrationOpen: true,
      handleLookupLimiter: limiter,
    }).createCaller(await ctx());
    expect(await api.users.searchPayees({ email: 'a@b.co' })).toEqual({ found: false });
    await expect(api.users.searchPayees({ email: 'a@b.co' })).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });
});
