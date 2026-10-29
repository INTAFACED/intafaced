import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { campaignParticipantSchema, emailProofSchema } from '@intafaced/contracts';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { verifyAccessToken, hasScope, SESSION_SCOPES } from '@intafaced/auth';
import { checkAccess, screeningFailClosedFromEnv, UNSET_SCREENING_LIST } from '@intafaced/config';
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { createTestDb } from './fixture-truncate.testkit.js';
import { AuthService, AuthError } from './auth/auth-service.js';
import { bindApiKeyOriginAllowlist } from './auth/auth-service-origin.js';
import { mintApiKeyWithOriginAllowlist } from './auth/mint-api-key-origin.js';
import { bindApiKeyProductScope, installApiKeyProductExchange, requestProductAls } from './auth/auth-service-product.js';
import { mintApiKeyWithProductScope } from './auth/mint-api-key-product.js';
import { disableUser, installDisabledMintRefuse } from './auth/disable-user.js';
import { stubActionApprovals } from './auth/privileged-dual-control.js';
import { RankService } from './rank/rank-service.js';
import { totp } from './auth/totp.js';
import { encodeCbor } from './auth/cbor.js';
import {
  b64urlEncode,
  buildAuthenticatorData,
  buildClientDataJSON,
  coseKeyFromJwk,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from './auth/webauthn.js';

/**
 * Code for the next TOTP step (still inside the ±1 verify window).
 * Enrol confirm burns the current step; subsequent login/step-up must use a
 * later step without waiting a wall-clock 30s.
 */
function totpNext(secret: string): string {
  const step = 30;
  const counter = Math.floor(Math.floor(Date.now() / 1000) / step);
  return totp(secret, { at: new Date((counter + 1) * step * 1000) });
}

/**
 * svc-identity against real Postgres.
 *
 * This file also carries the §4.4 Phase 1 exit criteria:
 *   · full auth lifecycle — register → TOTP → refresh → scoped API key call
 *   · XP event → rank recalculation → perks visible to a second service
 *
 * Isolation: every suite run gets its own Postgres schema via `createTestDb`,
 * built from this service's real migrations (rewritten off the hard-coded
 * `identity` schema). Two worktrees can run this file at once without
 * TRUNCATE races or a shared KYC queue backlog poisoning FIFO assertions.
 *
 * Service SQL is search_path-relative; production still uses
 * `search_path = identity,public`. Requires a role that can CREATE SCHEMA
 * (ops), same as svc-ledger. Skips cleanly when Postgres is unreachable;
 * fails hard on CI via `postgresAvailable` / residual #9.
 */

// Ops role can CREATE SCHEMA; the service role cannot. Host port is 5433.
const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
/** A fresh register/login-by-password session: `mfa` false. */
const PASSWORD_SESSION = { mfa: false, privileged: false } as const;
/** A session that passed a second factor (or holds a fresh step-up token). */
const MFA_SESSION = { mfa: true, privileged: false } as const;

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');

/**
 * EVERY forward migration, in order — not just the initial one.
 * Read from disk rather than listed here so a new migration cannot silently
 * leave the test schema behind production.
 */
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

if (migrations.length === 0) throw new Error(`No migrations found in ${drizzleDir}`);

const tokenConfig = {
  secret: 'an-identity-test-signing-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

const webauthnConfig = {
  rpID: 'localhost',
  rpName: 'INTAFACED',
  origin: 'http://localhost:3000',
};

function softAuthenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const cose = coseKeyFromJwk(jwk);
  const credId = randomBytes(16);
  let counter = 0;

  const sign = (authData: Buffer, clientDataJSON: Buffer, key: KeyObject = privateKey) => {
    const clientDataHash = createHash('sha256').update(clientDataJSON).digest();
    return cryptoSign('SHA256', Buffer.concat([authData, clientDataHash]), { key, dsaEncoding: 'der' });
  };

  return {
    credId,
    registrationResponse(challenge: string): RegistrationResponseJSON {
      const clientDataJSON = buildClientDataJSON({
        type: 'webauthn.create',
        challenge,
        origin: webauthnConfig.origin,
      });
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
    assertionResponse(challenge: string): AuthenticationResponseJSON {
      counter += 1;
      const clientDataJSON = buildClientDataJSON({
        type: 'webauthn.get',
        challenge,
        origin: webauthnConfig.origin,
      });
      const authData = buildAuthenticatorData({ rpID: webauthnConfig.rpID, counter });
      const signature = sign(authData, clientDataJSON);
      return {
        id: b64urlEncode(credId),
        rawId: b64urlEncode(credId),
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

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('svc-identity (Postgres unavailable — start docker compose)', () => {
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
  // 32-byte test key so confirmTotpEnrolment can seal secrets at rest.
  const totpSecretKeyMaterial = randomBytes(32).toString('base64');
  // Owner-explicit fixture — not a git default. Blank env must not invent this.
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, webauthnConfig, totpSecretKeyMaterial, undefined, undefined, 25);
  installApiKeyProductExchange(auth, db.sql);
  installDisabledMintRefuse(auth, db.sql);
  await rank.seedTiers();

  let counter = 0;
  const unique = () => `u${process.pid}${++counter}`;

  const register = () => {
    const handle = unique();
    return auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
  };

  /** A reviewed approval: pending record, then an operator's decision (never a direct approved insert). */
  const grantKyc = async (userId: string, tier: 'basic' | 'full') => {
    const operator = await register();
    const submitted = await auth.submitKyc({ userId, tier, jurisdiction: 'DE' });
    await auth.approveKycRecord({ recordId: submitted.id, reviewerId: operator.userId, approvalParties: [] });
  };

  beforeEach(async () => {
    bus.reset();
    /**
     * Wipe transactional state inside THIS suite's schema only.
     *
     * `createTestDb` already isolates us from other worktrees; truncateAll
     * keeps the KYC queue and session tables empty between cases so FIFO
     * assertions and LIMIT-sensitive reads cannot see leftover rows from
     * an earlier `it` in the same run. Seed the rank ladder again because
     * thresholds live in a normal table, not a migration-only fixture.
     */
    await db.truncateAll();
    await rank.seedTiers();
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('isolation', () => {
    it('uses a unique schema so parallel suites cannot share state', () => {
      // Structural guarantee: createTestDb names include pid + counter.
      expect(db.schema).toMatch(/^test_identity_\d+_\d+$/);
      expect(db.schema).not.toBe('identity');
    });
  });

  describe('registration', () => {
    it('creates a user, profile and rank row, and returns a session', async () => {
      const session = await register();
      expect(session.accessToken).toBeTruthy();
      expect(session.refreshToken).toBeTruthy();

      const principal = await verifyAccessToken(session.accessToken, tokenConfig);
      expect(principal.userId).toBe(session.userId);
      expect(principal.mfa).toBe(false);
      expect(principal.tier).toBe('none');
    });

    it('awards registration XP exactly once, even if the call is repeated', async () => {
      const session = await register();
      const first = await rank.get(session.userId);
      expect(first.xp).toBe(50n);

      await rank.awardXp({
        userId: session.userId,
        sourceModule: 'identity',
        action: 'identity.registered',
        xpDelta: 50,
        idempotencyKey: `identity.registered:${session.userId}`,
      });

      expect((await rank.get(session.userId)).xp).toBe(50n);
    });

    it('refuses a duplicate handle and a duplicate email, distinctly', async () => {
      const handle = unique();
      await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple' });

      await expect(
        auth.register({ handle, email: `${unique()}@example.com`, password: 'correct horse battery staple' }),
      ).rejects.toMatchObject({ code: 'auth.handle_taken' });

      await expect(
        auth.register({ handle: unique(), email: `${handle}@example.com`, password: 'correct horse battery staple' }),
      ).rejects.toMatchObject({ code: 'auth.email_taken' });
    });

    it('treats handles case-insensitively — impersonation by casing is a real attack', async () => {
      const handle = unique();
      await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple' });

      await expect(
        auth.register({ handle: handle.toUpperCase(), email: `${unique()}@example.com`, password: 'correct horse battery staple' }),
      ).rejects.toThrow(AuthError);
    });

    it('emits userCreated', async () => {
      const session = await register();
      const emitted = bus.emitted('userCreated');
      expect(emitted.some((e) => e.payload.userId === session.userId)).toBe(true);
    });
  });

  describe('login', () => {
    it('accepts the right password', async () => {
      const handle = unique();
      await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple' });
      await expect(auth.login({ identifier: handle, password: 'correct horse battery staple' })).resolves.toMatchObject({
        userId: expect.any(String),
      });
    });

    it('logs in by email as well as handle', async () => {
      const handle = unique();
      await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple' });
      await expect(auth.login({ identifier: `${handle}@example.com`, password: 'correct horse battery staple' })).resolves.toBeTruthy();
    });

    it('rejects the wrong password', async () => {
      const handle = unique();
      await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple' });
      await expect(auth.login({ identifier: handle, password: 'wrong password entirely' })).rejects.toMatchObject({
        code: 'auth.invalid_credentials',
      });
    });

    it('gives an unknown user the same error as a wrong password', async () => {
      // Anything else is an account-enumeration oracle.
      await expect(auth.login({ identifier: 'nobody-here-at-all', password: 'whatever it is' })).rejects.toMatchObject({
        code: 'auth.invalid_credentials',
      });
    });

    it('refuses a frozen account', async () => {
      const session = await register();
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${session.userId}`;
      const handleRow = await db.sql<Array<{ handle: string }>>`SELECT handle FROM users WHERE id = ${session.userId}`;
      await expect(auth.login({ identifier: handleRow[0]!.handle, password: 'correct horse battery staple' })).rejects.toMatchObject({
        code: 'auth.account_frozen',
      });
    });
  });

  describe('TOTP enrolment', () => {
    it('does not persist the secret until a code confirms it', async () => {
      const session = await register();
      const { secret } = await auth.startTotpEnrolment(session.userId, PASSWORD_SESSION);

      const before = await db.sql<Array<{ totp_secret: string | null }>>`
        SELECT totp_secret FROM users WHERE id = ${session.userId}
      `;
      expect(before[0]!.totp_secret).toBeNull();

      await auth.confirmTotpEnrolment(session.userId, PASSWORD_SESSION, secret, totp(secret));

      const after = await db.sql<Array<{ totp_secret: string | null }>>`
        SELECT totp_secret FROM users WHERE id = ${session.userId}
      `;
      // Sealed at rest — never store base32 plaintext in the column.
      expect(after[0]!.totp_secret).not.toBe(secret);
      expect(after[0]!.totp_secret).toMatch(/^enc:v1:/);
      expect(after[0]!.totp_secret).not.toContain(secret);
    });

    it('L231: enrolling TOTP revokes every other session of the account; the enrolling one survives', async () => {
      const first = await register();
      const rows = await db.sql<Array<{ handle: string }>>`SELECT handle FROM users WHERE id = ${first.userId}`;
      const second = await auth.login({ identifier: rows[0]!.handle, password: 'correct horse battery staple' });
      const { secret } = await auth.startTotpEnrolment(first.userId, PASSWORD_SESSION);
      await auth.confirmTotpEnrolment(first.userId, { ...PASSWORD_SESSION, sessionId: first.sessionId }, secret, totp(secret));
      await expect(auth.refresh(second.refreshToken)).rejects.toBeInstanceOf(AuthError);
      await expect(auth.refresh(first.refreshToken)).resolves.toBeDefined();
    });

    it('rejects a wrong confirmation code', async () => {
      const session = await register();
      const { secret } = await auth.startTotpEnrolment(session.userId, PASSWORD_SESSION);
      await expect(auth.confirmTotpEnrolment(session.userId, PASSWORD_SESSION, secret, '000000')).rejects.toMatchObject({
        code: 'auth.mfa_invalid',
      });
    });

    it('completes enrolment when start and confirm hit different AuthService instances (multi-pod)', async () => {
      // Two services share SQL + key — models two identity pods behind a LB.
      const authB = new AuthService(db.sql, bus, rank, tokenConfig, webauthnConfig, totpSecretKeyMaterial);
      const session = await register();
      const { secret } = await auth.startTotpEnrolment(session.userId, PASSWORD_SESSION);

      // Pending must not live only in pod-A process memory.
      await authB.confirmTotpEnrolment(session.userId, PASSWORD_SESSION, secret, totp(secret));

      const after = await db.sql<Array<{ totp_secret: string | null }>>`
        SELECT totp_secret FROM users WHERE id = ${session.userId}
      `;
      expect(after[0]!.totp_secret).toMatch(/^enc:v1:/);

      // Pending is single-use — second confirm fails closed.
      await expect(authB.confirmTotpEnrolment(session.userId, MFA_SESSION, secret, totpNext(secret))).rejects.toMatchObject({
        code: 'auth.mfa_invalid',
      });
    });

    it('wrong secret on confirm does not burn a legitimate pending enrolment', async () => {
      const session = await register();
      const { secret } = await auth.startTotpEnrolment(session.userId, PASSWORD_SESSION);
      const wrongSecret = secret === 'A'.repeat(32) ? 'B'.repeat(32) : 'A'.repeat(32);

      await expect(auth.confirmTotpEnrolment(session.userId, PASSWORD_SESSION, wrongSecret, totp(wrongSecret))).rejects.toMatchObject({
        code: 'auth.mfa_invalid',
      });

      // Real secret still works after the mismatch attempt.
      await auth.confirmTotpEnrolment(session.userId, PASSWORD_SESSION, secret, totp(secret));
      const after = await db.sql<Array<{ totp_secret: string | null }>>`
        SELECT totp_secret FROM users WHERE id = ${session.userId}
      `;
      expect(after[0]!.totp_secret).toMatch(/^enc:v1:/);
    });

    it('then requires the code at login, and marks the session mfa', async () => {
      const handle = unique();
      const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple' });
      const { secret } = await auth.startTotpEnrolment(session.userId, PASSWORD_SESSION);
      await auth.confirmTotpEnrolment(session.userId, PASSWORD_SESSION, secret, totp(secret));

      await expect(auth.login({ identifier: handle, password: 'correct horse battery staple' })).rejects.toMatchObject({
        code: 'auth.mfa_required',
      });

      await expect(auth.login({ identifier: handle, password: 'correct horse battery staple', totpCode: '000000' })).rejects.toMatchObject({
        code: 'auth.mfa_invalid',
      });

      // Confirm burned the enrol step — login needs the next window step.
      const withMfa = await auth.login({ identifier: handle, password: 'correct horse battery staple', totpCode: totpNext(secret) });
      const principal = await verifyAccessToken(withMfa.accessToken, tokenConfig);
      expect(principal.mfa).toBe(true);
    });

    it('refuses a TOTP code that was already consumed in this window (anti-replay)', async () => {
      const handle = unique();
      const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple' });
      const { secret } = await auth.startTotpEnrolment(session.userId, PASSWORD_SESSION);
      await auth.confirmTotpEnrolment(session.userId, PASSWORD_SESSION, secret, totp(secret));

      const code = totpNext(secret);
      await auth.login({ identifier: handle, password: 'correct horse battery staple', totpCode: code });

      // Same code must not buy a second session (or a step-up) inside the window.
      await expect(auth.login({ identifier: handle, password: 'correct horse battery staple', totpCode: code })).rejects.toMatchObject({
        code: 'auth.mfa_invalid',
      });

      const live = await register();
      const { secret: s2 } = await auth.startTotpEnrolment(live.userId, PASSWORD_SESSION);
      await auth.confirmTotpEnrolment(live.userId, PASSWORD_SESSION, s2, totp(s2));
      const stepCode = totpNext(s2);
      await auth.stepUp({ userId: live.userId, sessionId: live.sessionId, totpCode: stepCode });
      await expect(auth.stepUp({ userId: live.userId, sessionId: live.sessionId, totpCode: stepCode })).rejects.toMatchObject({
        code: 'auth.mfa_invalid',
      });
    });

    it('stores hashed recovery codes on confirm and redeems once at login (ID-P1-1)', async () => {
      const handle = unique();
      const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple' });
      const { secret, recoveryCodes } = await auth.startTotpEnrolment(session.userId, PASSWORD_SESSION);
      expect(recoveryCodes.length).toBeGreaterThan(0);

      // Plaintext never lands before confirm.
      const before = await db.sql<Array<{ recovery_code_hashes: unknown }>>`
        SELECT recovery_code_hashes FROM users WHERE id = ${session.userId}
      `;
      expect(normalizeStringList(before[0]!.recovery_code_hashes)).toEqual([]);

      await auth.confirmTotpEnrolment(session.userId, PASSWORD_SESSION, secret, totp(secret));

      const after = await db.sql<Array<{ recovery_code_hashes: unknown }>>`
        SELECT recovery_code_hashes FROM users WHERE id = ${session.userId}
      `;
      const hashes = normalizeStringList(after[0]!.recovery_code_hashes);
      expect(hashes).toHaveLength(recoveryCodes.length);
      // Hashes are hex digests — never the plaintext code shape.
      for (const h of hashes) {
        expect(h).toMatch(/^[a-f0-9]{64}$/);
        expect(recoveryCodes).not.toContain(h);
      }

      const code = recoveryCodes[0]!;
      const recovered = await auth.login({
        identifier: handle,
        password: 'correct horse battery staple',
        totpCode: code,
      });
      const principal = await verifyAccessToken(recovered.accessToken, tokenConfig);
      expect(principal.mfa).toBe(true);

      // Single-use: same code fails after burn.
      await expect(auth.login({ identifier: handle, password: 'correct horse battery staple', totpCode: code })).rejects.toMatchObject({
        code: 'auth.mfa_invalid',
      });

      const remaining = await db.sql<Array<{ recovery_code_hashes: unknown }>>`
        SELECT recovery_code_hashes FROM users WHERE id = ${session.userId}
      `;
      expect(normalizeStringList(remaining[0]!.recovery_code_hashes)).toHaveLength(recoveryCodes.length - 1);

      // Live TOTP still works after a recovery login (next step — enrol burned current).
      const withTotp = await auth.login({
        identifier: handle,
        password: 'correct horse battery staple',
        totpCode: totpNext(secret),
      });
      expect((await verifyAccessToken(withTotp.accessToken, tokenConfig)).mfa).toBe(true);
    });
  });

  describe('WebAuthn registration + assertion', () => {
    it('enrols a credential and issues an MFA session on assertion', async () => {
      const handle = unique();
      const session = await auth.register({
        handle,
        email: `${handle}@example.com`,
        password: 'correct horse battery staple',
      });
      const authenticator = softAuthenticator();

      const options = await auth.startWebauthnRegistration(session.userId, PASSWORD_SESSION);
      expect(options.challenge).toBeTruthy();
      expect(options.rp.id).toBe('localhost');

      const enrolled = await auth.confirmWebauthnRegistration(
        session.userId,
        PASSWORD_SESSION,
        authenticator.registrationResponse(options.challenge),
      );
      expect(enrolled.credentialId).toBe(b64urlEncode(authenticator.credId));

      const stored = await db.sql<Array<{ webauthn_creds: unknown }>>`
        SELECT webauthn_creds FROM users WHERE id = ${session.userId}
      `;
      expect(Array.isArray(stored[0]!.webauthn_creds)).toBe(true);
      expect((stored[0]!.webauthn_creds as unknown[]).length).toBe(1);

      const authOptions = await auth.startWebauthnAuthentication(handle);
      expect(authOptions.allowCredentials).toHaveLength(1);
      expect(authOptions.allowCredentials![0]).toEqual({ type: 'public-key', id: b64urlEncode(authenticator.credId) });

      const tokens = await auth.confirmWebauthnAuthentication(handle, authenticator.assertionResponse(authOptions.challenge));
      expect(tokens.userId).toBe(session.userId);
      const principal = await verifyAccessToken(tokens.accessToken, tokenConfig);
      expect(principal.mfa).toBe(true);
    });

    it('does not persist a credential when the challenge is wrong', async () => {
      const session = await register();
      const authenticator = softAuthenticator();
      const options = await auth.startWebauthnRegistration(session.userId, PASSWORD_SESSION);
      // Consume the real challenge by never using it; present a different one.
      await expect(
        auth.confirmWebauthnRegistration(session.userId, PASSWORD_SESSION, authenticator.registrationResponse('not-the-challenge')),
      ).rejects.toMatchObject({ code: 'auth.webauthn_invalid' });

      const stored = await db.sql<Array<{ webauthn_creds: unknown }>>`
        SELECT webauthn_creds FROM users WHERE id = ${session.userId}
      `;
      expect(stored[0]!.webauthn_creds).toEqual([]);
      // Real challenge must still be single-use only after a successful take —
      // a failed verify with a foreign challenge leaves the real one intact, so
      // a second attempt with the real challenge still works.
      await expect(
        auth.confirmWebauthnRegistration(session.userId, PASSWORD_SESSION, authenticator.registrationResponse(options.challenge)),
      ).resolves.toMatchObject({ credentialId: b64urlEncode(authenticator.credId) });
    });

    const enrolKey = async (userId: string) => {
      const authenticator = softAuthenticator();
      const options = await auth.startWebauthnRegistration(userId, PASSWORD_SESSION);
      await auth.confirmWebauthnRegistration(userId, PASSWORD_SESSION, authenticator.registrationResponse(options.challenge));
      return authenticator;
    };

    it('refuses assertion for an account with no credential, and its authOptions looks like any other (I-signin-sessions-02)', async () => {
      const handle = unique();
      await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple' });
      const options = await auth.startWebauthnAuthentication(handle);
      expect(options.allowCredentials!.length).toBeGreaterThanOrEqual(1);
      expect(options.allowCredentials!.length).toBeLessThanOrEqual(3);

      const authenticator = softAuthenticator();
      await expect(auth.confirmWebauthnAuthentication(handle, authenticator.assertionResponse(options.challenge))).rejects.toMatchObject({
        code: 'auth.invalid_credentials',
      });
    });

    it('answers an unknown handle, a handle without a passkey and a handle with one in the same shape (I-signin-sessions-02)', async () => {
      const withKey = await register();
      await enrolKey(withKey.userId);
      const keyHandle = (await db.sql<Array<{ handle: string }>>`SELECT handle FROM users WHERE id = ${withKey.userId}`)[0]!.handle;
      const bare = unique();
      await auth.register({ handle: bare, email: `${bare}@example.com`, password: 'correct horse battery staple' });
      const answers = [
        await auth.startWebauthnAuthentication(`nobody-${unique()}`),
        await auth.startWebauthnAuthentication(bare),
        await auth.startWebauthnAuthentication(keyHandle),
      ];
      for (const a of answers) {
        expect(Object.keys(a).sort()).toEqual(Object.keys(answers[0]!).sort());
        expect(a.timeout).toBe(answers[0]!.timeout);
        expect(a.allowCredentials!.length).toBeGreaterThanOrEqual(1);
        expect(a.allowCredentials!.length).toBeLessThanOrEqual(3);
        for (const c of a.allowCredentials!) expect(Object.keys(c).sort()).toEqual(['id', 'type']);
      }
      const again = await auth.startWebauthnAuthentication(bare);
      expect(again.allowCredentials).toEqual(answers[1]!.allowCredentials);
    });

    it('lists decoys for a frozen account and refuses it like a wrong signature, not as frozen (I-signin-sessions-02)', async () => {
      const session = await register();
      const authenticator = await enrolKey(session.userId);
      const handle = (await db.sql<Array<{ handle: string }>>`SELECT handle FROM users WHERE id = ${session.userId}`)[0]!.handle;
      const real = await auth.startWebauthnAuthentication(handle);
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${session.userId}`;
      const frozen = await auth.startWebauthnAuthentication(handle);
      expect(frozen.allowCredentials).not.toEqual(real.allowCredentials);
      await expect(auth.confirmWebauthnAuthentication(handle, authenticator.assertionResponse(frozen.challenge))).rejects.toMatchObject({
        code: 'auth.invalid_credentials',
      });
    });

    it('refuses to answer when the sign-in secret is unset, never an empty list (I-signin-sessions-02)', async () => {
      const blank = new AuthService(db.sql, bus, rank, { ...tokenConfig, secret: '' }, webauthnConfig);
      await expect(blank.startWebauthnAuthentication('anyone')).rejects.toMatchObject({ code: 'auth.webauthn_unconfigured' });
    });

    it('removes an enrolled credential and will not let a stranger retire it', async () => {
      const owner = await register();
      const stranger = await register();
      const authenticator = softAuthenticator();
      const options = await auth.startWebauthnRegistration(owner.userId, PASSWORD_SESSION);
      const enrolled = await auth.confirmWebauthnRegistration(
        owner.userId,
        PASSWORD_SESSION,
        authenticator.registrationResponse(options.challenge),
      );

      expect(await auth.listWebauthnCredentials(owner.userId, 200)).toHaveLength(1);
      // Foreign principal: same shape as apiKeys.revoke — false, no leak.
      expect(await auth.removeWebauthnCredential(stranger.userId, MFA_SESSION, enrolled.credentialId)).toBe(false);
      expect(await auth.listWebauthnCredentials(owner.userId, 200)).toHaveLength(1);

      expect(await auth.removeWebauthnCredential(owner.userId, MFA_SESSION, enrolled.credentialId)).toBe(true);
      expect(await auth.listWebauthnCredentials(owner.userId, 200)).toHaveLength(0);
      expect(await auth.removeWebauthnCredential(owner.userId, MFA_SESSION, enrolled.credentialId)).toBe(false);

      // Assertion path is gone for that key.
      const handle = (await db.sql<Array<{ handle: string }>>`SELECT handle FROM users WHERE id = ${owner.userId}`)[0]!.handle;
      const authOptions = await auth.startWebauthnAuthentication(handle);
      expect(authOptions.allowCredentials!.map((c) => c.id)).not.toContain(enrolled.credentialId);
    });
  });

  describe('session refresh and rotation', () => {
    it('refuses refresh when the account is frozen (ID-P1-2)', async () => {
      const session = await register();
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${session.userId}`;
      await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({ code: 'auth.account_frozen' });
      // Presented session was revoked on freeze-refuse. Second present hits revoked path.
      await db.sql`UPDATE users SET status = 'active' WHERE id = ${session.userId}`;
      await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({
        code: expect.stringMatching(/^auth\.(session_reused|session_invalid)$/),
      });
    });

    it('issues a new refresh token and invalidates the old one', async () => {
      const session = await register();
      const refreshed = await auth.refresh(session.refreshToken);

      expect(refreshed.refreshToken).not.toBe(session.refreshToken);
      expect(refreshed.userId).toBe(session.userId);
      expect(refreshed.sessionId).not.toBe(session.sessionId);
    });

    it('detects reuse of a rotated token and revokes every session', async () => {
      const session = await register();
      const refreshed = await auth.refresh(session.refreshToken);

      // Outside the short two-tab grace window the stolen copy still burns every session.
      await db.sql`UPDATE sessions SET rotated_at = now() - interval '2 minutes' WHERE id = ${session.sessionId}`;
      await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({ code: 'auth.session_reused' });

      // Everything burns, including the token the thief did not have.
      await expect(auth.refresh(refreshed.refreshToken)).rejects.toThrow(AuthError);
    });

    it('rejects an unknown or expired token', async () => {
      await expect(auth.refresh('not-a-real-token')).rejects.toMatchObject({ code: 'auth.session_invalid' });

      const session = await register();
      await db.sql`UPDATE sessions SET expires_at = now() - interval '1 day' WHERE id = ${session.sessionId}`;
      await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({ code: 'auth.session_invalid' });
    });

    it('logout revokes the session', async () => {
      const session = await register();
      await auth.logout(session.refreshToken);
      await expect(auth.refresh(session.refreshToken)).rejects.toThrow(AuthError);
    });
  });

  describe('API keys', () => {
    it('returns the key once and stores only its hash', async () => {
      const session = await register();
      const { key, prefix } = await auth.createApiKey({
        userId: session.userId,
        name: 'bot',
        scopes: ['trade:read'],
        grantorScopes: SESSION_SCOPES,
      });

      const stored = await db.sql<Array<{ key_hash: string; key_prefix: string }>>`
        SELECT key_hash, key_prefix FROM api_keys WHERE user_id = ${session.userId}
      `;
      expect(stored[0]!.key_hash).not.toContain(key);
      expect(stored[0]!.key_prefix).toBe(prefix);
    });

    it('verifies a valid key and rejects a wrong one', async () => {
      const session = await register();
      const { key } = await auth.createApiKey({
        userId: session.userId,
        name: 'bot',
        scopes: ['trade:read', 'trade:write'],
        grantorScopes: SESSION_SCOPES,
      });

      const verified = await auth.verifyApiKey(key);
      expect(verified?.userId).toBe(session.userId);
      expect(hasScope(verified!.scopes, 'trade:read')).toBe(true);

      expect(await auth.verifyApiKey('ifc_totally_wrong')).toBeNull();
    });

    it('refuses scopes the granting session does not hold — no row written', async () => {
      const session = await register();
      await expect(
        auth.createApiKey({
          userId: session.userId,
          name: 'widen',
          scopes: ['pay:read'],
          grantorScopes: ['identity:write', 'trade:read'],
        }),
      ).rejects.toThrow(/does not hold/);

      const stored = await db.sql<Array<{ id: string }>>`
        SELECT id FROM api_keys WHERE user_id = ${session.userId}
      `;
      expect(stored).toHaveLength(0);
    });

    it('refuses a delegate minting a further key — no row written', async () => {
      const session = await register();
      const parent = await auth.createApiKey({
        userId: session.userId,
        name: 'parent',
        scopes: ['identity:write', 'trade:read'],
        grantorScopes: SESSION_SCOPES,
      });

      await expect(
        auth.createApiKey({
          userId: session.userId,
          name: 'nested',
          scopes: ['trade:read'],
          grantorScopes: ['identity:write', 'trade:read'],
          grantorKid: parent.id,
        }),
      ).rejects.toMatchObject({ code: 'auth.delegate_cannot_grant' });

      const stored = await db.sql<Array<{ name: string }>>`
        SELECT name FROM api_keys WHERE user_id = ${session.userId}
      `;
      expect(stored.map((r) => r.name)).toEqual(['parent']);
    });

    it('refuses to mint a key that could withdraw — service AND database', async () => {
      const session = await register();

      await expect(
        auth.createApiKey({
          userId: session.userId,
          name: 'dangerous',
          scopes: ['trade:read', 'trade:withdraw'],
          grantorScopes: SESSION_SCOPES,
        }),
      ).rejects.toThrow(/interactive/);

      // The database is the backstop if that check is ever bypassed.
      await expect(
        db.sql`
          INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes)
          VALUES (${session.userId}, 'x', ${'h' + Date.now()}, 'ifc_x', ARRAY['trade:withdraw'])
        `,
      ).rejects.toThrow(/api_keys_no_withdraw_ck/);

      // pay:payout is not implied by a normal session. The database allows the
      // row: a step-up create is the only way the service will write it (D-145).
      await expect(
        auth.createApiKey({
          userId: session.userId,
          name: 'payout-bot',
          scopes: ['pay:payout'],
          grantorScopes: SESSION_SCOPES,
        }),
      ).rejects.toThrow(/step-up/);

      await db.sql`
        INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes)
        VALUES (${session.userId}, 'pay_x', ${'hp' + Date.now()}, 'ifc_p', ARRAY['pay:payout'])
      `;

      // A founder session that holds the desk still cannot mint a key with it,
      // and a row inserted past the service is refused by the same CHECK.
      await expect(
        auth.createApiKey({
          userId: session.userId,
          name: 'desk-bot',
          scopes: ['admin:write'],
          grantorScopes: ['admin:write', 'admin:read', 'support:ops', 'admin:compliance', 'market:ops'],
        }),
      ).rejects.toThrow(/cannot be granted to an API key/);

      // agents:execute is the person's own (OWNER 107): refused by the service and by the same CHECK.
      await expect(
        auth.createApiKey({ userId: session.userId, name: 'agent-bot', scopes: ['agents:execute'], grantorScopes: ['agents:execute'] }),
      ).rejects.toThrow(/cannot be granted to an API key/);

      for (const scope of ['admin:write', 'admin:read', 'admin:compliance', 'support:ops', 'market:ops', 'agents:execute']) {
        await expect(
          db.sql`
            INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes)
            VALUES (${session.userId}, ${'desk_' + scope}, ${'hd' + scope + Date.now()}, 'ifc_d', ${[scope]})
          `,
        ).rejects.toThrow(/api_keys_no_withdraw_ck/);
      }
    });

    it('stops accepting a revoked or expired key', async () => {
      const session = await register();
      const { key, id } = await auth.createApiKey({
        userId: session.userId,
        name: 'bot',
        scopes: ['trade:read'],
        grantorScopes: SESSION_SCOPES,
      });
      expect(await auth.verifyApiKey(key)).not.toBeNull();

      await auth.revokeApiKey(session.userId, id);
      expect(await auth.verifyApiKey(key)).toBeNull();

      const other = await auth.createApiKey({
        userId: session.userId,
        name: 'expiring',
        scopes: ['trade:read'],
        grantorScopes: SESSION_SCOPES,
        expiresAt: new Date(Date.now() - 1000),
      });
      expect(await auth.verifyApiKey(other.key)).toBeNull();
    });

    it('will not let one user revoke another user’s key', async () => {
      const owner = await register();
      const attacker = await register();
      const { id } = await auth.createApiKey({ userId: owner.userId, name: 'mine', scopes: ['trade:read'], grantorScopes: SESSION_SCOPES });

      expect(await auth.revokeApiKey(attacker.userId, id)).toBe(false);
    });

    it('freezeIdentity bulk-revokes API keys and stops exchange', async () => {
      const session = await register();
      const { key, id } = await auth.createApiKey({
        userId: session.userId,
        name: 'bot',
        scopes: ['trade:read'],
        grantorScopes: SESSION_SCOPES,
      });
      expect(await auth.verifyApiKey(key)).not.toBeNull();

      const result = await auth.freezeIdentity(session.userId);
      expect(result).toMatchObject({ userId: session.userId, status: 'frozen', apiKeysRevoked: 1 });

      const listed = await auth.listApiKeys(session.userId, 200);
      expect(listed.find((k) => k.id === id)?.revoked).toBe(true);
      expect(await auth.verifyApiKey(key)).toBeNull();
      await expect(auth.exchangeApiKey(key)).rejects.toMatchObject({ code: 'auth.invalid_credentials' });
    });

    it('disableUser kills that user’s keys and refuses new mint; other users stay live', async () => {
      const session = await register();
      const other = await register();
      const { key } = await auth.createApiKey({
        userId: session.userId,
        name: 'bot',
        scopes: ['trade:read'],
        grantorScopes: SESSION_SCOPES,
      });
      const otherKey = await auth.createApiKey({
        userId: other.userId,
        name: 'other-bot',
        scopes: ['trade:read'],
        grantorScopes: SESSION_SCOPES,
      });

      const result = await disableUser(
        db.sql,
        session.userId,
        {
          actorId: other.userId,
          approvalId: 'appr-1',
          operationId: 'op-1',
          targetId: 'identity.disable_user',
        },
        stubActionApprovals(),
      );
      expect(result).toMatchObject({ userId: session.userId, status: 'frozen', keysRevoked: 1 });

      await expect(auth.exchangeApiKey(key)).rejects.toMatchObject({ code: 'auth.invalid_credentials' });
      await expect(
        auth.createApiKey({
          userId: session.userId,
          name: 'after-disable',
          scopes: ['trade:read'],
          grantorScopes: SESSION_SCOPES,
        }),
      ).rejects.toMatchObject({ code: 'auth.account_frozen' });

      await expect(auth.exchangeApiKey(otherKey.key)).resolves.toMatchObject({ userId: other.userId });
      await expect(
        auth.createApiKey({
          userId: other.userId,
          name: 'other-still',
          scopes: ['trade:read'],
          grantorScopes: SESSION_SCOPES,
        }),
      ).resolves.toMatchObject({ mode: 'live' });

      await auth.unfreezeIdentity(session.userId);
      await expect(auth.exchangeApiKey(key)).rejects.toMatchObject({ code: 'auth.invalid_credentials' });
    });

    it('honours domain_whitelist on exchange (empty = open; foreign origin refused)', async () => {
      const session = await register();

      // Empty whitelist (server bots): exchange without origin still works.
      const open = await auth.createApiKey({
        userId: session.userId,
        name: 'open-bot',
        scopes: ['trade:read'],
        grantorScopes: SESSION_SCOPES,
      });
      await expect(auth.exchangeApiKey(open.key)).resolves.toMatchObject({ userId: session.userId });
      await expect(auth.exchangeApiKey(open.key, 'https://evil.example')).resolves.toMatchObject({
        userId: session.userId,
      });

      // Non-empty whitelist: allowed origin passes; foreign / missing refuse.
      const locked = await auth.createApiKey({
        userId: session.userId,
        name: 'browser-key',
        scopes: ['trade:read'],
        grantorScopes: SESSION_SCOPES,
        domainWhitelist: ['app.example.com', 'https://partner.example'],
      });
      await expect(auth.exchangeApiKey(locked.key, 'https://app.example.com')).resolves.toMatchObject({
        userId: session.userId,
      });
      await expect(auth.exchangeApiKey(locked.key, 'https://partner.example/path')).resolves.toMatchObject({
        userId: session.userId,
      });
      await expect(auth.exchangeApiKey(locked.key, 'https://evil.example')).rejects.toMatchObject({
        code: 'auth.domain_not_allowed',
      });
      await expect(auth.exchangeApiKey(locked.key)).rejects.toMatchObject({
        code: 'auth.domain_not_allowed',
      });
      await expect(auth.exchangeApiKey(locked.key, null)).rejects.toMatchObject({
        code: 'auth.domain_not_allowed',
      });
    });

    it('mint/bind origin allowlist: listed Origin proceeds; foreign/missing refuse; empty stays unset', async () => {
      const session = await register();

      const open = await mintApiKeyWithOriginAllowlist(auth, db.sql, {
        userId: session.userId,
        name: 'open-origin',
        scopes: ['trade:read'],
        grantorScopes: SESSION_SCOPES,
        origins: [],
      });
      expect(open.originAllowlist).toEqual([]);
      expect(open.originAllowlist).not.toContain('localhost');
      await expect(auth.exchangeApiKey(open.key, 'https://evil.example')).resolves.toMatchObject({
        userId: session.userId,
      });

      const minted = await auth.createApiKey({
        userId: session.userId,
        name: 'bind-origin',
        scopes: ['trade:read'],
        grantorScopes: SESSION_SCOPES,
      });
      const bound = await bindApiKeyOriginAllowlist(db.sql, session.userId, minted.id, ['https://app.example.com', 'partner.example']);
      expect(bound.originAllowlist).toEqual(['app.example.com', 'partner.example']);
      await expect(auth.exchangeApiKey(minted.key, 'https://app.example.com')).resolves.toMatchObject({
        userId: session.userId,
      });
      await expect(auth.exchangeApiKey(minted.key, 'https://evil.example')).rejects.toMatchObject({
        code: 'auth.domain_not_allowed',
      });
      await expect(auth.exchangeApiKey(minted.key)).rejects.toMatchObject({
        code: 'auth.domain_not_allowed',
      });
    });

    it('mint/bind product scope: listed product proceeds; foreign/missing refuse; empty stays unset', async () => {
      const session = await register();

      const open = await mintApiKeyWithProductScope(auth, db.sql, {
        userId: session.userId,
        name: 'open-product',
        scopes: ['trade:read', 'p2p:read'],
        grantorScopes: SESSION_SCOPES,
        products: [],
      });
      expect(open.productScopes).toEqual([]);
      expect(open.productScopes).not.toContain('trade');
      await expect(auth.exchangeApiKey(open.key)).resolves.toMatchObject({ userId: session.userId });
      await expect(requestProductAls.run('pay', () => auth.exchangeApiKey(open.key))).resolves.toMatchObject({
        userId: session.userId,
      });

      await expect(
        mintApiKeyWithProductScope(auth, db.sql, {
          userId: session.userId,
          name: 'widen',
          scopes: ['trade:read'],
          grantorScopes: SESSION_SCOPES,
          products: ['pay'],
        }),
      ).rejects.toMatchObject({ code: 'auth.product_widen' });

      await expect(
        mintApiKeyWithProductScope(auth, db.sql, {
          userId: session.userId,
          name: 'outside',
          scopes: ['p2p:read'],
          grantorScopes: SESSION_SCOPES,
          products: ['trade'],
        }),
      ).rejects.toMatchObject({ code: 'auth.product_outside' });

      const minted = await auth.createApiKey({
        userId: session.userId,
        name: 'bind-product',
        scopes: ['trade:read'],
        grantorScopes: SESSION_SCOPES,
      });
      const bound = await bindApiKeyProductScope(db.sql, session.userId, minted.id, ['  TRADE  '], SESSION_SCOPES);
      expect(bound.productScopes).toEqual(['trade']);
      await expect(requestProductAls.run('trade', () => auth.exchangeApiKey(minted.key))).resolves.toMatchObject({
        userId: session.userId,
      });
      await expect(requestProductAls.run('p2p', () => auth.exchangeApiKey(minted.key))).rejects.toMatchObject({
        code: 'auth.domain_not_allowed',
      });
      await expect(auth.exchangeApiKey(minted.key)).rejects.toMatchObject({
        code: 'auth.domain_not_allowed',
      });
    });

    it('default-minted keys are live; exchange JWT key_env is never sandbox', async () => {
      const session = await register();
      const minted = await auth.createApiKey({
        userId: session.userId,
        name: 'live-bot',
        scopes: ['trade:read'],
        grantorScopes: SESSION_SCOPES,
      });

      expect(minted.mode).toBe('live');
      expect(minted.key.startsWith('ifc_')).toBe(true);
      expect(minted.key.startsWith('ifc_test_')).toBe(false);

      const stored = await db.sql<Array<{ mode: string }>>`
        SELECT mode FROM api_keys WHERE id = ${minted.id}
      `;
      expect(stored[0]!.mode).toBe('live');

      const exchanged = await auth.exchangeApiKey(minted.key);
      expect(exchanged.mode).toBe('live');
      const principal = await verifyAccessToken(exchanged.accessToken, tokenConfig);
      expect(principal.key_env).toBe('live');
      expect(principal.key_env).not.toBe('sandbox');
    });

    it('explicit sandbox mint prefixes ifc_test_ and puts key_env sandbox on the JWT', async () => {
      const session = await register();
      const minted = await auth.createApiKey({
        userId: session.userId,
        name: 'sandbox-bot',
        scopes: ['pay:read'],
        grantorScopes: [...SESSION_SCOPES, 'pay:read', 'pay:write'],
        mode: 'sandbox',
      });

      expect(minted.mode).toBe('sandbox');
      expect(minted.key.startsWith('ifc_test_')).toBe(true);

      const stored = await db.sql<Array<{ mode: string }>>`
        SELECT mode FROM api_keys WHERE id = ${minted.id}
      `;
      expect(stored[0]!.mode).toBe('sandbox');

      const exchanged = await auth.exchangeApiKey(minted.key);
      expect(exchanged.mode).toBe('sandbox');
      const principal = await verifyAccessToken(exchanged.accessToken, tokenConfig);
      expect(principal.key_env).toBe('sandbox');
    });

    it('a sandbox key is limited to pay scopes: only svc-pay honours sandbox mode', async () => {
      const session = await register();
      for (const scopes of [['trade:read'], ['pay:read', 'trade:write'], ['p2p:read']]) {
        const grantorScopes = [...SESSION_SCOPES, 'pay:read', 'pay:write'];
        await expect(
          auth.createApiKey({ userId: session.userId, name: 'sandbox-wide', scopes, grantorScopes, mode: 'sandbox' }),
        ).rejects.toMatchObject({ code: 'auth.sandbox_scope_not_pay' });
      }
      const rows = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM api_keys WHERE user_id = ${session.userId}`;
      expect(rows[0]!.n).toBe(0);
      await expect(
        auth.createApiKey({
          userId: session.userId,
          name: 'sandbox-pay',
          scopes: ['pay:read', 'pay:write'],
          grantorScopes: [...SESSION_SCOPES, 'pay:read', 'pay:write'],
          mode: 'sandbox',
        }),
      ).resolves.toMatchObject({ mode: 'sandbox' });
      // Live keys are unaffected.
      await expect(
        auth.createApiKey({ userId: session.userId, name: 'live-wide', scopes: ['trade:read'], grantorScopes: SESSION_SCOPES }),
      ).resolves.toMatchObject({ mode: 'live' });
    });
  });

  describe('sub-accounts', () => {
    it('creates and lists only the parent’s books', async () => {
      const owner = await register();
      const other = await register();
      const { id } = await auth.createSubAccount(owner.userId, 'bot-a', 'mm');
      await auth.createSubAccount(other.userId, 'not-yours');

      const mine = await auth.listSubAccounts(owner.userId, 200);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ id, label: 'bot-a', purpose: 'mm', revoked: false });
      expect(await auth.listSubAccounts(other.userId, 200)).toHaveLength(1);
    });

    it('soft-revokes without deleting the row (ledger owner id must survive)', async () => {
      const session = await register();
      const { id } = await auth.createSubAccount(session.userId, 'retire-me');

      expect(await auth.revokeSubAccount(session.userId, id)).toBe(true);
      expect(await auth.revokeSubAccount(session.userId, id)).toBe(false);

      const listed = await auth.listSubAccounts(session.userId, 200);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id, revoked: true });

      const rows = await db.sql<Array<{ id: string; revoked: boolean }>>`
        SELECT id, revoked FROM sub_accounts WHERE id = ${id}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.revoked).toBe(true);
    });

    it('freezeIdentity soft-revokes every sub-account and does not un-revoke on thaw', async () => {
      const session = await register();
      const a = await auth.createSubAccount(session.userId, 'a');
      const b = await auth.createSubAccount(session.userId, 'b');

      const frozen = await auth.freezeIdentity(session.userId);
      expect(frozen.subAccountsRevoked).toBe(2);
      const listed = await auth.listSubAccounts(session.userId, 200);
      expect(listed.every((s) => s.revoked)).toBe(true);

      await auth.unfreezeIdentity(session.userId);
      const afterThaw = await auth.listSubAccounts(session.userId, 200);
      // Explicit reopen only — freeze cascade is not a soft toggle for books.
      expect(afterThaw.find((s) => s.id === a.id)?.revoked).toBe(true);
      expect(afterThaw.find((s) => s.id === b.id)?.revoked).toBe(true);
    });

    it('will not let one user revoke another user’s sub-account', async () => {
      const owner = await register();
      const attacker = await register();
      const { id } = await auth.createSubAccount(owner.userId, 'mine');

      expect(await auth.revokeSubAccount(attacker.userId, id)).toBe(false);
      const still = await auth.listSubAccounts(owner.userId, 200);
      expect(still[0]).toMatchObject({ id, revoked: false });
    });

    it('S2S ownership snapshot returns parent + revoked, null when missing', async () => {
      const owner = await register();
      const { id } = await auth.createSubAccount(owner.userId, 's2s-book');

      await expect(auth.getSubAccountOwnership(id)).resolves.toEqual({
        id,
        parentUserId: owner.userId,
        revoked: false,
      });

      await auth.revokeSubAccount(owner.userId, id);
      await expect(auth.getSubAccountOwnership(id)).resolves.toEqual({
        id,
        parentUserId: owner.userId,
        revoked: true,
      });

      await expect(auth.getSubAccountOwnership('00000000-0000-4000-8000-000000000099')).resolves.toBeNull();
    });

    describe('assertSubAccountOwned — single-row ownership at the door', () => {
      it('accepts a live partition the caller owns', async () => {
        const owner = await register();
        const a = await auth.createSubAccount(owner.userId, 'bot');
        await expect(auth.assertSubAccountOwned(owner.userId, a.id)).resolves.toEqual({
          id: a.id,
          parentUserId: owner.userId,
        });
      });

      it('refuses a missing id — never defaults to primary', async () => {
        const owner = await register();
        await expect(auth.assertSubAccountOwned(owner.userId, null)).rejects.toMatchObject({
          code: 'auth.sub_account_required',
        });
        await expect(auth.assertSubAccountOwned(owner.userId, '')).rejects.toMatchObject({
          code: 'auth.sub_account_required',
        });
      });

      it('refuses foreign and missing with the same denied code', async () => {
        const owner = await register();
        const other = await register();
        const theirs = await auth.createSubAccount(other.userId, 'theirs');
        await expect(auth.assertSubAccountOwned(owner.userId, theirs.id)).rejects.toMatchObject({
          code: 'auth.sub_account_denied',
        });
        await expect(auth.assertSubAccountOwned(owner.userId, '00000000-0000-4000-8000-000000000099')).rejects.toMatchObject({
          code: 'auth.sub_account_denied',
        });
      });

      it('refuses a revoked partition', async () => {
        const owner = await register();
        const a = await auth.createSubAccount(owner.userId, 'dead');
        await auth.revokeSubAccount(owner.userId, a.id);
        await expect(auth.assertSubAccountOwned(owner.userId, a.id)).rejects.toMatchObject({
          code: 'auth.sub_account_revoked',
        });
      });
    });

    describe('assertSubAccountTransferDoor — ownership at the door', () => {
      it('accepts two live partitions the caller owns', async () => {
        const owner = await register();
        const a = await auth.createSubAccount(owner.userId, 'from');
        const b = await auth.createSubAccount(owner.userId, 'to');

        await expect(auth.assertSubAccountTransferDoor(owner.userId, a.id, b.id)).resolves.toEqual({
          fromId: a.id,
          toId: b.id,
        });
      });

      it('refuses a missing from or to — never defaults to primary', async () => {
        const owner = await register();
        const a = await auth.createSubAccount(owner.userId, 'only');

        await expect(auth.assertSubAccountTransferDoor(owner.userId, null, a.id)).rejects.toMatchObject({
          code: 'auth.sub_account_required',
        });
        await expect(auth.assertSubAccountTransferDoor(owner.userId, a.id, undefined)).rejects.toMatchObject({
          code: 'auth.sub_account_required',
        });
        await expect(auth.assertSubAccountTransferDoor(owner.userId, '', a.id)).rejects.toMatchObject({
          code: 'auth.sub_account_required',
        });
      });

      it('refuses same partition twice', async () => {
        const owner = await register();
        const a = await auth.createSubAccount(owner.userId, 'solo');
        await expect(auth.assertSubAccountTransferDoor(owner.userId, a.id, a.id)).rejects.toMatchObject({
          code: 'auth.sub_account_same',
        });
      });

      it('refuses a foreign or missing partition without confirming which', async () => {
        const owner = await register();
        const other = await register();
        const mine = await auth.createSubAccount(owner.userId, 'mine');
        const theirs = await auth.createSubAccount(other.userId, 'theirs');

        await expect(auth.assertSubAccountTransferDoor(owner.userId, mine.id, theirs.id)).rejects.toMatchObject({
          code: 'auth.sub_account_denied',
        });
        await expect(
          auth.assertSubAccountTransferDoor(owner.userId, mine.id, '00000000-0000-4000-8000-000000000099'),
        ).rejects.toMatchObject({ code: 'auth.sub_account_denied' });
      });

      it('refuses when either side is revoked', async () => {
        const owner = await register();
        const a = await auth.createSubAccount(owner.userId, 'live');
        const b = await auth.createSubAccount(owner.userId, 'dead');
        await auth.revokeSubAccount(owner.userId, b.id);

        await expect(auth.assertSubAccountTransferDoor(owner.userId, a.id, b.id)).rejects.toMatchObject({
          code: 'auth.sub_account_revoked',
        });
      });
    });

    it('refuses create when the live-partition cap is unset (does not invent 25)', async () => {
      const unpublished = new AuthService(db.sql, bus, rank, tokenConfig, webauthnConfig, totpSecretKeyMaterial);
      const handle = unique();
      const owner = await unpublished.register({
        handle,
        email: `${handle}@example.com`,
        password: 'correct horse battery staple',
      });
      await expect(unpublished.createSubAccount(owner.userId, 'a')).rejects.toMatchObject({
        code: 'auth.sub_account_cap_unset',
      });
    });

    it('refuses create past the owner-published live-partition max', async () => {
      const capped = new AuthService(db.sql, bus, rank, tokenConfig, webauthnConfig, totpSecretKeyMaterial, undefined, undefined, 2);
      const handle = unique();
      const owner = await capped.register({
        handle,
        email: `${handle}@example.com`,
        password: 'correct horse battery staple',
      });
      await capped.createSubAccount(owner.userId, 'a');
      await capped.createSubAccount(owner.userId, 'b');
      await expect(capped.createSubAccount(owner.userId, 'c')).rejects.toMatchObject({
        code: 'auth.sub_account_limit',
      });
      // Revoke frees a slot — the bound is live partitions, not historical rows.
      const listed = await capped.listSubAccounts(owner.userId, 200);
      const first = listed.find((r) => !r.revoked)!;
      await capped.revokeSubAccount(owner.userId, first.id);
      await expect(capped.createSubAccount(owner.userId, 'reuse-slot')).resolves.toMatchObject({
        id: expect.any(String),
      });
    });
  });

  describe('KYC', () => {
    it('L232: there is no door that writes an already-approved record without a pending record and an operator', async () => {
      const session = await register();
      expect('approveKyc' in auth).toBe(false);
      const rows = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM kyc_records WHERE user_id = ${session.userId}`;
      expect(rows[0]!.n).toBe('0');
    });

    it('raises the tier on the next issued token', async () => {
      const handle = unique();
      const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple' });
      expect((await verifyAccessToken(session.accessToken, tokenConfig)).tier).toBe('none');

      await grantKyc(session.userId, 'full');

      const refreshed = await auth.refresh(session.refreshToken);
      expect((await verifyAccessToken(refreshed.accessToken, tokenConfig)).tier).toBe('full');
    });

    it('reports the highest approved tier', async () => {
      const session = await register();
      await grantKyc(session.userId, 'basic');
      await grantKyc(session.userId, 'full');
      expect(await auth.kycTier(session.userId)).toBe('full');
    });

    it('ignores an expired record', async () => {
      const session = await register();
      await grantKyc(session.userId, 'full');
      await db.sql`UPDATE kyc_records SET expires_at = now() - interval '1 day' WHERE user_id = ${session.userId}`;
      expect(await auth.kycTier(session.userId)).toBe('none');
    });
  });

  /**
   * THE ROUTED OPERATOR FLOW — submit → approve.
   *
   * This is the gap that made the custodial side unusable: `approveKyc` existed
   * on no route, so every account sat at `none` forever and every module the
   * jurisdiction matrix gates on a tier was unreachable. These tests are the
   * ones that fail if the flow breaks again.
   */
  describe('KYC review flow', () => {
    it('SUBMIT GRANTS NOTHING — a submitted record leaves the tier at none', async () => {
      const session = await register();
      const record = await auth.submitKyc({ userId: session.userId, tier: 'basic', jurisdiction: 'DE' });

      expect(record.status).toBe('pending');
      expect(record.reviewedBy).toBeNull();
      // The whole point of splitting submit from approve. If this ever returns
      // 'basic', a user has granted themselves custodial access.
      expect(await auth.kycTier(session.userId)).toBe('none');
    });

    it('approval raises the tier and records WHICH operator granted it', async () => {
      const session = await register();
      const operator = await register();
      const submitted = await auth.submitKyc({ userId: session.userId, tier: 'basic', jurisdiction: 'DE' });

      const approved = await auth.approveKycRecord({ recordId: submitted.id, reviewerId: operator.userId, approvalParties: [] });

      expect(approved.status).toBe('approved');
      expect(approved.reviewedBy).toBe(operator.userId);
      expect(approved.reviewedAt).toBeInstanceOf(Date);
      expect(await auth.kycTier(session.userId)).toBe('basic');
    });

    it('refuses an agent principal writing reviewed_by — service or API-key kid', async () => {
      const session = await register();
      const operator = await register();
      const submitted = await auth.submitKyc({ userId: session.userId, tier: 'basic', jurisdiction: 'DE' });

      await expect(
        auth.approveKycRecord({
          recordId: submitted.id,
          reviewerId: operator.userId,
          service: 'svc-agents',
          approvalParties: [],
        }),
      ).rejects.toMatchObject({ code: 'auth.kyc_agent_refused' });

      const second = await auth.submitKyc({ userId: session.userId, tier: 'full', jurisdiction: 'DE' });
      await expect(
        auth.rejectKycRecord({
          reasonCode: 'document_unreadable',
          recordId: second.id,
          reviewerId: operator.userId,
          kid: 'agent-key',
          approvalParties: [],
        }),
      ).rejects.toMatchObject({ code: 'auth.kyc_agent_refused' });

      expect(await auth.kycTier(session.userId)).toBe('none');
      expect((await auth.getKycRecord(submitted.id))?.reviewedBy).toBeNull();
    });

    it('refuses a review by anyone whose KYC it is: the reviewer, the named second operator or either approval party', async () => {
      const session = await register();
      const operator = await register();
      const submitted = await auth.submitKyc({ userId: session.userId, tier: 'basic', jurisdiction: 'DE' });
      const self = { code: 'auth.kyc_self_review' };

      await expect(
        auth.approveKycRecord({ recordId: submitted.id, reviewerId: session.userId, approvalParties: [] }),
      ).rejects.toMatchObject(self);
      await expect(
        auth.approveKycRecord({ recordId: submitted.id, reviewerId: operator.userId, confirmActorId: session.userId, approvalParties: [] }),
      ).rejects.toMatchObject(self);
      // Two operators approving each other's KYC: the subject proposed, or approved, the four-eyes approval.
      for (const approvalParties of [
        [session.userId, operator.userId],
        [operator.userId, session.userId],
      ]) {
        await expect(auth.approveKycRecord({ recordId: submitted.id, reviewerId: operator.userId, approvalParties })).rejects.toMatchObject(
          self,
        );
        await expect(
          auth.rejectKycRecord({ reasonCode: 'document_unreadable', recordId: submitted.id, reviewerId: operator.userId, approvalParties }),
        ).rejects.toMatchObject(self);
      }

      expect(await auth.kycTier(session.userId)).toBe('none');
      expect(await auth.getKycRecord(submitted.id)).toMatchObject({ status: 'pending', reviewedBy: null });

      // Two other people on the approval: it goes ahead.
      const third = await register();
      await expect(
        auth.approveKycRecord({ recordId: submitted.id, reviewerId: operator.userId, approvalParties: [operator.userId, third.userId] }),
      ).resolves.toMatchObject({ status: 'approved', reviewedBy: operator.userId });
    });

    it('unblocks the custodial matrix rule that was blocking every new account', async () => {
      const session = await register();
      const operator = await register();

      // `trade` is OPEN_BASIC — the CUSTODIAL spot venue, which holds user funds
      // in ledger accounts. Before approval a freshly registered user cannot
      // place an order at all.
      // KYC-only fixture: no sanctions authority is supplied or claimed.
      const before = checkAccess({
        screeningFailClosed: false,
        module: 'trade',
        region: 'DE',
        plane: 'fiat',
        kycTier: await auth.kycTier(session.userId),
      });
      expect(before.allowed).toBe(false);
      expect(before.code).toBe('denied.kyc_required');

      const submitted = await auth.submitKyc({ userId: session.userId, tier: 'basic', jurisdiction: 'DE' });
      await auth.approveKycRecord({ recordId: submitted.id, reviewerId: operator.userId, approvalParties: [] });

      const after = checkAccess({
        screeningFailClosed: false,
        module: 'trade',
        region: 'DE',
        plane: 'fiat',
        kycTier: await auth.kycTier(session.userId),
      });
      expect(after.allowed).toBe(true);
    });

    it('still refuses an unconfigured sanctions list for a verified identity', async () => {
      const session = await register();
      await grantKyc(session.userId, 'full');
      expect(screeningFailClosedFromEnv({})).toBe(true);
      const decision = checkAccess({
        module: 'bank',
        region: 'DE',
        plane: 'fiat',
        kycTier: await auth.kycTier(session.userId),
        screening: UNSET_SCREENING_LIST,
        screeningFailClosed: screeningFailClosedFromEnv({}),
      });
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe('denied.screening_unconfigured');
      expect(decision.screening.listConfigured).toBe(false);
    });

    it('leaves the PERMISSIONLESS plane alone — no tier is ever consulted there (§22)', async () => {
      const session = await register();

      // The correction that matters: zero-KYC follows custody. A non-custodial
      // Protocol Plane module returns `allowed.permissionless` BEFORE any tier
      // is read, so an unverified account is not second class there — it is the
      // normal case. If this ever fails, a KYC gate has leaked onto a plane that
      // holds nothing.
      // Custody-only fixture: no sanctions authority is supplied or claimed.
      const decision = checkAccess({
        screeningFailClosed: false,
        module: 'protocol',
        region: 'DE',
        plane: 'protocol',
        kycTier: await auth.kycTier(session.userId),
      });
      expect(decision.allowed).toBe(true);
      expect(decision.code).toBe('allowed.permissionless');
    });

    it('is idempotent on (user, tier) — a double tap does not queue two reviews', async () => {
      const session = await register();
      const first = await auth.submitKyc({ userId: session.userId, tier: 'basic', jurisdiction: 'DE' });
      const second = await auth.submitKyc({ userId: session.userId, tier: 'basic', jurisdiction: 'DE' });

      expect(second.id).toBe(first.id);
      const rows = await db.sql`SELECT id FROM kyc_records WHERE user_id = ${session.userId}`;
      expect(rows).toHaveLength(1);
    });

    it('does not let a re-submit reset an approved tier back to pending', async () => {
      const session = await register();
      const operator = await register();
      const submitted = await auth.submitKyc({ userId: session.userId, tier: 'full', jurisdiction: 'DE' });
      await auth.approveKycRecord({ recordId: submitted.id, reviewerId: operator.userId, approvalParties: [] });

      const again = await auth.submitKyc({ userId: session.userId, tier: 'basic', jurisdiction: 'DE' });

      expect(again.status).toBe('approved');
      // Still `full`. A resubmit that downgraded a live tier would be a way for
      // a user to lock themselves out, and for an attacker to do it to them.
      expect(await auth.kycTier(session.userId)).toBe('full');
    });

    it('approving twice is a no-op, not a second grant', async () => {
      const session = await register();
      const operator = await register();
      const submitted = await auth.submitKyc({ userId: session.userId, tier: 'basic', jurisdiction: 'DE' });

      const once = await auth.approveKycRecord({ recordId: submitted.id, reviewerId: operator.userId, approvalParties: [] });
      const twice = await auth.approveKycRecord({ recordId: submitted.id, reviewerId: operator.userId, approvalParties: [] });

      expect(twice.id).toBe(once.id);
      expect(twice.reviewedAt?.getTime()).toBe(once.reviewedAt?.getTime());
      const rows = await db.sql`SELECT id FROM kyc_records WHERE user_id = ${session.userId} AND status = 'approved'`;
      expect(rows).toHaveLength(1);
    });

    it('refuses to approve a rejected record', async () => {
      const session = await register();
      const operator = await register();
      const submitted = await auth.submitKyc({ userId: session.userId, tier: 'basic', jurisdiction: 'DE' });
      await auth.rejectKycRecord({
        reasonCode: 'document_unreadable',
        recordId: submitted.id,
        reviewerId: operator.userId,
        approvalParties: [],
      });

      await expect(
        auth.approveKycRecord({ recordId: submitted.id, reviewerId: operator.userId, approvalParties: [] }),
      ).rejects.toMatchObject({
        code: 'auth.kyc_not_pending',
      });
      expect(await auth.kycTier(session.userId)).toBe('none');
    });

    it('reject writes the operator on the row and still grants nothing', async () => {
      const session = await register();
      const operator = await register();
      const submitted = await auth.submitKyc({ userId: session.userId, tier: 'basic', jurisdiction: 'DE' });

      const rejected = await auth.rejectKycRecord({
        reasonCode: 'document_unreadable',
        recordId: submitted.id,
        reviewerId: operator.userId,
        approvalParties: [],
      });
      expect(rejected.status).toBe('rejected');
      expect(rejected.reviewedBy).toBe(operator.userId);
      expect(rejected.reviewedAt).toBeInstanceOf(Date);
      expect(await auth.kycTier(session.userId)).toBe('none');

      // Re-reject is a no-op (same stamps), not a second write.
      const again = await auth.rejectKycRecord({
        reasonCode: 'document_unreadable',
        recordId: submitted.id,
        reviewerId: 'other-op',
        approvalParties: [],
      });
      expect(again.reviewedBy).toBe(operator.userId);
      expect(again.reviewedAt?.getTime()).toBe(rejected.reviewedAt?.getTime());
    });

    it('after reject, a new submit can open a fresh pending without touching the old row', async () => {
      const session = await register();
      const operator = await register();
      const first = await auth.submitKyc({ userId: session.userId, tier: 'basic', jurisdiction: 'DE' });
      await auth.rejectKycRecord({
        reasonCode: 'document_unreadable',
        recordId: first.id,
        reviewerId: operator.userId,
        approvalParties: [],
      });

      const second = await auth.submitKyc({ userId: session.userId, tier: 'basic', jurisdiction: 'DE' });
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe('pending');
      expect(await auth.kycTier(session.userId)).toBe('none');

      const rows = await db.sql<Array<{ id: string; status: string }>>`
        SELECT id, status FROM kyc_records WHERE user_id = ${session.userId} ORDER BY created_at
      `;
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.status).sort()).toEqual(['pending', 'rejected']);
    });

    it('refuses to reject an already-approved record', async () => {
      const session = await register();
      const operator = await register();
      const submitted = await auth.submitKyc({ userId: session.userId, tier: 'basic', jurisdiction: 'DE' });
      await auth.approveKycRecord({ recordId: submitted.id, reviewerId: operator.userId, approvalParties: [] });

      await expect(
        auth.rejectKycRecord({
          reasonCode: 'document_unreadable',
          recordId: submitted.id,
          reviewerId: operator.userId,
          approvalParties: [],
        }),
      ).rejects.toMatchObject({
        code: 'auth.kyc_not_pending',
      });
      expect(await auth.kycTier(session.userId)).toBe('basic');
    });

    it('refuses an unknown record rather than creating one', async () => {
      await expect(
        auth.approveKycRecord({ recordId: '00000000-0000-4000-8000-000000000000', reviewerId: 'op', approvalParties: [] }),
      ).rejects.toMatchObject({
        code: 'auth.not_found',
      });
    });

    describe('campaign participant for the participation rules (CM-eligibility-rules-01)', () => {
      it('an unknown or malformed user is null, never eligible', async () => {
        expect(await auth.campaignParticipant('00000000-0000-4000-8000-000000000000')).toBeNull();
        expect(await auth.campaignParticipant('not-a-uuid')).toBeNull();
      });

      it('carries the account type, region, status and tier, and nothing else', async () => {
        const session = await register();
        const fresh = await auth.campaignParticipant(session.userId);
        expect(campaignParticipantSchema.parse(fresh)).toEqual(fresh);
        expect(fresh).toMatchObject({ userId: session.userId, accountType: 'individual', status: 'active', kycTier: 'none' });
        await db.sql`UPDATE profiles SET account_type = 'business', region = 'fr' WHERE user_id = ${session.userId}`;
        await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${session.userId}`;
        expect(await auth.campaignParticipant(session.userId)).toEqual({
          userId: session.userId,
          accountType: 'business',
          region: 'FR',
          status: 'frozen',
          kycTier: 'none',
        });
        await db.sql`UPDATE profiles SET region = NULL WHERE user_id = ${session.userId}`;
        expect((await auth.campaignParticipant(session.userId))?.region).toBeNull();
      });
    });

    describe('email proof for the order gate (RC-identity-01)', () => {
      it('an unknown or malformed user is null, never proved', async () => {
        expect(await auth.emailProof('00000000-0000-4000-8000-000000000000')).toBeNull();
        expect(await auth.emailProof('not-a-uuid')).toBeNull();
      });

      it('is missing until the current email is confirmed, then accepted, and carries no address', async () => {
        const session = await register();
        const missing = await auth.emailProof(session.userId);
        expect(missing).toEqual({ userId: session.userId, emailProof: 'missing' });
        expect(emailProofSchema.parse(missing)).toEqual(missing);
        await db.sql`UPDATE users SET email_verified_at = now() WHERE id = ${session.userId}`;
        expect(await auth.emailProof(session.userId)).toEqual({ userId: session.userId, emailProof: 'accepted' });
      });
    });

    /**
     * The projection svc-support reads to ground a ticket (`accountStateSchema`).
     *
     * `users.status` was read by nine call sites in this service and returned by
     * none — so the support desk had no way to know an account was frozen, and
     * the only alternative was for it to keep its own copy. These hold the two
     * halves that matter: the fact is now reachable, and it is the ONLY thing
     * that is.
     */
    describe('account state for another service to read', () => {
      it('an unknown user is null, never an account in good standing', async () => {
        // If this ever answers `{status:'active'}` for an id that does not exist,
        // every support answer about a missing account is a false reassurance.
        expect(await auth.accountState('00000000-0000-4000-8000-000000000000')).toBeNull();
      });

      it('reports a fresh account as active at tier none', async () => {
        const session = await register();
        expect(await auth.accountState(session.userId)).toEqual({
          userId: session.userId,
          status: 'active',
          kycTier: 'none',
        });
      });

      it('reports a freeze — the fact a desk exists to be able to see', async () => {
        const session = await register();
        await auth.freezeIdentity(session.userId);
        expect(await auth.accountState(session.userId)).toMatchObject({ status: 'frozen' });
        await auth.unfreezeIdentity(session.userId);
        expect(await auth.accountState(session.userId)).toMatchObject({ status: 'active' });
      });

      it('tracks the approved tier, never a merely submitted one', async () => {
        const session = await register();
        const operator = await register();
        const submitted = await auth.submitKyc({ userId: session.userId, tier: 'basic', jurisdiction: 'DE' });
        // Same split as `kycTier`: a submission grants nothing, so an operator
        // must not see a tier the user has not actually been given.
        expect(await auth.accountState(session.userId)).toMatchObject({ kycTier: 'none' });

        await auth.approveKycRecord({ recordId: submitted.id, reviewerId: operator.userId, approvalParties: [] });
        expect(await auth.accountState(session.userId)).toMatchObject({ kycTier: 'basic' });
      });

      it('carries no balance, no document and no name — three keys and no more', async () => {
        const session = await register();
        const state = await auth.accountState(session.userId);
        // §10 PII isolation and §0.6 in one assertion. The encrypted KYC vault
        // (a688e231) must not gain a second read path through the support desk,
        // and the shortness of this object is what prevents it.
        expect(Object.keys(state!).sort()).toEqual(['kycTier', 'status', 'userId']);
      });

      it('a closed account reads as closed, not as missing', async () => {
        const session = await register();
        await db.sql`UPDATE users SET status = 'closed' WHERE id = ${session.userId}`;
        // Distinct from the null above: "this account is closed" is something a
        // support operator can act on; "no such account" is not.
        expect(await auth.accountState(session.userId)).toMatchObject({ status: 'closed' });
      });
    });

    it('announces the grant once, on the bus and as XP', async () => {
      const session = await register();
      const operator = await register();
      const submitted = await auth.submitKyc({ userId: session.userId, tier: 'basic', jurisdiction: 'DE' });

      bus.reset();
      await auth.approveKycRecord({ recordId: submitted.id, reviewerId: operator.userId, approvalParties: [] });
      await auth.approveKycRecord({ recordId: submitted.id, reviewerId: operator.userId, approvalParties: [] });

      const published = bus.published.filter((p) => p.subject.includes('kyc'));
      expect(published).toHaveLength(1);
    });

    it('surfaces the pending queue oldest first, and drops a record once reviewed', async () => {
      const a = await register();
      const b = await register();
      const operator = await register();
      const first = await auth.submitKyc({ userId: a.userId, tier: 'basic', jurisdiction: 'DE' });
      const second = await auth.submitKyc({ userId: b.userId, tier: 'basic', jurisdiction: 'DE' });

      /**
       * Assert the ordering claim over *these two* records rather than over
       * absolute positions in the queue. The claim under test is "the queue is
       * FIFO", which is a statement about relative order; comparing raw indices
       * additionally assumes nothing else is pending, which is an assumption
       * about the fixture, not about the code. Belt and braces with the
       * `beforeEach` truncate above — that removes the backlog, this makes the
       * test state what it actually means.
       */
      const queue = await auth.listPendingKyc(200);
      const ids = queue.map((r) => r.id);
      expect(ids).toContain(first.id);
      expect(ids).toContain(second.id);
      const mine = ids.filter((id) => id === first.id || id === second.id);
      expect(mine).toEqual([first.id, second.id]);

      await auth.approveKycRecord({ recordId: first.id, reviewerId: operator.userId, approvalParties: [] });
      expect((await auth.listPendingKyc(200)).map((r) => r.id)).not.toContain(first.id);
    });
  });

  /**
   * THE STEP-UP CHALLENGE.
   *
   * `defaultScopes()` withholds `trade:withdraw` "until a step-up challenge",
   * and there was no step-up challenge anywhere in the OS — so no session could
   * ever reach a withdrawal endpoint. These tests hold that door open.
   */
  describe('step-up elevation', () => {
    const enrol = async (userId: string) => {
      const { secret, recoveryCodes } = await auth.startTotpEnrolment(userId, PASSWORD_SESSION);
      await auth.confirmTotpEnrolment(userId, PASSWORD_SESSION, secret, totp(secret));
      return { secret, recoveryCodes };
    };

    it('a normal session does NOT carry trade:withdraw', async () => {
      const session = await register();
      const principal = await verifyAccessToken(session.accessToken, tokenConfig);

      expect(hasScope(principal.scopes, 'trade:withdraw')).toBe(false);
      expect(principal.mfa).toBe(false);
    });

    it('a valid TOTP code buys a token that carries trade:withdraw with mfa set', async () => {
      const session = await register();
      const { secret } = await enrol(session.userId);

      const elevated = await auth.stepUp({
        userId: session.userId,
        sessionId: session.sessionId,
        totpCode: totpNext(secret),
      });
      const principal = await verifyAccessToken(elevated.accessToken, tokenConfig);

      expect(hasScope(principal.scopes, 'trade:withdraw')).toBe(true);
      // Both halves matter: `requireScope` demands the scope AND `mfa`, because
      // `trade:withdraw` is in INTERACTIVE_ONLY_SCOPES.
      expect(principal.mfa).toBe(true);
    });

    it('the elevated token expires far sooner than a normal one', async () => {
      const session = await register();
      const { secret } = await enrol(session.userId);

      const elevated = await auth.stepUp({
        userId: session.userId,
        sessionId: session.sessionId,
        totpCode: totpNext(secret),
      });
      const lifetimeSeconds = (elevated.expiresAt.getTime() - Date.now()) / 1000;

      // Five minutes, not the 900s a normal access token gets. An elevation that
      // lasted the full TTL would hand a thief the same window as the owner.
      expect(lifetimeSeconds).toBeLessThanOrEqual(300);
      expect(lifetimeSeconds).toBeGreaterThan(240);
    });

    it('refuses a wrong code', async () => {
      const session = await register();
      await enrol(session.userId);

      await expect(auth.stepUp({ userId: session.userId, sessionId: session.sessionId, totpCode: '000000' })).rejects.toMatchObject({
        code: 'auth.mfa_invalid',
      });
    });

    it('refuses an account with no second factor to step up with', async () => {
      const session = await register();

      // §9: moving value off the platform requires 2FA. An account without it
      // is refused, not waved through — and the code says which, so the client
      // can send the user to enrolment rather than retrying a code forever.
      await expect(auth.stepUp({ userId: session.userId, sessionId: session.sessionId, totpCode: '123456' })).rejects.toMatchObject({
        code: 'auth.mfa_not_enrolled',
      });
    });

    it('refuses to elevate off a session that has been logged out', async () => {
      const session = await register();
      const { secret } = await enrol(session.userId);
      await auth.logoutAll(session.userId);

      // Otherwise a logout could be undone by whoever still holds the old
      // access token, which is precisely the party a logout is aimed at.
      await expect(auth.stepUp({ userId: session.userId, sessionId: session.sessionId, totpCode: totpNext(secret) })).rejects.toMatchObject(
        {
          code: 'auth.session_invalid',
        },
      );
    });

    it('refuses a frozen account', async () => {
      const session = await register();
      const { secret } = await enrol(session.userId);
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${session.userId}`;

      await expect(auth.stepUp({ userId: session.userId, sessionId: session.sessionId, totpCode: totpNext(secret) })).rejects.toMatchObject(
        {
          code: 'auth.account_frozen',
        },
      );
    });

    // W6-L12: recovery codes are second-factor credentials. Lost authenticator
    // must still unlock trade:withdraw without re-enrolling TOTP first (login
    // already redeems them; step-up did not).
    it('a recovery code buys trade:withdraw step-up, burns once, and refuses replay', async () => {
      const session = await register();
      const { secret, recoveryCodes } = await enrol(session.userId);
      const code = recoveryCodes[0]!;
      expect(code).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/);

      const before = await db.sql<Array<{ recovery_code_hashes: unknown }>>`
        SELECT recovery_code_hashes FROM users WHERE id = ${session.userId}
      `;
      const hashesBefore = normalizeStringList(before[0]!.recovery_code_hashes);
      expect(hashesBefore.length).toBe(recoveryCodes.length);

      const elevated = await auth.stepUp({
        userId: session.userId,
        sessionId: session.sessionId,
        totpCode: code,
      });
      const principal = await verifyAccessToken(elevated.accessToken, tokenConfig);
      expect(hasScope(principal.scopes, 'trade:withdraw')).toBe(true);
      expect(principal.mfa).toBe(true);
      const lifetimeSeconds = (elevated.expiresAt.getTime() - Date.now()) / 1000;
      expect(lifetimeSeconds).toBeLessThanOrEqual(300);
      expect(lifetimeSeconds).toBeGreaterThan(240);

      const after = await db.sql<Array<{ recovery_code_hashes: unknown }>>`
        SELECT recovery_code_hashes FROM users WHERE id = ${session.userId}
      `;
      expect(normalizeStringList(after[0]!.recovery_code_hashes)).toHaveLength(recoveryCodes.length - 1);

      // Single-use: same recovery code cannot elevate again.
      await expect(auth.stepUp({ userId: session.userId, sessionId: session.sessionId, totpCode: code })).rejects.toMatchObject({
        code: 'auth.mfa_invalid',
      });

      // Valid TOTP still steps up after a recovery burn (next step — enrol burned current).
      const again = await auth.stepUp({
        userId: session.userId,
        sessionId: session.sessionId,
        totpCode: totpNext(secret),
      });
      expect(hasScope((await verifyAccessToken(again.accessToken, tokenConfig)).scopes, 'trade:withdraw')).toBe(true);
    });

    it('refuses a recovery-shaped code that was never issued', async () => {
      const session = await register();
      await enrol(session.userId);

      await expect(
        auth.stepUp({
          userId: session.userId,
          sessionId: session.sessionId,
          totpCode: 'AAAAA-BBBBB',
        }),
      ).rejects.toMatchObject({ code: 'auth.mfa_invalid' });
    });

    it('refuses recovery step-up on a frozen account before burning the code', async () => {
      const session = await register();
      const { recoveryCodes } = await enrol(session.userId);
      const code = recoveryCodes[0]!;
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${session.userId}`;

      await expect(auth.stepUp({ userId: session.userId, sessionId: session.sessionId, totpCode: code })).rejects.toMatchObject({
        code: 'auth.account_frozen',
      });

      // Freeze check is before redeem — code must still be available after thaw.
      await db.sql`UPDATE users SET status = 'active' WHERE id = ${session.userId}`;
      const remaining = await db.sql<Array<{ recovery_code_hashes: unknown }>>`
        SELECT recovery_code_hashes FROM users WHERE id = ${session.userId}
      `;
      expect(normalizeStringList(remaining[0]!.recovery_code_hashes)).toHaveLength(recoveryCodes.length);
    });

    it('refuses recovery step-up on a dead session without burning the code', async () => {
      const session = await register();
      const { recoveryCodes } = await enrol(session.userId);
      const code = recoveryCodes[0]!;
      await auth.logoutAll(session.userId);

      await expect(auth.stepUp({ userId: session.userId, sessionId: session.sessionId, totpCode: code })).rejects.toMatchObject({
        code: 'auth.session_invalid',
      });

      // Re-login would be a new session; here we only assert the hash survived.
      const remaining = await db.sql<Array<{ recovery_code_hashes: unknown }>>`
        SELECT recovery_code_hashes FROM users WHERE id = ${session.userId}
      `;
      expect(normalizeStringList(remaining[0]!.recovery_code_hashes)).toHaveLength(recoveryCodes.length);
    });

    // W9-L09: #1382 shipped passkey step-up; router tests only stub AuthService.
    // Soft-auth E2E pins the real path (challenge kind `step-up`, counter advance,
    // trade:withdraw) so a login assertion cannot be replayed into withdraw.
    const enrolPasskey = async (userId: string) => {
      const authenticator = softAuthenticator();
      const options = await auth.startWebauthnRegistration(userId, PASSWORD_SESSION);
      await auth.confirmWebauthnRegistration(userId, PASSWORD_SESSION, authenticator.registrationResponse(options.challenge));
      return authenticator;
    };

    it('a passkey-only account buys trade:withdraw via step-up (soft auth E2E)', async () => {
      const session = await register();
      // No TOTP — passkey is the only second factor (#1382 passkey-only path).
      const authenticator = await enrolPasskey(session.userId);

      const options = await auth.startWebauthnStepUp(session.userId);
      expect(options.challenge).toBeTruthy();
      expect(options.allowCredentials).toHaveLength(1);

      const elevated = await auth.stepUp({
        userId: session.userId,
        sessionId: session.sessionId,
        webauthn: authenticator.assertionResponse(options.challenge),
      });
      const principal = await verifyAccessToken(elevated.accessToken, tokenConfig);
      expect(hasScope(principal.scopes, 'trade:withdraw')).toBe(true);
      expect(principal.mfa).toBe(true);
      const lifetimeSeconds = (elevated.expiresAt.getTime() - Date.now()) / 1000;
      expect(lifetimeSeconds).toBeLessThanOrEqual(300);
      expect(lifetimeSeconds).toBeGreaterThan(240);

      // Counter advanced (cloned-authenticator detection path is live).
      const stored = await db.sql<Array<{ webauthn_creds: Array<{ counter: number }> }>>`
        SELECT webauthn_creds FROM users WHERE id = ${session.userId}
      `;
      expect(stored[0]!.webauthn_creds[0]!.counter).toBeGreaterThan(0);

      // Step-up challenge is single-use.
      await expect(
        auth.stepUp({
          userId: session.userId,
          sessionId: session.sessionId,
          webauthn: authenticator.assertionResponse(options.challenge),
        }),
      ).rejects.toMatchObject({ code: 'auth.webauthn_invalid' });
    });

    it('refuses a login assertion for withdraw step-up (kind isolation)', async () => {
      const session = await register();
      const handle = (await db.sql<Array<{ handle: string }>>`SELECT handle FROM users WHERE id = ${session.userId}`)[0]!.handle;
      const authenticator = await enrolPasskey(session.userId);

      // Login ceremony challenge must not elevate withdraw.
      const loginOptions = await auth.startWebauthnAuthentication(handle);
      await expect(
        auth.stepUp({
          userId: session.userId,
          sessionId: session.sessionId,
          webauthn: authenticator.assertionResponse(loginOptions.challenge),
        }),
      ).rejects.toMatchObject({ code: 'auth.webauthn_invalid' });

      // Symmetric: step-up challenge must not mint a login session.
      // Login path uses auth.invalid_credentials on purpose (same code as a
      // wrong password — no ceremony-kind oracle for account enumeration).
      const stepOptions = await auth.startWebauthnStepUp(session.userId);
      await expect(
        auth.confirmWebauthnAuthentication(handle, authenticator.assertionResponse(stepOptions.challenge)),
      ).rejects.toMatchObject({ code: 'auth.invalid_credentials' });
    });

    it('refuses passkey step-up when no security key is enrolled', async () => {
      const session = await register();
      await expect(auth.startWebauthnStepUp(session.userId)).rejects.toMatchObject({
        code: 'auth.webauthn_not_enrolled',
      });
      const authenticator = softAuthenticator();
      await expect(
        auth.stepUp({
          userId: session.userId,
          sessionId: session.sessionId,
          webauthn: authenticator.assertionResponse('no-ceremony'),
        }),
      ).rejects.toMatchObject({ code: 'auth.webauthn_not_enrolled' });
    });

    it('refuses passkey step-up on a frozen account and a dead session', async () => {
      const session = await register();
      const authenticator = await enrolPasskey(session.userId);

      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${session.userId}`;
      await expect(auth.startWebauthnStepUp(session.userId)).rejects.toMatchObject({
        code: 'auth.account_frozen',
      });
      await db.sql`UPDATE users SET status = 'active' WHERE id = ${session.userId}`;

      const options = await auth.startWebauthnStepUp(session.userId);
      await auth.logoutAll(session.userId);
      await expect(
        auth.stepUp({
          userId: session.userId,
          sessionId: session.sessionId,
          webauthn: authenticator.assertionResponse(options.challenge),
        }),
      ).rejects.toMatchObject({ code: 'auth.session_invalid' });
    });
  });

  describe('rank engine', () => {
    it('accumulates XP and promotes across tiers', async () => {
      const session = await register(); // starts at 50

      await rank.awardXp({
        userId: session.userId,
        sourceModule: 'academy',
        action: 'academy.certification.earned',
        xpDelta: 500,
        idempotencyKey: `cert:${session.userId}:1`,
      });

      const snapshot = await rank.get(session.userId);
      expect(snapshot.xp).toBe(550n);
      expect(snapshot.rank).toBe(1);
      expect(snapshot.title).toBe('Operator');
    });

    it('emits rankUpdated only when the rank actually changes', async () => {
      const session = await register();
      bus.reset();

      await rank.awardXp({
        userId: session.userId,
        sourceModule: 'trade',
        action: 'trade.order.filled',
        xpDelta: 5,
        idempotencyKey: `fill:${session.userId}:1`,
      });
      expect(bus.emitted('rankUpdated')).toHaveLength(0);

      await rank.awardXp({
        userId: session.userId,
        sourceModule: 'academy',
        action: 'academy.certification.earned',
        xpDelta: 500,
        idempotencyKey: `cert:${session.userId}:2`,
      });
      expect(bus.emitted('rankUpdated')).toHaveLength(1);
    });

    it('is idempotent under a replayed event', async () => {
      const session = await register();
      const award = {
        userId: session.userId,
        sourceModule: 'p2p',
        action: 'p2p.trade.completed',
        xpDelta: 25,
        idempotencyKey: `p2p:${session.userId}:trade-1`,
      };

      const first = await rank.awardXp(award);
      const replay = await rank.awardXp(award);

      expect(first.applied).toBe(true);
      expect(replay.applied).toBe(false);
      expect((await rank.get(session.userId)).xp).toBe(75n);
    });

    it('survives concurrent awards without losing any', async () => {
      const session = await register();

      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          rank.awardXp({
            userId: session.userId,
            sourceModule: 'trade',
            action: 'trade.order.filled',
            xpDelta: 5,
            idempotencyKey: `conc:${session.userId}:${i}`,
          }),
        ),
      );

      expect((await rank.get(session.userId)).xp).toBe(150n); // 50 + 20×5
    });

    it('demotes honestly on a correction — a rank you cannot lose is not a rank', async () => {
      const session = await register();
      await rank.awardXp({
        userId: session.userId,
        sourceModule: 'academy',
        action: 'academy.certification.earned',
        xpDelta: 500,
        idempotencyKey: `demote:${session.userId}:up`,
      });
      expect((await rank.get(session.userId)).rank).toBe(1);

      await rank.awardXp({
        userId: session.userId,
        sourceModule: 'academy',
        action: 'academy.certification.revoked',
        xpDelta: -500,
        idempotencyKey: `demote:${session.userId}:down`,
      });
      expect((await rank.get(session.userId)).rank).toBe(0);
    });

    it('floors XP at zero', async () => {
      const session = await register();
      await rank.awardXp({
        userId: session.userId,
        sourceModule: 'ops',
        action: 'correction',
        xpDelta: -10_000,
        idempotencyKey: `floor:${session.userId}`,
      });
      expect((await rank.get(session.userId)).xp).toBe(0n);
    });

    it('resets season XP without touching lifetime XP or rank', async () => {
      const session = await register();
      await rank.awardXp({
        userId: session.userId,
        sourceModule: 'academy',
        action: 'academy.certification.earned',
        xpDelta: 500,
        idempotencyKey: `season:${session.userId}`,
      });

      await rank.resetSeason();

      const snapshot = await rank.get(session.userId);
      expect(snapshot.seasonXp).toBe(0n);
      expect(snapshot.xp).toBe(550n);
      expect(snapshot.rank).toBe(1);
    });
  });

  // ── §4.4 PHASE 1 EXIT CRITERIA ────────────────────────────────────────────

  describe('§4.4 exit criteria', () => {
    it('full auth lifecycle: register → TOTP → refresh → scoped API key call', async () => {
      const handle = unique();

      // 1 · register
      const registered = await auth.register({
        handle,
        email: `${handle}@example.com`,
        password: 'correct horse battery staple',
        region: 'DE',
      });

      // 2 · enrol TOTP
      const { secret } = await auth.startTotpEnrolment(registered.userId, PASSWORD_SESSION);
      await auth.confirmTotpEnrolment(registered.userId, PASSWORD_SESSION, secret, totp(secret));

      // 3 · log in with the second factor (next step — confirm burned current)
      const loggedIn = await auth.login({
        identifier: handle,
        password: 'correct horse battery staple',
        totpCode: totpNext(secret),
      });
      expect((await verifyAccessToken(loggedIn.accessToken, tokenConfig)).mfa).toBe(true);

      // 4 · refresh the session
      const refreshed = await auth.refresh(loggedIn.refreshToken);
      const principal = await verifyAccessToken(refreshed.accessToken, tokenConfig);
      expect(principal.userId).toBe(registered.userId);

      // 5 · scoped API key call
      const { key } = await auth.createApiKey({
        userId: registered.userId,
        name: 'trading-bot',
        scopes: ['trade:read', 'trade:write'],
        grantorScopes: SESSION_SCOPES,
      });
      const verified = await auth.verifyApiKey(key);

      expect(verified?.userId).toBe(registered.userId);
      expect(hasScope(verified!.scopes, 'trade:write')).toBe(true);
      // The key cannot do what the session can.
      expect(hasScope(verified!.scopes, 'trade:withdraw')).toBe(false);
    });

    it('XP event → rank recalc → perks visible to a second service', async () => {
      const session = await register();

      // A DIFFERENT module awards XP — svc-academy, which knows nothing about ranks.
      await rank.awardXp({
        userId: session.userId,
        sourceModule: 'academy',
        action: 'academy.certification.earned',
        xpDelta: 4_000,
        idempotencyKey: `exit-criteria:${session.userId}`,
      });

      // svc-identity recalculated. It is the only writer to rank_state.
      const snapshot = await rank.get(session.userId);
      expect(snapshot.rank).toBe(3);
      expect(snapshot.title).toBe('Dealer');

      // A THIRD service reads the perk table and acts on it, knowing nothing
      // about the Academy — this is the whole point of one XP graph.
      const perks = await rank.perks(session.userId);
      expect(perks.feeDiscountBps).toBe(100); // svc-trade applies this
      expect(perks.p2pLimitMultiplier).toBe(2); // svc-p2p applies this
      expect(perks.cardTier).toBe('standard'); // svc-bank applies this

      // And the rank change was announced so caches invalidate.
      expect(bus.emitted('rankUpdated').some((e) => e.payload.userId === session.userId)).toBe(true);
    });

    it('a verified user passes the jurisdiction matrix that an unverified one fails', async () => {
      const session = await register();

      // KYC-only fixture: no sanctions authority is supplied or claimed.
      // Ties identity to §22: the tier this service issues is what the matrix reads.
      expect(
        checkAccess({
          screeningFailClosed: false,
          module: 'bank',
          region: 'DE',
          plane: 'fiat',
          kycTier: await auth.kycTier(session.userId),
        }).allowed,
      ).toBe(false);

      await grantKyc(session.userId, 'full');

      expect(
        checkAccess({
          screeningFailClosed: false,
          module: 'bank',
          region: 'DE',
          plane: 'fiat',
          kycTier: await auth.kycTier(session.userId),
        }).allowed,
      ).toBe(true);
    });
  });
}

/** JSONB may arrive as array or JSON text depending on driver path. */
function normalizeStringList(raw: unknown): string[] {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === 'string');
}
