import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb, postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { SESSION_SCOPES, issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { mergeRouters, type Context } from '@intafaced/contracts';
import { AuthService } from './auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { createIdentityRouter } from '../router.js';
import { createEnrollPasskeyRouter } from '../enroll-passkey-router.js';
import { createUnenrollPasskeyRouter } from '../unenroll-passkey-router.js';
import { totp } from './totp.js';
import { encodeCbor } from './cbor.js';
import { b64urlEncode, buildAuthenticatorData, buildClientDataJSON, coseKeyFromJwk, type RegistrationResponseJSON } from './webauthn.js';

/**
 * Adding or removing a second factor needs an MFA session, except the FIRST
 * factor on an account that has none (and not even that for privileged identities).
 *
 * Real Postgres + the real router + real signed access tokens. The attack under
 * test: a stolen PASSWORD gives a non-MFA session; on an account that already has
 * a passkey it must not be able to add the attacker's own TOTP / passkey.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
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
const webauthnConfig = { rpID: 'localhost', rpName: 'INTAFACED', origin: 'http://localhost:3000' };

function softAuthenticator() {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const cose = coseKeyFromJwk(publicKey.export({ format: 'jwk' }) as { x: string; y: string });
  const credId = randomBytes(16);
  return {
    registrationResponse(challenge: string): RegistrationResponseJSON {
      const clientDataJSON = buildClientDataJSON({ type: 'webauthn.create', challenge, origin: webauthnConfig.origin });
      const authData = buildAuthenticatorData({
        rpID: webauthnConfig.rpID,
        counter: 0,
        credential: { id: credId, publicKeyCose: cose },
      });
      const attestationObject = Buffer.from(
        encodeCbor(
          new Map<string | number, unknown>([
            ['fmt', 'none'],
            ['attStmt', new Map()],
            ['authData', new Uint8Array(authData)],
          ]) as never,
        ),
      );
      return {
        id: b64urlEncode(credId),
        rawId: b64urlEncode(credId),
        type: 'public-key',
        response: {
          clientDataJSON: b64urlEncode(clientDataJSON),
          attestationObject: b64urlEncode(attestationObject),
          transports: ['internal'],
        },
      };
    },
  };
}

const PASSWORD_SESSION = { mfa: false, privileged: false } as const;
const MFA_SESSION = { mfa: true, privileged: false } as const;

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('factor gate (Postgres unavailable — start docker compose)', () => {
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
  await rank.seedTiers();

  let counter = 0;
  const register = async () => {
    const handle = `fg${process.pid}${++counter}`;
    return auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
  };

  async function ctx(userId: string, opts: { mfa: boolean; extraScopes?: string[] }): Promise<Context> {
    const { token } = await issueAccessToken(
      { userId, sessionId: randomUUID(), scopes: [...SESSION_SCOPES, ...(opts.extraScopes ?? [])], tier: 'none', mfa: opts.mfa },
      tokenConfig,
    );
    return { principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: 'req-1' };
  }

  const identity = (privilegedUserIds: string[] = []) => createIdentityRouter(auth, rank, { webauthnEnabled: true, privilegedUserIds });
  const asPassword = async (userId: string, privileged: string[] = [], extraScopes: string[] = []) =>
    identity(privileged).createCaller(await ctx(userId, { mfa: false, extraScopes }));
  const asMfa = async (userId: string) => identity().createCaller(await ctx(userId, { mfa: true }));

  /** The refusal a customer app can map: HTTP-ish 403 and a typed code. */
  const refusedWith = (code: string) => ({ code: 'FORBIDDEN', cause: { code } });

  const factors = async (userId: string) => {
    const [row] = await db.sql<Array<{ totp: boolean; passkeys: number }>>`
      SELECT totp_secret IS NOT NULL AS totp, jsonb_array_length(webauthn_creds)::int AS passkeys FROM users WHERE id = ${userId}`;
    return row!;
  };

  /** An account whose only factor is a passkey — the stolen-password victim. */
  async function accountWithPasskey() {
    const { userId } = await register();
    const options = await auth.startWebauthnRegistration(userId, PASSWORD_SESSION);
    await auth.confirmWebauthnRegistration(userId, PASSWORD_SESSION, softAuthenticator().registrationResponse(options.challenge));
    return userId;
  }

  /** An account whose only factor is TOTP. */
  async function accountWithTotp() {
    const { userId } = await register();
    const { secret } = await auth.startTotpEnrolment(userId, PASSWORD_SESSION);
    await auth.confirmTotpEnrolment(userId, PASSWORD_SESSION, secret, totp(secret));
    return userId;
  }

  beforeEach(async () => {
    bus.reset();
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('adding a factor on an account that already has one', () => {
    it('refuses TOTP enrol and confirm on a password-only session (passkey-only account)', async () => {
      const userId = await accountWithPasskey();
      const attacker = await asPassword(userId);
      await expect(attacker.totp.enrol()).rejects.toMatchObject(refusedWith('auth.mfa_required'));

      // Even holding a valid pending secret, confirm is refused and nothing is written.
      const { secret } = await auth.startTotpEnrolment(userId, MFA_SESSION);
      await expect(attacker.totp.confirm({ secret, code: totp(secret) })).rejects.toMatchObject(refusedWith('auth.mfa_required'));
      expect(await factors(userId)).toEqual({ totp: false, passkeys: 1 });
    });

    it("refuses an attacker's passkey on a password-only session (the stolen-password attack)", async () => {
      const userId = await accountWithPasskey();
      const attacker = await asPassword(userId);
      await expect(attacker.webauthn.registerOptions()).rejects.toMatchObject(refusedWith('auth.mfa_required'));

      const options = await auth.startWebauthnRegistration(userId, MFA_SESSION);
      const stolen = softAuthenticator().registrationResponse(options.challenge);
      await expect(
        attacker.webauthn.registerVerify({ ...stolen, response: { ...stolen.response, transports: ['internal'] } }),
      ).rejects.toMatchObject(refusedWith('auth.mfa_required'));
      expect(await factors(userId)).toEqual({ totp: false, passkeys: 1 });
    });

    it('refuses a passkey on a password-only session when the account has TOTP', async () => {
      const userId = await accountWithTotp();
      const attacker = await asPassword(userId);
      await expect(attacker.webauthn.registerOptions()).rejects.toMatchObject(refusedWith('auth.mfa_required'));
      expect(await factors(userId)).toEqual({ totp: true, passkeys: 0 });
    });

    it('also refuses on the top-level passkey enrol route', async () => {
      const userId = await accountWithPasskey();
      const router = createEnrollPasskeyRouter(db.sql, { rpId: 'localhost', rpName: 'INTAFACED', origin: webauthnConfig.origin });
      const attacker = router.createCaller(await ctx(userId, { mfa: false }));
      await expect(attacker.beginEnrollPasskey()).rejects.toMatchObject(refusedWith('auth.mfa_required'));
      const allowed = router.createCaller(await ctx(userId, { mfa: true }));
      await expect(allowed.beginEnrollPasskey()).resolves.toBeTruthy();
    });

    it('allows an MFA session (passkey login, TOTP login or fresh step-up carry mfa: true)', async () => {
      const userId = await accountWithPasskey();
      const user = await asMfa(userId);
      const started = await user.totp.enrol();
      await user.totp.confirm({ secret: started.secret, code: totp(started.secret) });
      const options = await user.webauthn.registerOptions();
      await user.webauthn.registerVerify(softAuthenticator().registrationResponse(options.challenge));
      expect(await factors(userId)).toEqual({ totp: true, passkeys: 2 });
    });
  });

  describe('the first factor', () => {
    it('is allowed on a password-only session for an ordinary account (TOTP)', async () => {
      const { userId } = await register();
      const api = await asPassword(userId);
      const started = await api.totp.enrol();
      await expect(api.totp.confirm({ secret: started.secret, code: totp(started.secret) })).resolves.toEqual({ ok: true });
      expect(await factors(userId)).toEqual({ totp: true, passkeys: 0 });
    });

    it('is allowed on a password-only session for an ordinary account (passkey)', async () => {
      const { userId } = await register();
      const api = await asPassword(userId);
      const options = await api.webauthn.registerOptions();
      await api.webauthn.registerVerify(softAuthenticator().registrationResponse(options.challenge));
      expect(await factors(userId)).toEqual({ totp: false, passkeys: 1 });
    });

    it('cannot be doubled up: two parallel first-factor enrolments under one password session add only one', async () => {
      const { userId } = await register();
      const api = await asPassword(userId);
      // Both ceremonies are prepared while the account still has no factor.
      const started = await api.totp.enrol();
      const options = await api.webauthn.registerOptions();
      const passkey = softAuthenticator().registrationResponse(options.challenge);

      const results = await Promise.allSettled([
        api.totp.confirm({ secret: started.secret, code: totp(started.secret) }),
        api.webauthn.registerVerify(passkey),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toMatchObject(refusedWith('auth.mfa_required'));
      const now = await factors(userId);
      expect(Number(now.totp) + now.passkeys).toBe(1);
    });
  });

  describe('privileged identities', () => {
    it('refuse a password-only first factor with a typed code (founder pair)', async () => {
      const { userId } = await register();
      const api = await asPassword(userId, [userId]);
      for (const attempt of [() => api.totp.enrol(), () => api.webauthn.registerOptions()]) {
        await expect(attempt()).rejects.toMatchObject(refusedWith('auth.privileged_enrolment_requires_invite'));
      }
      // The write path itself refuses too, not only the options step.
      const { secret } = await auth.startTotpEnrolment(userId, PASSWORD_SESSION);
      await expect(api.totp.confirm({ secret, code: totp(secret) })).rejects.toMatchObject(
        refusedWith('auth.privileged_enrolment_requires_invite'),
      );
      expect(await factors(userId)).toEqual({ totp: false, passkeys: 0 });
    });

    it('refuse the same for any principal carrying an admin:* scope', async () => {
      const { userId } = await register();
      const api = await asPassword(userId, [], ['admin:read']);
      await expect(api.totp.enrol()).rejects.toMatchObject(refusedWith('auth.privileged_enrolment_requires_invite'));
    });

    it('still need MFA for a further factor once they have one', async () => {
      const userId = await accountWithPasskey();
      const api = await asPassword(userId, [userId]);
      await expect(api.totp.enrol()).rejects.toMatchObject(refusedWith('auth.mfa_required'));
    });

    it('keep ordinary first-factor enrolment for customers who are not in the pair', async () => {
      const { userId } = await register();
      const other = randomUUID();
      const api = await asPassword(userId, [other]);
      await expect(api.totp.enrol()).resolves.toMatchObject({ secret: expect.any(String) });
    });
  });

  describe('removing a factor', () => {
    it('needs an MFA session', async () => {
      const userId = await accountWithPasskey();
      const [row] = await db.sql<Array<{ credentialId: string }>>`
        SELECT webauthn_creds->0->>'credentialId' AS "credentialId" FROM users WHERE id = ${userId}`;
      const credentialId = row!.credentialId;

      const attacker = await asPassword(userId);
      await expect(attacker.webauthn.remove({ credentialId })).rejects.toMatchObject(refusedWith('auth.mfa_required'));
      // Refused before any lookup: an unknown id gets the same answer, so it cannot probe ids.
      await expect(attacker.webauthn.remove({ credentialId: 'nope' })).rejects.toMatchObject(refusedWith('auth.mfa_required'));
      expect(await factors(userId)).toEqual({ totp: false, passkeys: 1 });

      const unenroll = createUnenrollPasskeyRouter(db.sql);
      await expect(unenroll.createCaller(await ctx(userId, { mfa: false })).unenrollPasskey({ credentialId })).rejects.toMatchObject(
        refusedWith('auth.mfa_required'),
      );
      expect(await factors(userId)).toEqual({ totp: false, passkeys: 1 });

      const user = await asMfa(userId);
      await expect(user.webauthn.remove({ credentialId })).resolves.toEqual({ removed: true });
      expect(await factors(userId)).toEqual({ totp: false, passkeys: 0 });
    });
  });

  it('merges cleanly with the top-level routers (no procedure name clash)', () => {
    expect(() =>
      mergeRouters(
        identity(),
        createEnrollPasskeyRouter(db.sql, { rpId: 'localhost', rpName: 'INTAFACED', origin: webauthnConfig.origin }),
        createUnenrollPasskeyRouter(db.sql),
      ),
    ).not.toThrow();
  });
}
