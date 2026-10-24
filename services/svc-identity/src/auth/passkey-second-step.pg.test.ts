import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyAccessToken } from '@intafaced/auth';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { AuthError, AuthService } from './auth-service.js';
import { listPasskeys, passkeySettings, setPasskeyPurposes, setPasskeySecondStep } from './passkey-manage.js';
import { credentialsFor, encodePurposes, parsePurposes, stepUpPurposeOf } from './passkey-purposes.js';
import {
  b64urlEncode,
  buildAuthenticatorData,
  buildClientDataJSON,
  coseKeyFromJwk,
  type AuthenticationOptionsJSON,
  type AuthenticationResponseJSON,
} from './webauthn.js';

/**
 * I-signin-sessions-10 (J-identity-04 #4): a passkey as the second step after the password, and passkeys bound to a
 * purpose. Every number here is a TEST fixture.
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
const webauthnConfig = { rpID: 'localhost', rpName: 'INTAFACED', origin: 'http://localhost:3000' };

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', '..', 'drizzle', f), 'utf8'));

/** A software passkey: its stored credential and assertions over any challenge. */
function softPasskey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const cose = coseKeyFromJwk(publicKey.export({ format: 'jwk' }) as { x: string; y: string });
  const id = b64urlEncode(randomBytes(16));
  let counter = 0;
  return {
    id,
    stored: { credentialId: id, publicKey: b64urlEncode(cose), counter: 0, createdAt: new Date().toISOString(), transports: ['internal'] },
    assert(challenge: string): AuthenticationResponseJSON {
      counter += 1;
      const clientDataJSON = buildClientDataJSON({ type: 'webauthn.get', challenge, origin: webauthnConfig.origin });
      const authData = buildAuthenticatorData({ rpID: webauthnConfig.rpID, counter });
      const hash = createHash('sha256').update(clientDataJSON).digest();
      const signature = cryptoSign('SHA256', Buffer.concat([authData, hash]), { key: privateKey, dsaEncoding: 'der' });
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: b64urlEncode(clientDataJSON),
          authenticatorData: b64urlEncode(authData),
          signature: b64urlEncode(signature),
        },
      };
    },
  };
}

describe('passkey purposes (pure)', () => {
  it('reads the step-up field only in its sorted, comma-joined form', () => {
    expect(parsePurposes('')).toEqual([]);
    expect(parsePurposes('money_out,signin')).toEqual(['signin', 'money_out']);
    expect(encodePurposes(['signin', 'money_out'])).toBe('money_out,signin');
    for (const bad of ['signin,money_out', 'signin,signin', 'admin', 'signin,', ',signin']) expect(parsePurposes(bad)).toBeNull();
  });

  it('offers the passkeys kept for a purpose, else those kept for nothing, else all of them', () => {
    const a = { credentialId: 'a' };
    const b = { credentialId: 'b', purposes: ['money_out'] };
    const c = { credentialId: 'c', purposes: ['security_change'] };
    expect(credentialsFor([a, b], 'money_out')).toEqual([b]);
    expect(credentialsFor([a, b], 'signin')).toEqual([a]);
    expect(credentialsFor([b, c], 'signin')).toEqual([b, c]);
    expect(stepUpPurposeOf('identity.step_up.passkey_rename')).toBe('security_change');
    expect(stepUpPurposeOf('bank.step_up.transfers.toUser')).toBe('money_out');
  });
});

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('passkey second step (Postgres unavailable)', () => {
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

  let counter = 0;
  async function person(keys: Array<ReturnType<typeof softPasskey>>) {
    const handle = `ps${process.pid}x${++counter}`;
    const email = `${handle}@example.com`;
    const session = await auth.register({ handle, email, password: PASSWORD });
    await db.sql`UPDATE users SET webauthn_creds = ${db.sql.json(keys.map((k) => k.stored) as never)} WHERE id = ${session.userId}`;
    return { ...session, handle, email };
  }
  async function refusal(promise: Promise<unknown>): Promise<AuthError> {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AuthError);
    return err as AuthError;
  }
  async function secondStep(email: string) {
    const err = await refusal(auth.login({ identifier: email, password: PASSWORD }));
    expect(err.code).toBe('auth.mfa_required');
    return err.details!.secondStep!;
  }
  const allowed = (options: AuthenticationOptionsJSON | null) => (options?.allowCredentials ?? []).map((c) => c.id).sort();
  const mfaFailures = async (userId: string) =>
    (await db.sql<Array<{ failures: number }>>`SELECT failures FROM auth_attempts WHERE user_id = ${userId} AND kind = 'mfa'`)[0]
      ?.failures ?? 0;

  beforeEach(async () => {
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('a passkey as the second step after the password (I-signin-sessions-10)', () => {
    it('signs in with the password alone until the person asks for the passkey', async () => {
      const key = softPasskey();
      const who = await person([key]);
      await expect(auth.login({ identifier: who.email, password: PASSWORD })).resolves.toMatchObject({ userId: who.userId });
    });

    it('asks for the passkey after the password, and the passkey opens a two-factor session', async () => {
      const key = softPasskey();
      const who = await person([key]);
      await setPasskeySecondStep(db.sql, who.userId, true);
      const step = await secondStep(who.email);
      expect(step.totp).toBe(false);
      expect(allowed(step.passkey)).toEqual([key.id]);

      const session = await auth.loginSecondStepPasskey({ credential: key.assert(step.passkey!.challenge) });
      expect(session.userId).toBe(who.userId);
      await expect(verifyAccessToken(session.accessToken, tokenConfig)).resolves.toMatchObject({ userId: who.userId, mfa: true });
      // The challenge is spent.
      expect((await refusal(auth.loginSecondStepPasskey({ credential: key.assert(step.passkey!.challenge) }))).code).toBe(
        'auth.second_step_expired',
      );
    });

    it("refuses another person's passkey, counts it on the MFA lockout, and opens nothing", async () => {
      const mine = softPasskey();
      const theirs = softPasskey();
      const who = await person([mine]);
      await person([theirs]);
      await setPasskeySecondStep(db.sql, who.userId, true);
      const step = await secondStep(who.email);
      expect((await refusal(auth.loginSecondStepPasskey({ credential: theirs.assert(step.passkey!.challenge) }))).code).toBe(
        'auth.webauthn_invalid',
      );
      expect(await mfaFailures(who.userId)).toBe(1);
      const sessions = await db.sql`SELECT id FROM sessions WHERE user_id = ${who.userId}`;
      expect(sessions).toHaveLength(1); // the sign-up session only
    });

    it('refuses a code sent instead of the passkey when the account has no authenticator', async () => {
      const key = softPasskey();
      const who = await person([key]);
      await setPasskeySecondStep(db.sql, who.userId, true);
      expect((await refusal(auth.login({ identifier: who.email, password: PASSWORD, totpCode: '123456' }))).code).toBe('auth.mfa_invalid');
    });

    it('offers the passkey next to the code when the account has an authenticator too', async () => {
      const key = softPasskey();
      const who = await person([key]);
      await db.sql`UPDATE users SET totp_secret = 'sealed-test-secret' WHERE id = ${who.userId}`;
      const step = await secondStep(who.email);
      expect(step.totp).toBe(true);
      expect(allowed(step.passkey)).toEqual([key.id]);
    });

    it('answers a spent or unknown second-step challenge as timed out, so the password is asked for again', async () => {
      const key = softPasskey();
      await person([key]);
      expect((await refusal(auth.loginSecondStepPasskey({ credential: key.assert(b64urlEncode(randomBytes(32))) }))).code).toBe(
        'auth.second_step_expired',
      );
    });

    it('asks for the passkey after a linked provider proved the person too', async () => {
      const key = softPasskey();
      const who = await person([key]);
      await setPasskeySecondStep(db.sql, who.userId, true);
      const err = await refusal(auth.signInVerifiedIdentity(who.userId, {}));
      expect(err.code).toBe('auth.mfa_required');
      expect(allowed(err.details!.secondStep!.passkey)).toEqual([key.id]);
    });

    it('is on only while a passkey exists', async () => {
      const key = softPasskey();
      const who = await person([key]);
      await setPasskeySecondStep(db.sql, who.userId, true);
      expect((await passkeySettings(db.sql, who.userId, 10)).secondStep).toBe(true);
      await db.sql`UPDATE users SET webauthn_creds = '[]'::jsonb WHERE id = ${who.userId}`;
      expect((await passkeySettings(db.sql, who.userId, 10)).secondStep).toBe(false);
      await expect(auth.login({ identifier: who.email, password: PASSWORD })).resolves.toMatchObject({ userId: who.userId });
    });

    it('cannot be turned on without a passkey', async () => {
      const who = await person([]);
      await expect(setPasskeySecondStep(db.sql, who.userId, true)).rejects.toMatchObject({ code: 'auth.webauthn_not_enrolled' });
    });
  });

  describe('passkeys bound to a purpose (I-signin-sessions-10)', () => {
    it('offers and accepts only the sign-in passkey at the second step', async () => {
      const a = softPasskey();
      const b = softPasskey();
      const who = await person([a, b]);
      await setPasskeySecondStep(db.sql, who.userId, true);
      expect(allowed((await secondStep(who.email)).passkey)).toEqual([a.id, b.id].sort());

      await setPasskeyPurposes(db.sql, who.userId, b.id, ['signin']);
      const step = await secondStep(who.email);
      expect(allowed(step.passkey)).toEqual([b.id]);
      expect((await refusal(auth.loginSecondStepPasskey({ credential: a.assert(step.passkey!.challenge) }))).code).toBe(
        'auth.webauthn_invalid',
      );
      const again = await secondStep(who.email);
      await expect(auth.loginSecondStepPasskey({ credential: b.assert(again.passkey!.challenge) })).resolves.toMatchObject({
        userId: who.userId,
      });
    });

    it('offers and accepts only the kept passkey for a security change, and only the other one for money while none is kept for it', async () => {
      const a = softPasskey();
      const b = softPasskey();
      const who = await person([a, b]);
      await setPasskeyPurposes(db.sql, who.userId, a.id, ['security_change']);
      const security = await auth.customerStepUpMaterial(who.userId, 'security_change');
      expect(security.credentials.map((c) => c.credentialId)).toEqual([a.id]);
      const money = await auth.customerStepUpMaterial(who.userId, 'money_out');
      expect(money.credentials.map((c) => c.credentialId)).toEqual([b.id]);

      const challenge = b64urlEncode(randomBytes(32));
      const prove = (key: ReturnType<typeof softPasskey>, purpose: 'security_change' | 'money_out') =>
        auth.proveFreshFactor({
          userId: who.userId,
          sessionId: who.sessionId,
          webauthn: key.assert(challenge),
          webauthnChallenge: challenge,
          purpose,
        });
      expect((await refusal(prove(b, 'security_change'))).code).toBe('auth.webauthn_invalid');
      await expect(prove(a, 'security_change')).resolves.toBeUndefined();
      await expect(prove(b, 'money_out')).resolves.toBeUndefined();
      expect((await refusal(prove(a, 'money_out'))).code).toBe('auth.webauthn_invalid');
    });

    it('lists each passkey with its purposes; the same set again changes nothing', async () => {
      const a = softPasskey();
      const who = await person([a]);
      expect((await listPasskeys(db.sql, who.userId, 10))[0]!.purposes).toEqual([]);
      await setPasskeyPurposes(db.sql, who.userId, a.id, ['money_out', 'signin']);
      await setPasskeyPurposes(db.sql, who.userId, a.id, ['signin', 'money_out']);
      expect((await listPasskeys(db.sql, who.userId, 10))[0]!.purposes).toEqual(['signin', 'money_out']);
      await setPasskeyPurposes(db.sql, who.userId, a.id, []);
      expect((await listPasskeys(db.sql, who.userId, 10))[0]!.purposes).toEqual([]);
      await expect(setPasskeyPurposes(db.sql, who.userId, 'missing', ['signin'])).rejects.toMatchObject({ code: 'auth.not_found' });
    });

    it('keeps passwordless passkey sign-in to the sign-in passkeys once one is bound', async () => {
      const a = softPasskey();
      const b = softPasskey();
      const who = await person([a, b]);
      await setPasskeyPurposes(db.sql, who.userId, b.id, ['signin']);
      const options = await auth.startWebauthnAuthentication(who.email);
      expect(allowed(options)).toEqual([b.id]);
      expect((await refusal(auth.confirmWebauthnAuthentication(who.email, a.assert(options.challenge)))).code).toBe(
        'auth.invalid_credentials',
      );
    });
  });
}
