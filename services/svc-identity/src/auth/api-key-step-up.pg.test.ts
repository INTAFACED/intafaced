/**
 * API-key actions that mint, loosen, rotate or reveal need a fresh second
 * factor (a code or proof from the last five minutes). Revoke never does.
 * Runs against Postgres.
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyAccessToken } from '@intafaced/auth';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { AuthService } from './auth-service.js';
import { issueAccessToken } from '@intafaced/auth';
import { mergeRouters } from '@intafaced/contracts';
import { createIdentityRouter } from '../router.js';
import { createApiKeyIpRouter } from '../api-key-ip-router.js';
import { createApiKeyRotateRouter } from '../api-key-rotate-router.js';
import { createApiKeyRequestSignRouter } from '../api-key-request-sign-router.js';
import { createApiKeyAttributionRouter } from '../api-key-attribution-router.js';
import { encodeCbor } from './cbor.js';
import { totp } from './totp.js';
import {
  b64urlEncode,
  buildAuthenticatorData,
  buildClientDataJSON,
  coseKeyFromJwk,
  generateChallenge,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from './webauthn.js';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '').split('/')[0] ?? '';
  if (name.length > 0 && !name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const DATABASE_URL = testDatabaseUrl();
const PASSWORD_SESSION = { mfa: false, privileged: false } as const;
const MERCHANT = '55555555-5555-4555-8555-555555555555';

const tokenConfig = {
  secret: 'an-identity-pay-step-up-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

function totpNext(secret: string): string {
  const step = 30;
  const counter = Math.floor(Math.floor(Date.now() / 1000) / step);
  return totp(secret, { at: new Date((counter + 1) * step * 1000) });
}

const webauthnConfig = {
  rpID: 'localhost',
  rpName: 'INTAFACED',
  origin: 'http://localhost:3000',
};

/**
 * A synced passkey. The signature counter stays 0, so the same assertion
 * verifies again unless the server consumes the challenge it issued.
 */
function syncedPasskey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const cose = coseKeyFromJwk(jwk);
  const credId = randomBytes(16);
  const sign = (authData: Buffer, clientDataJSON: Buffer, key: KeyObject = privateKey) => {
    const clientDataHash = createHash('sha256').update(clientDataJSON).digest();
    return cryptoSign('SHA256', Buffer.concat([authData, clientDataHash]), { key, dsaEncoding: 'der' });
  };
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
    assertionResponse(challenge: string): AuthenticationResponseJSON {
      const clientDataJSON = buildClientDataJSON({ type: 'webauthn.get', challenge, origin: webauthnConfig.origin });
      const authData = buildAuthenticatorData({ rpID: webauthnConfig.rpID, counter: 0 });
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

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const available = await postgresAvailable(DATABASE_URL);

if (!available) {
  describe.skip('api key step-up (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: DATABASE_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, undefined, randomBytes(32).toString('base64'), undefined, undefined, 25);
  await rank.seedTiers();

  let n = 0;
  const unique = () => `ps${process.pid}${++n}`;
  const grants = new Map<string, { refundsCreate: boolean; payoutSend: boolean }>();

  beforeEach(async () => {
    grants.clear();
    await db.truncateAll();
    await rank.seedTiers();
    auth.usePayStepUpRoleSource(async ({ userId, merchantId }) => {
      return grants.get(`${userId}:${merchantId}`) ?? { refundsCreate: false, payoutSend: false };
    });
  });

  afterAll(async () => {
    await db.drop();
  });

  async function register() {
    const handle = unique();
    return auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
  }

  async function enrolTotp(userId: string) {
    const started = await auth.startTotpEnrolment(userId, PASSWORD_SESSION);
    await auth.confirmTotpEnrolment(userId, PASSWORD_SESSION, started.secret, totp(started.secret));
    return started;
  }

  function allow(userId: string, merchantId = MERCHANT) {
    grants.set(`${userId}:${merchantId}`, { refundsCreate: true, payoutSend: true });
  }

  async function enrolPasskey(userId: string) {
    const authenticator = syncedPasskey();
    const options = await auth.startWebauthnRegistration(userId, PASSWORD_SESSION);
    await auth.confirmWebauthnRegistration(userId, PASSWORD_SESSION, authenticator.registrationResponse(options.challenge));
    return authenticator;
  }

  function replayProof(assertion: AuthenticationResponseJSON, challenge: string) {
    return { webauthn: assertion, webauthnChallenge: challenge };
  }

  const appRouter = mergeRouters(
    createIdentityRouter(auth, rank, { registrationOpen: true }),
    createApiKeyIpRouter(db.sql, auth, auth),
    createApiKeyRotateRouter(db.sql, auth, auth),
    createApiKeyRequestSignRouter(db.sql, auth),
    createApiKeyAttributionRouter(auth),
  );

  async function caller(session: { userId: string; sessionId: string; accessToken: string }, extra: { apiKeyId?: string } = {}) {
    const base = await verifyAccessToken(session.accessToken, tokenConfig);
    const principal = extra.apiKeyId
      ? await verifyAccessToken(
          (
            await issueAccessToken(
              {
                userId: session.userId,
                sessionId: session.sessionId,
                scopes: [...base.scopes],
                tier: 'none',
                mfa: false,
                apiKeyId: extra.apiKeyId,
              },
              tokenConfig,
            )
          ).token,
          tokenConfig,
        )
      : base;
    return appRouter.createCaller({ principal, service: null, region: 'DE', requestId: 'r' });
  }

  async function freshProof(session: { userId: string; sessionId: string }, ageMs = 0) {
    const proofId = randomUUID();
    const verifiedAt = new Date(Date.now() - ageMs);
    await db.sql`
      INSERT INTO pay_step_up_proofs (proof_id, user_id, session_id, method, verified_at, expires_at)
      VALUES (${proofId}, ${session.userId}, ${session.sessionId}, 'totp', ${verifiedAt}, ${new Date(verifiedAt.getTime() + 5 * 60 * 1000)})
    `;
    return { proofId };
  }

  const keyCount = async (userId: string) =>
    (await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM api_keys WHERE user_id = ${userId}`)[0]!.n;

  describe('API-key actions need a fresh second factor', () => {
    it('refuses create without a factor and mints nothing', async () => {
      const session = await register();
      await enrolTotp(session.userId);
      const c = await caller(session);
      await expect(c.apiKeys.create({ name: 'bot', scopes: ['trade:read'] })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: expect.stringContaining('[auth.step_up_required]'),
      });
      expect(await keyCount(session.userId)).toBe('0');
    });

    it('creates with a fresh authenticator code and audits the action', async () => {
      const session = await register();
      const { secret } = await enrolTotp(session.userId);
      const c = await caller(session);
      const created = await c.apiKeys.create({ name: 'bot', scopes: ['trade:read'], factorProof: { totpCode: totpNext(secret) } });
      expect(created.key).toBeTruthy();
      expect(await keyCount(session.userId)).toBe('1');
      const audit = await db.sql<Array<{ action: string; factor: string; scopes: string[] }>>`
        SELECT action, factor, scopes FROM api_key_action_audit WHERE user_id = ${session.userId}
      `;
      expect(audit).toEqual([{ action: 'create', factor: 'totp', scopes: ['trade:read'] }]);
    });

    it('refuses a proof older than five minutes and mints nothing', async () => {
      const session = await register();
      await enrolTotp(session.userId);
      const c = await caller(session);
      const stale = await freshProof(session, 6 * 60 * 1000);
      await expect(c.apiKeys.create({ name: 'bot', scopes: ['trade:read'], factorProof: stale })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: expect.stringContaining('[auth.step_up_expired]'),
      });
      expect(await keyCount(session.userId)).toBe('0');
    });

    it('widening an allowlist needs a factor; narrowing and revoke do not', async () => {
      const session = await register();
      await enrolTotp(session.userId);
      const c = await caller(session);
      const created = await c.apiKeys.create({ name: 'bot', scopes: ['trade:read'], factorProof: await freshProof(session) });
      // unrestricted -> one address is a narrowing
      await c.bindApiKeyIpAllowlist({ keyId: created.id, ips: ['203.0.113.1'] });
      await expect(c.bindApiKeyIpAllowlist({ keyId: created.id, ips: ['203.0.113.1', '203.0.113.2'] })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
      await expect(c.bindApiKeyIpAllowlist({ keyId: created.id, ips: [] })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      await expect(c.unbindApiKeyIpAllowlist({ keyId: created.id, ip: '203.0.113.1' })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
      const still = await db.sql<Array<{ ip_allowlist: string[] }>>`SELECT ip_allowlist FROM api_keys WHERE id = ${created.id}`;
      expect(still[0]!.ip_allowlist).toEqual(['203.0.113.1']);
      const widened = await c.bindApiKeyIpAllowlist({
        keyId: created.id,
        ips: ['203.0.113.1', '203.0.113.2'],
        factorProof: await freshProof(session),
      });
      expect(widened.ipAllowlist).toHaveLength(2);
      // dropping one of two stays a narrowing
      const narrowed = await c.unbindApiKeyIpAllowlist({ keyId: created.id, ip: '203.0.113.2' });
      expect(narrowed.ipAllowlist).toEqual(['203.0.113.1']);
      // revoking never needs a factor
      await expect(c.apiKeys.revoke({ keyId: created.id })).resolves.toEqual({ revoked: true });
    });

    it('refuses the other mint, rotate and secret doors without a factor', async () => {
      const session = await register();
      await enrolTotp(session.userId);
      const c = await caller(session);
      const created = await c.apiKeys.create({ name: 'bot', scopes: ['trade:read'], factorProof: await freshProof(session) });
      const refused = { code: 'PRECONDITION_FAILED' };
      await expect(c.attribution.mint({ name: 'a', scopes: ['trade:read'] })).rejects.toMatchObject(refused);
      await expect(c.mintApiKeyWithIpAllowlist({ name: 'b', scopes: ['trade:read'], ips: ['203.0.113.1'] })).rejects.toMatchObject(refused);
      await expect(c.rotateApiKey({ keyId: created.id })).rejects.toMatchObject(refused);
      await expect(c.rotateSigningSecret({ keyId: created.id })).rejects.toMatchObject(refused);
      await expect(
        c.setApiKeyRequestSigning({ keyId: created.id, requireSignature: true, requireNonEmptyIpAllowlist: false }),
      ).rejects.toMatchObject(refused);
      expect(await keyCount(session.userId)).toBe('1');
    });

    it('never lets an API-key caller create a key, even with a valid proof', async () => {
      const session = await register();
      await enrolTotp(session.userId);
      const owner = await caller(session);
      const created = await owner.apiKeys.create({ name: 'bot', scopes: ['trade:read'], factorProof: await freshProof(session) });
      const asKey = await caller(session, { apiKeyId: created.id });
      await expect(
        asKey.apiKeys.create({ name: 'child', scopes: ['trade:read'], factorProof: await freshProof(session) }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await keyCount(session.userId)).toBe('1');
    });
  });
}
