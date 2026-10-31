import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import type { Context } from '@intafaced/contracts';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { createSigninMethodsRouter } from '../signin-methods-router.js';
import { SocialSignin } from '../social/social-signin.js';
import { AuthService } from './auth-service.js';
import { SecurityStepUpError, type SecurityStepUp } from './security-step-up.js';
import { listSigninMethods, startWalletChallenge, WALLET_CHALLENGE_TTL_MS } from './signin-methods.js';
import { unenrollPasskey } from './unenroll-passkey.js';

/**
 * Link and unlink sign-in methods (I-account-lifecycle-07, J-identity-04 #7): a wallet proved by its signature, a phone
 * refused while texted codes have no provider, the last way in kept. Every key and number here is a TEST fixture.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const PASSWORD = 'correct horse battery staple';
const tokenConfig = {
  secret: 'an-identity-test-signing-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const ORIGIN = 'http://localhost:3000';
const webauthnConfig = { rpID: 'localhost', rpName: 'INTAFACED', origin: ORIGIN };
const walletConfig = { origins: [ORIGIN] };

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', '..', 'drizzle', f), 'utf8'));

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('sign-in methods (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(
    db.sql,
    bus,
    rank,
    tokenConfig,
    webauthnConfig,
    randomBytes(32).toString('base64'),
    undefined,
    undefined,
    25,
  );

  /** The stand-in step-up: no approval asks for one; each approval answers once and must bind the method. */
  const stepUps: Array<{ scope: string; fields: Record<string, string> }> = [];
  const stepUp = {
    async require(_principal: unknown, scope: string, fields: Record<string, string>, approvalId?: string | null) {
      if (!approvalId) throw new SecurityStepUpError('identity.step_up_required');
      stepUps.push({ scope, fields });
    },
  } as unknown as SecurityStepUp;
  const social = new SocialSignin(db.sql, { providers: new Map(), flowTtlSeconds: undefined });
  const methodsRouter = createSigninMethodsRouter(db.sql, stepUp, { wallet: walletConfig, social });
  const callerFor = (userId: string) =>
    methodsRouter.createCaller({
      principal: { userId, sid: 'sid-1', scopes: ['identity:read', 'identity:write'], mfa: false },
      service: null,
      region: 'DE',
      requestId: 'req-methods',
    } as unknown as Context);
  const codeOf = async (p: Promise<unknown>) =>
    (
      (await p.then(
        () => null,
        (e: unknown) => e,
      )) as { cause?: { code?: string } } | null
    )?.cause?.code;

  let counter = 0;
  async function person() {
    const handle = `sm${process.pid}x${++counter}`;
    const email = `${handle}@example.com`;
    const session = await auth.register({ handle, email, password: PASSWORD });
    await db.sql`UPDATE users SET email_verified_at = now() WHERE id = ${session.userId}`;
    return { userId: session.userId, handle, email, api: callerFor(session.userId) };
  }

  /** Link a TEST wallet: challenge, signature, then the change with an approval. */
  async function linkWallet(who: Awaited<ReturnType<typeof person>>, key = generatePrivateKey()) {
    const wallet = privateKeyToAccount(key);
    const challenge = await who.api.walletLinkChallenge({ address: wallet.address, chainId: 1 });
    const signature = await wallet.signMessage({ message: challenge.message });
    const method = `wallet_siwe:${wallet.address.toLowerCase()}`;
    const answer = { flowId: challenge.flowId, message: challenge.message, signature };
    expect(await codeOf(who.api.linkSigninMethod({ method, clientRequestId: 'r-1', wallet: answer }))).toBe('identity.step_up_required');
    const methods = await who.api.linkSigninMethod({ method, clientRequestId: 'r-1', stepUpApprovalId: 'ok-1', wallet: answer });
    return { wallet, key, method, methods };
  }

  beforeEach(async () => {
    stepUps.length = 0;
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('the ways an account signs in', () => {
    it('lists the password and the mailed code of a new account, and nothing else', async () => {
      const who = await person();
      expect(await who.api.signinMethods()).toEqual({
        password: true,
        emailCode: { on: true, address: who.email, proved: true },
        passkeys: 0,
        wallets: [],
        providers: [],
      });
    });

    it('links a wallet by its signature after the step-up, which binds the wallet', async () => {
      const who = await person();
      const { wallet, method, methods } = await linkWallet(who);
      expect(methods.wallets.map((w) => w.address)).toEqual([wallet.address.toLowerCase()]);
      expect(stepUps).toEqual([{ scope: 'identity.step_up.link_method', fields: { method, clientRequestId: 'r-1' } }]);
    });

    it('refuses a signature from another key before the step-up, and spends the challenge', async () => {
      const who = await person();
      const wallet = privateKeyToAccount(generatePrivateKey());
      const impostor = privateKeyToAccount(generatePrivateKey());
      const challenge = await who.api.walletLinkChallenge({ address: wallet.address, chainId: 1 });
      const wrong = {
        flowId: challenge.flowId,
        message: challenge.message,
        signature: await impostor.signMessage({ message: challenge.message }),
      };
      const method = `wallet_siwe:${wallet.address.toLowerCase()}`;
      expect(await codeOf(who.api.linkSigninMethod({ method, clientRequestId: 'r-1', stepUpApprovalId: 'ok', wallet: wrong }))).toBe(
        'identity.wallet_signature_invalid',
      );
      expect(stepUps).toEqual([]);
      // The right signature on the same challenge no longer answers: each challenge takes one signature.
      const right = { ...wrong, signature: await wallet.signMessage({ message: challenge.message }) };
      expect(await codeOf(who.api.linkSigninMethod({ method, clientRequestId: 'r-1', stepUpApprovalId: 'ok', wallet: right }))).toBe(
        'identity.wallet_challenge_invalid',
      );
      expect((await listSigninMethods(db.sql, who.userId)).wallets).toEqual([]);
    });

    it('refuses a contract wallet signature, another account challenge, an edited message and a late answer', async () => {
      const who = await person();
      const other = await person();
      const wallet = privateKeyToAccount(generatePrivateKey());
      const method = `wallet_siwe:${wallet.address.toLowerCase()}`;
      const fresh = async (api = who.api) => {
        const c = await api.walletLinkChallenge({ address: wallet.address, chainId: 1 });
        return { flowId: c.flowId, message: c.message, signature: await wallet.signMessage({ message: c.message }) };
      };
      const wrapped = await fresh();
      expect(
        await codeOf(
          who.api.linkSigninMethod({ method, clientRequestId: 'r', wallet: { ...wrapped, signature: `${wrapped.signature}00` } }),
        ),
      ).toBe('identity.wallet_kind_unsupported');
      const theirs = await fresh(other.api);
      expect(await codeOf(who.api.linkSigninMethod({ method, clientRequestId: 'r', wallet: theirs }))).toBe(
        'identity.wallet_challenge_invalid',
      );
      const edited = await fresh();
      const message = edited.message.replace('localhost:3000', 'evil.example');
      const signed = { ...edited, message, signature: await wallet.signMessage({ message }) };
      expect(await codeOf(who.api.linkSigninMethod({ method, clientRequestId: 'r', wallet: signed }))).toBe(
        'identity.wallet_challenge_invalid',
      );
      const late = await startWalletChallenge(
        db.sql,
        { origins: [ORIGIN], now: () => new Date(Date.now() - WALLET_CHALLENGE_TTL_MS - 1_000) },
        { purpose: 'link', address: wallet.address, chainId: 1, userId: who.userId },
      );
      const lateAnswer = { flowId: late.flowId, message: late.message, signature: await wallet.signMessage({ message: late.message }) };
      expect(await codeOf(who.api.linkSigninMethod({ method, clientRequestId: 'r', wallet: lateAnswer }))).toBe(
        'identity.wallet_challenge_invalid',
      );
      // The approval names one wallet: an answer from a different one is refused.
      const right = await fresh();
      expect(
        await codeOf(who.api.linkSigninMethod({ method: `wallet_siwe:0x${'1'.repeat(40)}`, clientRequestId: 'r', wallet: right })),
      ).toBe('identity.wallet_challenge_invalid');
      expect(stepUps).toEqual([]);
    });

    it('refuses a wallet that already signs in to another account, and a second link by the same one changes nothing', async () => {
      const first = await person();
      const second = await person();
      const { key, method } = await linkWallet(first);
      await expect(linkWallet(first, key)).resolves.toMatchObject({ methods: { wallets: [{ address: method.slice(12) }] } });
      const wallet = privateKeyToAccount(key);
      const c = await second.api.walletLinkChallenge({ address: wallet.address, chainId: 1 });
      const answer = { flowId: c.flowId, message: c.message, signature: await wallet.signMessage({ message: c.message }) };
      expect(await codeOf(second.api.linkSigninMethod({ method, clientRequestId: 'r', stepUpApprovalId: 'ok', wallet: answer }))).toBe(
        'identity.method_taken',
      );
    });

    it('refuses a phone number: texted codes need the outside provider, and nothing is stored', async () => {
      const who = await person();
      expect(await codeOf(who.api.linkSigninMethod({ method: 'sms_code', clientRequestId: 'r', phone: '+447700900123' }))).toBe(
        'vendor.sms',
      );
      expect(await codeOf(who.api.linkSigninMethod({ method: 'sms_code', clientRequestId: 'r', phone: '07700' }))).toBeUndefined();
      expect(stepUps).toEqual([]);
      expect(await who.api.signinMethods()).toMatchObject({ wallets: [], providers: [] });
    });

    it('answers a provider link with the switched-off provider', async () => {
      const who = await person();
      expect(await codeOf(who.api.linkProviderStart({ provider: 'social' }))).toBe('idp.social');
    });

    it('links a provider account only after the step-up, from a state this account started, and removes it again', async () => {
      const providers = new SocialSignin(db.sql, {
        providers: new Map([
          [
            'fake',
            {
              status: 'ready' as const,
              port: {
                authorizationUrl: ({ state }: { state: string }) => `https://provider.test/authorize?state=${state}`,
                exchange: async ({ code }: { code: string }) => ({ subject: code }),
              },
            },
          ],
        ]),
        flowTtlSeconds: 600,
      });
      const linking = createSigninMethodsRouter(db.sql, stepUp, { wallet: walletConfig, social: providers });
      const as = (userId: string) =>
        linking.createCaller({
          principal: { userId, sid: 'sid-1', scopes: ['identity:read', 'identity:write'], mfa: false },
          service: null,
          region: 'DE',
          requestId: 'req-social',
        } as unknown as Context);
      const who = await person();
      const other = await person();
      const started = await as(who.userId).linkProviderStart({ provider: 'fake' });
      const state = new globalThis.URL(started.authorizationUrl).searchParams.get('state')!;
      const back = { provider: 'fake', state, code: 'subject-1', clientRequestId: 'p-1' };
      // No confirmation yet: refused, and the state stays usable.
      expect(await codeOf(as(who.userId).linkProviderComplete(back))).toBe('identity.step_up_required');
      // Another account cannot finish this account's link.
      const restarted = await as(who.userId).linkProviderStart({ provider: 'fake' });
      const another = new globalThis.URL(restarted.authorizationUrl).searchParams.get('state')!;
      expect(await codeOf(as(other.userId).linkProviderComplete({ ...back, state: another, stepUpApprovalId: 'ok' }))).toBe(
        'identity.social_flow_invalid',
      );
      stepUps.length = 0;
      const linked = await as(who.userId).linkProviderComplete({ ...back, stepUpApprovalId: 'ok' });
      expect(linked.providers).toEqual(['fake']);
      expect(stepUps).toEqual([{ scope: 'identity.step_up.link_method', fields: { method: 'social:fake', clientRequestId: 'p-1' } }]);
      const after = await as(who.userId).unlinkSigninMethod({ method: 'social:fake', clientRequestId: 'p-2', stepUpApprovalId: 'ok' });
      expect(after.providers).toEqual([]);
    });

    it('refuses the mailed code for an address that was never proved', async () => {
      const who = await person();
      await db.sql`UPDATE users SET email_verified_at = NULL, email_code_signin = false WHERE id = ${who.userId}`;
      expect(await codeOf(who.api.linkSigninMethod({ method: 'email_code', clientRequestId: 'r', stepUpApprovalId: 'ok' }))).toBe(
        'identity.method_unverified',
      );
    });
  });

  describe('removing a way in', () => {
    it('does not count a mailed code to an address never proved, so the password stays the last way in', async () => {
      const who = await person();
      await db.sql`UPDATE users SET email_verified_at = NULL WHERE id = ${who.userId}`;
      expect(await who.api.signinMethods()).toMatchObject({ password: true, emailCode: { on: true, proved: false } });
      expect(await codeOf(who.api.unlinkSigninMethod({ method: 'password', clientRequestId: 'u-p', stepUpApprovalId: 'ok' }))).toBe(
        'identity.last_signin_method',
      );
    });

    it('removes the mailed code and the password, then refuses the last way in before any step-up', async () => {
      const who = await person();
      const { method } = await linkWallet(who);
      stepUps.length = 0;
      await who.api.unlinkSigninMethod({ method: 'email_code', clientRequestId: 'u-1', stepUpApprovalId: 'ok-2' });
      const after = await who.api.unlinkSigninMethod({ method: 'password', clientRequestId: 'u-2', stepUpApprovalId: 'ok-3' });
      expect(after).toMatchObject({ password: false, emailCode: { on: false } });
      expect(await codeOf(who.api.unlinkSigninMethod({ method, clientRequestId: 'u-3', stepUpApprovalId: 'ok-4' }))).toBe(
        'identity.last_signin_method',
      );
      expect(stepUps.map((s) => s.fields.method)).toEqual(['email_code', 'password']);
      // The old password no longer signs in, and no mailed code is sent.
      await expect(auth.login({ identifier: who.email, password: PASSWORD })).rejects.toMatchObject({ code: 'auth.invalid_credentials' });
    });

    it('keeps the last passkey when nothing else remains, by either remover', async () => {
      const who = await person();
      await db.sql`
        UPDATE users SET password_set = false, email_code_signin = false,
          webauthn_creds = ${db.sql.json([{ credentialId: 'Y3JlZC1h', publicKey: 'AQID', counter: 0 }])}
        WHERE id = ${who.userId}`;
      await expect(unenrollPasskey(db.sql, who.userId, 'Y3JlZC1h')).rejects.toMatchObject({ code: 'identity.last_signin_method' });
      await expect(
        auth.removeWebauthnCredential(who.userId, { delegated: false, privileged: false, mfa: true }, 'Y3JlZC1h'),
      ).rejects.toMatchObject({ code: 'identity.last_signin_method' });
      await linkWallet(who);
      await expect(unenrollPasskey(db.sql, who.userId, 'Y3JlZC1h')).resolves.toMatchObject({ remaining: 0 });
    });

    it('sets a password again on an account that stopped using one, under the password policy', async () => {
      const who = await person();
      await who.api.unlinkSigninMethod({ method: 'password', clientRequestId: 'u', stepUpApprovalId: 'ok' });
      expect(await codeOf(who.api.linkSigninMethod({ method: 'password', clientRequestId: 'p', password: 'short' }))).toBe(
        'auth.password_policy',
      );
      const next = 'a different long enough passphrase';
      await who.api.linkSigninMethod({ method: 'password', clientRequestId: 'p', stepUpApprovalId: 'ok-p', password: next });
      await expect(auth.login({ identifier: who.email, password: next })).resolves.toMatchObject({ userId: who.userId });
      expect(await codeOf(who.api.linkSigninMethod({ method: 'password', clientRequestId: 'p2', password: next }))).toBe(
        'identity.method_already_linked',
      );
      // Removing the password and setting one again are each a password change for the inbox; refusals queue nothing.
      expect(await db.sql`SELECT change FROM security_factor_events WHERE user_id = ${who.userId} ORDER BY created_at`).toEqual([
        { change: 'password_changed' },
        { change: 'password_changed' },
      ]);
    });
  });

  describe('signing in with a wallet', () => {
    it('signs in the account that linked the wallet, and refuses an unlinked one the same way as a wrong password', async () => {
      const who = await person();
      const { wallet } = await linkWallet(who);
      const c = await auth.walletSigninChallenge({ address: wallet.address, chainId: 1 });
      const session = await auth.loginWithWallet({
        flowId: c.flowId,
        message: c.message,
        signature: await wallet.signMessage({ message: c.message }),
      });
      expect(session.userId).toBe(who.userId);
      // Spent: the same answer does not sign in twice.
      await expect(
        auth.loginWithWallet({ flowId: c.flowId, message: c.message, signature: await wallet.signMessage({ message: c.message }) }),
      ).rejects.toMatchObject({ code: 'identity.wallet_challenge_invalid' });

      const stranger = privateKeyToAccount(generatePrivateKey());
      const s = await auth.walletSigninChallenge({ address: stranger.address, chainId: 1 });
      await expect(
        auth.loginWithWallet({ flowId: s.flowId, message: s.message, signature: await stranger.signMessage({ message: s.message }) }),
      ).rejects.toMatchObject({ code: 'auth.invalid_credentials' });
    });

    it('still asks for the second step after the wallet', async () => {
      const who = await person();
      const { wallet } = await linkWallet(who);
      await db.sql`UPDATE users SET totp_secret = 'sealed-test-secret' WHERE id = ${who.userId}`;
      const c = await auth.walletSigninChallenge({ address: wallet.address, chainId: 1 });
      await expect(
        auth.loginWithWallet({ flowId: c.flowId, message: c.message, signature: await wallet.signMessage({ message: c.message }) }),
      ).rejects.toMatchObject({ code: 'auth.mfa_required' });
    });
  });
}
