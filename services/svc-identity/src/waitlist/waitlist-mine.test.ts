import { describe, expect, it, vi } from 'vitest';
import { SESSION_SCOPES, issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createIdentityRouter } from '../router.js';
import type { AuthService } from '../auth/auth-service.js';
import type { RankService } from '../rank/rank-service.js';
import { MemoryWaitlistStore } from './waitlist-store.js';
import { WaitlistService } from './waitlist-service.js';

/**
 * `identity.waitlist.mine` (RC-campaigns-05, J-campaigns-20 #4): the signed-in caller's own place in the queue, found by
 * the account's confirmed email from the session, never from the request.
 */

const authConfig = {
  secret: 'an-identity-router-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const ME = '11111111-1111-4111-8111-111111111111';
const UNCONFIRMED = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';

async function ctx(userId: string | null): Promise<Context> {
  if (userId === null) return { principal: null, service: null, region: 'DE', requestId: 'req-1' };
  const { token } = await issueAccessToken(
    { userId, sessionId: SESSION, scopes: [...SESSION_SCOPES], tier: 'none', mfa: true },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-1' };
}

const emails = new Map([
  [ME, { email: 'Me@Example.com', emailVerified: true }],
  [UNCONFIRMED, { email: 'friend@example.com', emailVerified: false }],
  [STRANGER, { email: 'stranger@example.com', emailVerified: true }],
]);

async function setup(overrides: Record<string, boolean> = {}) {
  const store = new MemoryWaitlistStore();
  const waitlist = new WaitlistService(store, { drop: '0', overrides });
  const selfEmail = vi.fn(async (userId: string) => emails.get(userId) ?? null);
  const router = createIdentityRouter({ selfEmail } as unknown as AuthService, {} as unknown as RankService, {
    registrationOpen: true,
    waitlist,
  });
  const open = new WaitlistService(store, { drop: '0' });
  const me = await open.enroll({ email: 'me@example.com' });
  await open.enroll({ email: 'friend@example.com' });
  await open.enroll({ email: 'other@example.com', referralCode: me.entry.referralCode });
  return { router, selfEmail, me };
}

describe('identity.waitlist.mine', () => {
  it("returns the caller's own place, matched on the account's confirmed email", async () => {
    const { router, me } = await setup();
    const out = await router.createCaller(await ctx(ME)).waitlist.mine();
    expect(out).toEqual({
      position: 1,
      referralCode: me.entry.referralCode,
      referredCount: 1,
      queueLength: 3,
      rank: 1,
      waiting: 3,
      release: null,
    });
  });

  it('returns null when the account email never joined', async () => {
    const { router } = await setup();
    await expect(router.createCaller(await ctx(STRANGER)).waitlist.mine()).resolves.toBeNull();
  });

  it('refuses waitlist.email_unverified for an unconfirmed email, so a typed address reads nothing', async () => {
    const { router } = await setup();
    const err = await router
      .createCaller(await ctx(UNCONFIRMED))
      .waitlist.mine()
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'FORBIDDEN' });
    expect(String((err as Error).message)).toContain('[waitlist.email_unverified]');
  });

  it('refuses a signed-out caller before any lookup', async () => {
    const { router, selfEmail } = await setup();
    await expect(router.createCaller(await ctx(null)).waitlist.mine()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(selfEmail).not.toHaveBeenCalled();
  });

  it('refuses by flag name when the waitlist is switched off', async () => {
    const { router } = await setup({ 'waitlist.enabled': false });
    const err = await router
      .createCaller(await ctx(ME))
      .waitlist.mine()
      .catch((e: unknown) => e);
    expect(String((err as Error).message)).toContain('flag.waitlist.enabled.disabled');
  });
});
