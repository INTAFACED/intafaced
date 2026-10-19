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
import { createApiKeyOriginRouter } from '../api-key-origin-router.js';
import { createApiKeyProductRouter } from '../api-key-product-router.js';
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

  const signingKey = randomBytes(32);
  const appRouter = mergeRouters(
    createApiKeyOriginRouter(db.sql, auth, auth),
    createApiKeyProductRouter(db.sql, auth, auth),
    createIdentityRouter(auth, rank, { registrationOpen: true }),
    createApiKeyIpRouter(db.sql, auth, auth),
    createApiKeyRotateRouter(db.sql, auth, auth),
    createApiKeyRequestSignRouter(db.sql, auth, signingKey),
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

  /** A proof row. `action` null is a pay-style proof (not bound to any key action). */
  async function freshProof(
    session: { userId: string; sessionId: string },
    action: string | null = 'create',
    opts: { ageMs?: number; keyId?: string | null; userId?: string } = {},
  ) {
    const proofId = randomUUID();
    const verifiedAt = new Date(Date.now() - (opts.ageMs ?? 0));
    await db.sql`
      INSERT INTO pay_step_up_proofs (proof_id, user_id, session_id, method, verified_at, expires_at, bound_action, bound_key_id)
      VALUES (${proofId}, ${opts.userId ?? session.userId}, ${session.sessionId}, 'totp', ${verifiedAt}, ${new Date(verifiedAt.getTime() + 5 * 60 * 1000)}, ${action}, ${opts.keyId ?? null})
    `;
    return { proofId };
  }
  const auditCount = async (userId: string) =>
    (await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM api_key_action_audit WHERE user_id = ${userId}`)[0]!.n;

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
      const stale = await freshProof(session, 'create', { ageMs: 6 * 60 * 1000 });
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
        factorProof: await freshProof(session, 'ip_allowlist_widen', { keyId: created.id }),
      });
      expect(widened.ipAllowlist).toHaveLength(2);
      // dropping one of two stays a narrowing
      const narrowed = await c.unbindApiKeyIpAllowlist({ keyId: created.id, ip: '203.0.113.2' });
      expect(narrowed.ipAllowlist).toEqual(['203.0.113.1']);
      // revoking never needs a factor
      await expect(c.apiKeys.revoke({ keyId: created.id })).resolves.toEqual({ revoked: true });
    });

    it('concurrent narrowing requests cannot add up to an open allowlist without a factor', async () => {
      const session = await register();
      await enrolTotp(session.userId);
      const c = await caller(session);
      const rounds = 25;
      for (let i = 0; i < rounds; i++) {
        const created = await c.apiKeys.create({ name: `bot-${i}`, scopes: ['trade:read'], factorProof: await freshProof(session) });
        await c.bindApiKeyIpAllowlist({ keyId: created.id, ips: ['203.0.113.1'] });
        await c.bindApiKeyIpAllowlist({
          keyId: created.id,
          ips: ['203.0.113.1', '203.0.113.2'],
          factorProof: await freshProof(session, 'ip_allowlist_widen', { keyId: created.id }),
        });
        const auditBefore = await auditCount(session.userId);
        const results = await Promise.allSettled([
          c.unbindApiKeyIpAllowlist({ keyId: created.id, ip: '203.0.113.1' }),
          c.unbindApiKeyIpAllowlist({ keyId: created.id, ip: '203.0.113.2' }),
        ]);
        const rows = await db.sql<Array<{ ip_allowlist: string[] }>>`SELECT ip_allowlist FROM api_keys WHERE id = ${created.id}`;
        // One request narrows; the other would empty the list, which needs a factor and is refused.
        expect(rows[0]!.ip_allowlist).toHaveLength(1);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
        expect(await auditCount(session.userId)).toBe(auditBefore);
      }
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

    it('a proof is single-use: the second create with the same proof is refused and mints nothing', async () => {
      const session = await register();
      await enrolTotp(session.userId);
      const c = await caller(session);
      const proof = await freshProof(session, 'create');
      await c.apiKeys.create({ name: 'one', scopes: ['trade:read'], factorProof: proof });
      await expect(c.apiKeys.create({ name: 'two', scopes: ['trade:read'], factorProof: proof })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: expect.stringContaining('[auth.step_up_required]'),
      });
      expect(await keyCount(session.userId)).toBe('1');
      expect(await auditCount(session.userId)).toBe('1');
    });

    it('a proof cannot be used by another user', async () => {
      const owner = await register();
      const other = await register();
      await enrolTotp(owner.userId);
      await enrolTotp(other.userId);
      const proof = await freshProof(owner, 'create');
      const c = await caller(other);
      await expect(c.apiKeys.create({ name: 'x', scopes: ['trade:read'], factorProof: proof })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
      // the same proof, under the wrong session of the right user
      const wrongSession = await freshProof({ userId: other.userId, sessionId: owner.sessionId }, 'create', { userId: other.userId });
      await expect(c.apiKeys.create({ name: 'x', scopes: ['trade:read'], factorProof: wrongSession })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
      expect(await keyCount(other.userId)).toBe('0');
    });

    it('a proof for one action or key does not authorise another, and pay proofs are not accepted at all', async () => {
      const session = await register();
      await enrolTotp(session.userId);
      const c = await caller(session);
      const first = await c.apiKeys.create({ name: 'a', scopes: ['trade:read'], factorProof: await freshProof(session, 'create') });
      const second = await c.apiKeys.create({ name: 'b', scopes: ['trade:read'], factorProof: await freshProof(session, 'create') });
      const refused = { code: 'PRECONDITION_FAILED' };
      // a create proof cannot rotate or reveal
      await expect(c.rotateApiKey({ keyId: first.id, factorProof: await freshProof(session, 'create') })).rejects.toMatchObject(refused);
      await expect(c.rotateSigningSecret({ keyId: first.id, factorProof: await freshProof(session, 'create') })).rejects.toMatchObject(
        refused,
      );
      // a proof bound to key A cannot widen key B
      await c.bindApiKeyIpAllowlist({ keyId: second.id, ips: ['203.0.113.1'] });
      const forFirst = await freshProof(session, 'ip_allowlist_widen', { keyId: first.id });
      await expect(
        c.bindApiKeyIpAllowlist({ keyId: second.id, ips: ['203.0.113.1', '203.0.113.2'], factorProof: forFirst }),
      ).rejects.toMatchObject(refused);
      // a pay-style proof (not bound to any action) opens none of these doors
      const payProof = await freshProof(session, null);
      await expect(c.apiKeys.create({ name: 'c', scopes: ['trade:read'], factorProof: payProof })).rejects.toMatchObject(refused);
      expect(await keyCount(session.userId)).toBe('2');
      // and an API-key-action proof is not a pay proof
      const keyProof = await freshProof(session, 'create');
      await expect(
        auth.stepUpPay({
          userId: session.userId,
          sessionId: session.sessionId,
          merchantId: MERCHANT,
          scopes: ['pay:refund'],
          factorProof: keyProof,
        }),
      ).rejects.toMatchObject({ code: 'auth.step_up_required' });
    });

    it('is atomic: a failed action leaves no audit row and does not spend the proof', async () => {
      const session = await register();
      await enrolTotp(session.userId);
      const c = await caller(session);
      const proof = await freshProof(session, 'create');
      // a scope the session does not hold is refused after the factor is checked
      await expect(c.apiKeys.create({ name: 'bad', scopes: ['admin:compliance'], factorProof: proof })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(await auditCount(session.userId)).toBe('0');
      expect(await keyCount(session.userId)).toBe('0');
      // the same proof still works for a valid create, and exactly one audit row results
      await c.apiKeys.create({ name: 'good', scopes: ['trade:read'], factorProof: proof });
      expect(await auditCount(session.userId)).toBe('1');
      expect(await keyCount(session.userId)).toBe('1');
    });

    it('one authenticator code audits exactly one action and leaves no reusable proof behind', async () => {
      const session = await register();
      const { secret } = await enrolTotp(session.userId);
      const c = await caller(session);
      await c.apiKeys.create({ name: 'bot', scopes: ['trade:read'], factorProof: { totpCode: totpNext(secret) } });
      expect(await auditCount(session.userId)).toBe('1');
      const left = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay_step_up_proofs WHERE user_id = ${session.userId}`;
      expect(left[0]!.n).toBe('0');
    });

    it('SUCCESS PATHS: every guarded door works with a valid factor, in one transaction with its audit row', async () => {
      const session = await register();
      await enrolPasskey(session.userId);
      const c = await caller(session);
      const proof = (action: string, keyId?: string) => freshProof(session, action, { keyId: keyId ?? null });
      let audits = 0;
      const audited = async () => {
        audits += 1;
        expect(await auditCount(session.userId)).toBe(String(audits));
      };

      // create
      const key = await c.apiKeys.create({ name: 'bot', scopes: ['trade:read'], factorProof: await proof('create') });
      await audited();
      // mint doors
      const viaIp = await c.mintApiKeyWithIpAllowlist({
        name: 'ip',
        scopes: ['trade:read'],
        ips: ['203.0.113.9'],
        factorProof: await proof('create'),
      });
      expect(viaIp.ipAllowlist).toEqual(['203.0.113.9']);
      await audited();
      const attributed = await c.attribution.mint({ name: 'attr', scopes: ['trade:read'], factorProof: await proof('create') });
      expect(attributed.id).toBeTruthy();
      await audited();

      // widen ip
      await c.bindApiKeyIpAllowlist({ keyId: key.id, ips: ['203.0.113.1'] });
      const ip = await c.bindApiKeyIpAllowlist({
        keyId: key.id,
        ips: ['203.0.113.1', '203.0.113.2'],
        factorProof: await proof('ip_allowlist_widen', key.id),
      });
      expect(ip.ipAllowlist).toHaveLength(2);
      await audited();
      // widen origin
      await c.bindApiKeyOriginAllowlist({ keyId: key.id, origins: ['a.example.com'] });
      const origin = await c.bindApiKeyOriginAllowlist({
        keyId: key.id,
        origins: ['a.example.com', 'b.example.com'],
        factorProof: await proof('origin_allowlist_widen', key.id),
      });
      expect(origin.originAllowlist).toHaveLength(2);
      await audited();
      // widen product
      await c.bindApiKeyProductScope({ keyId: key.id, products: ['trade'] });
      const product = await c.bindApiKeyProductScope({
        keyId: key.id,
        products: ['trade', 'identity'],
        factorProof: await proof('product_scope_widen', key.id),
      });
      expect(product.productScopes).toHaveLength(2);
      await audited();

      // enable signing (reveals a secret) and rotate the signing secret
      const signing = await c.setApiKeyRequestSigning({
        keyId: key.id,
        requireSignature: true,
        requireNonEmptyIpAllowlist: false,
        factorProof: await proof('signing_secret', key.id),
      });
      expect(signing.signingSecret).toBeTruthy();
      await audited();
      const rotatedSecret = await c.rotateSigningSecret({ keyId: key.id, factorProof: await proof('signing_secret', key.id) });
      expect(rotatedSecret.signingSecret).toBeTruthy();
      expect(rotatedSecret.signingSecret).not.toBe(signing.signingSecret);
      await audited();

      // rotate the key itself (needs a passkey that has been verified)
      await db.sql`
        UPDATE users SET webauthn_creds = (SELECT jsonb_agg(c || '{"lastVerifiedAt":"2026-01-01T00:00:00.000Z"}'::jsonb) FROM jsonb_array_elements(webauthn_creds) c)
        WHERE id = ${session.userId}
      `;
      const rotated = await c.rotateApiKey({ keyId: viaIp.id, factorProof: await proof('rotate', viaIp.id) });
      expect(rotated.revokedKeyId).toBe(viaIp.id);
      await audited();
    });

    it('a key-bound action needs an exact key match; an unbound proof is only for create', async () => {
      const session = await register();
      await enrolTotp(session.userId);
      const c = await caller(session);
      const a = await c.apiKeys.create({ name: 'a', scopes: ['trade:read'], factorProof: await freshProof(session, 'create') });
      const refused = { code: 'PRECONDITION_FAILED' };
      await expect(
        c.rotateSigningSecret({ keyId: a.id, factorProof: await freshProof(session, 'signing_secret', { keyId: null }) }),
      ).rejects.toMatchObject(refused);
      await expect(
        c.apiKeys.create({ name: 'b', scopes: ['trade:read'], factorProof: await freshProof(session, 'create', { keyId: a.id }) }),
      ).rejects.toMatchObject(refused);
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
