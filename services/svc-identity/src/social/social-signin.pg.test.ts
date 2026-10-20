import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import type { Context } from '@intafaced/contracts';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from '../auth/auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { createIdentityRouter } from '../router.js';
import { SocialSignin, type SocialProfile, type SocialProviderEntry } from './social-signin.js';

/** Account-side social sign-in against real Postgres, with a fake provider port. */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));
const tokenConfig = {
  secret: 'an-identity-test-signing-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

if (!(await postgresAvailable(URL))) {
  describe.skip('social sign-in (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_social',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const auth = new AuthService(db.sql, bus, new RankService(db.sql, bus), tokenConfig);
  afterAll(async () => {
    await db.drop();
  });

  /** The fake provider: the code is the subject, so a test chooses who "signs in". */
  const fake = (profileFor: (code: string) => SocialProfile = (code) => ({ subject: code })): SocialProviderEntry => ({
    status: 'ready',
    port: {
      authorizationUrl: ({ state }) => `https://provider.test/authorize?state=${state}`,
      exchange: async ({ code }) => profileFor(code),
    },
  });
  const social = (providers: Record<string, SocialProviderEntry>, flowTtlSeconds: number | null = 600) =>
    new SocialSignin(db.sql, { providers: new Map(Object.entries(providers)), flowTtlSeconds: flowTtlSeconds ?? undefined });
  const callerFor = (s?: SocialSignin) => {
    const ctx: Context = { principal: null as never, service: null, region: 'DE', requestId: 'r' };
    return createIdentityRouter(auth, new RankService(db.sql, bus), { registrationOpen: true, ...(s ? { social: s } : {}) }).createCaller(
      ctx,
    );
  };
  const signUp = async (handle: string) =>
    (await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' })).userId;
  const stateOf = (url: string) => new globalThis.URL(url).searchParams.get('state')!;

  describe('social sign-in, no provider', () => {
    it('answers idp.social to a start and a complete, with or without a registry', async () => {
      for (const caller of [callerFor(), callerFor(social({}))]) {
        await expect(caller.auth.oauthStart({ provider: 'any-provider' })).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: expect.stringContaining('[idp.social]'),
        });
        await expect(caller.auth.oauthComplete({ provider: 'any-provider', state: 's', code: 'c' })).rejects.toMatchObject({
          message: expect.stringContaining('[idp.social]'),
        });
      }
    });

    it('refuses a provider with partial settings as a config error, never a sign-in', async () => {
      const caller = callerFor(social({ partial: { status: 'incomplete', missing: ['client secret'] } }));
      await expect(caller.auth.oauthStart({ provider: 'partial' })).rejects.toMatchObject({
        message: expect.stringContaining('[identity.social_provider_config_incomplete]'),
      });
    });

    it('refuses a start while the owner has not published the flow lifetime', async () => {
      const caller = callerFor(social({ fake: fake() }, null));
      await expect(caller.auth.oauthStart({ provider: 'fake' })).rejects.toMatchObject({
        message: expect.stringContaining('[identity.social_flow_ttl_unset]'),
      });
    });
  });

  describe('social sign-in, fake provider', () => {
    it('signs in only a linked identity, never by email, and spends the state once', async () => {
      const userId = await signUp('socialone');
      await signUp('socialtwo');
      const providers = social({ fake: fake((code) => ({ subject: code, email: 'socialtwo@example.com', emailVerified: true })) });
      await providers.link(userId, 'fake', { subject: 'subject-one' });
      const caller = callerFor(providers);

      const started = await caller.auth.oauthStart({ provider: 'fake' });
      const state = stateOf(started.authorizationUrl);
      const session = await caller.auth.oauthComplete({ provider: 'fake', state, code: 'subject-one' });
      expect(session.userId).toBe(userId);
      await expect(caller.auth.oauthComplete({ provider: 'fake', state, code: 'subject-one' })).rejects.toMatchObject({
        message: expect.stringContaining('[identity.social_flow_invalid]'),
      });

      // The provider asserts a verified email that matches another account: no link, no session.
      const second = stateOf((await caller.auth.oauthStart({ provider: 'fake' })).authorizationUrl);
      await expect(caller.auth.oauthComplete({ provider: 'fake', state: second, code: 'unknown-subject' })).rejects.toMatchObject({
        message: expect.stringContaining('[identity.social_not_linked]'),
      });
      expect(await providers.findLinked('fake', 'unknown-subject')).toBeNull();
    });

    it('binds a state to its provider and refuses an unknown or expired one', async () => {
      const other = fake();
      const providers = new SocialSignin(db.sql, {
        providers: new Map([
          ['fake', fake()],
          ['other', other],
        ]),
        flowTtlSeconds: 60,
        now: () => new Date(Date.now() - 120_000),
      });
      const started = await providers.start({ provider: 'fake', purpose: 'signin' });
      // started 120 s ago with a 60 s life: expired by the real clock.
      await expect(
        providers.complete({ provider: 'fake', purpose: 'signin', state: stateOf(started.authorizationUrl), code: 'x', now: new Date() }),
      ).rejects.toMatchObject({
        code: 'identity.social_flow_invalid',
      });
      const fresh = await social({ fake: fake(), other }).start({ provider: 'fake', purpose: 'signin' });
      await expect(
        social({ fake: fake(), other }).complete({
          provider: 'other',
          purpose: 'signin',
          state: stateOf(fresh.authorizationUrl),
          code: 'x',
        }),
      ).rejects.toMatchObject({ code: 'identity.social_flow_invalid' });
      await expect(
        social({ fake: fake(), other }).complete({ provider: 'fake', purpose: 'link', state: stateOf(fresh.authorizationUrl), code: 'x' }),
      ).rejects.toMatchObject({ code: 'identity.social_flow_invalid' });
    });

    it('still asks for the second factor after a provider sign-in', async () => {
      const userId = await signUp('socialtotp');
      await db.sql`UPDATE users SET totp_secret = 'not-a-real-secret' WHERE id = ${userId}`;
      const providers = social({ fake: fake() });
      await providers.link(userId, 'fake', { subject: 'totp-subject' });
      const caller = callerFor(providers);
      const state = stateOf((await caller.auth.oauthStart({ provider: 'fake' })).authorizationUrl);
      await expect(caller.auth.oauthComplete({ provider: 'fake', state, code: 'totp-subject' })).rejects.toMatchObject({
        cause: expect.objectContaining({ code: 'auth.mfa_required' }),
      });
      const again = stateOf((await caller.auth.oauthStart({ provider: 'fake' })).authorizationUrl);
      await expect(
        caller.auth.oauthComplete({ provider: 'fake', state: again, code: 'totp-subject', totpCode: '000000' }),
      ).rejects.toBeTruthy();
    });
  });

  describe('linked provider identities', () => {
    it('allows one account per provider identity and one identity per provider per account', async () => {
      const a = await signUp('linkera');
      const b = await signUp('linkerb');
      const providers = social({ fake: fake() });
      await providers.link(a, 'fake', { subject: 'shared', relayEmail: 'relay@example.test' });
      await providers.link(a, 'fake', { subject: 'shared' });
      await expect(providers.link(b, 'fake', { subject: 'shared' })).rejects.toMatchObject({ code: 'identity.provider_taken' });
      await expect(providers.link(a, 'fake', { subject: 'another-subject' })).rejects.toMatchObject({ code: 'identity.provider_taken' });
      const [row] = await db.sql<
        Array<{ relay_email: string | null }>
      >`SELECT relay_email FROM social_identities WHERE provider = 'fake' AND subject = 'shared'`;
      expect(row?.relay_email).toBe('relay@example.test');
    });

    it('refuses to unlink the last sign-in method and allows it once another remains', async () => {
      const providers = social({ fake: fake(), second: fake() });
      const socialOnly = await signUp('socialonly');
      await db.sql`UPDATE users SET password_set = false WHERE id = ${socialOnly}`;
      await providers.link(socialOnly, 'fake', { subject: 'only-one' });
      await expect(providers.unlink(socialOnly, 'fake')).rejects.toMatchObject({ code: 'identity.last_signin_method' });
      await providers.link(socialOnly, 'second', { subject: 'only-two' });
      await providers.unlink(socialOnly, 'fake');
      expect(await providers.findLinked('fake', 'only-one')).toBeNull();
      await expect(providers.unlink(socialOnly, 'fake')).rejects.toMatchObject({ code: 'auth.not_found' });
      await expect(providers.unlink(socialOnly, 'second')).rejects.toMatchObject({ code: 'identity.last_signin_method' });

      const withPassword = await signUp('socialpw');
      await providers.link(withPassword, 'fake', { subject: 'pw-subject' });
      await providers.unlink(withPassword, 'fake');
      expect(await providers.findLinked('fake', 'pw-subject')).toBeNull();
    });
  });
}
