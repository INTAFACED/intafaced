/**
 * auth.stepUpPay against Postgres.
 *
 * A fresh authenticator code mints a ten-minute pay:refund token. A proof
 * older than five minutes does not. Refresh does not carry the scope forward.
 * A key receives pay:refund only when create is told this was a step-up.
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
  describe.skip('pay step-up (Postgres unavailable)', () => {
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

  describe('auth.stepUpPay', () => {
    it('mints a ten-minute refund token from a fresh authenticator code and does not refresh it', async () => {
      const session = await register();
      const { secret } = await enrolTotp(session.userId);
      allow(session.userId);
      const minted = await auth.stepUpPay({
        userId: session.userId,
        sessionId: session.sessionId,
        merchantId: MERCHANT,
        scopes: ['pay:refund'],
        factorProof: { totpCode: totpNext(secret) },
      });
      expect(minted.refreshable).toBe(false);
      const payload = JSON.parse(Buffer.from(minted.accessToken.split('.')[1]!, 'base64url').toString()) as {
        exp: number;
        iat: number;
        stp: string[];
        scopes: string[];
      };
      expect(payload.exp - payload.iat).toBe(600);
      expect(minted.expiresAt.getTime()).toBe(payload.exp * 1000);
      const principal = await verifyAccessToken(minted.accessToken, tokenConfig);
      expect(principal.scopes).toContain('pay:refund');
      expect(principal.scopes).not.toContain('pay:payout');
      expect(principal.scopes).toContain('identity:read');
      expect(principal.scopes).not.toContain('pay:read');
      expect(principal.stp).toEqual(['pay:refund']);
      expect(principal.mfa).toBe(true);
      // The step-up token names the same sign-in and device as the session it was minted from.
      const signedIn = await verifyAccessToken(session.accessToken, tokenConfig);
      expect(principal.fam).toBeDefined();
      expect(principal.fam).toBe(signedIn.fam);
      expect(principal.dev).toBe(signedIn.dev);
      const audit = await db.sql<Array<{ scopes: string[]; factor: string }>>`
        SELECT scopes, factor FROM pay_step_up_mints WHERE user_id = ${session.userId}
      `;
      expect(audit).toEqual([{ scopes: ['pay:refund'], factor: 'totp' }]);

      const refreshed = await auth.refresh(session.refreshToken);
      const again = await verifyAccessToken(refreshed.accessToken, tokenConfig);
      expect(again.scopes).not.toContain('pay:refund');
      expect(again.scopes).not.toContain('pay:payout');
      expect(again.stp).toBeUndefined();
    });

    it('refuses a factor proof older than five minutes and writes no mint', async () => {
      const session = await register();
      allow(session.userId);
      const proofId = randomUUID();
      await db.sql`
        INSERT INTO pay_step_up_proofs (proof_id, user_id, session_id, method, verified_at, expires_at)
        VALUES (
          ${proofId},
          ${session.userId},
          ${session.sessionId},
          'totp',
          ${new Date(Date.now() - 6 * 60 * 1000)},
          ${new Date(Date.now() - 60 * 1000)}
        )
      `;
      await expect(
        auth.stepUpPay({
          userId: session.userId,
          sessionId: session.sessionId,
          merchantId: MERCHANT,
          scopes: ['pay:refund'],
          factorProof: { proofId },
        }),
      ).rejects.toMatchObject({ code: 'auth.step_up_expired' });
      const audit = await db.sql<Array<{ audit_id: string }>>`
        SELECT audit_id FROM pay_step_up_mints WHERE user_id = ${session.userId}
      `;
      expect(audit).toEqual([]);
    });

    it('refuses a teammate who does not hold refunds.create and writes no mint', async () => {
      const session = await register();
      const { secret } = await enrolTotp(session.userId);
      grants.set(`${session.userId}:${MERCHANT}`, { refundsCreate: false, payoutSend: true });
      await expect(
        auth.stepUpPay({
          userId: session.userId,
          sessionId: session.sessionId,
          merchantId: MERCHANT,
          scopes: ['pay:refund'],
          factorProof: { totpCode: totpNext(secret) },
        }),
      ).rejects.toMatchObject({ code: 'pay.role_not_allowed' });
      const audit = await db.sql<Array<{ audit_id: string }>>`
        SELECT audit_id FROM pay_step_up_mints WHERE user_id = ${session.userId}
      `;
      expect(audit).toEqual([]);
    });

    it('stores pay:refund on a key only when create is under the step-up token, and the key shows the scope', async () => {
      const session = await register();
      const { secret } = await enrolTotp(session.userId);
      allow(session.userId);
      const minted = await auth.stepUpPay({
        userId: session.userId,
        sessionId: session.sessionId,
        merchantId: MERCHANT,
        scopes: ['pay:refund'],
        factorProof: { totpCode: totpNext(secret) },
      });
      const principal = await verifyAccessToken(minted.accessToken, tokenConfig);
      await expect(
        auth.createApiKey({
          userId: session.userId,
          name: 'plain',
          scopes: ['pay:refund'],
          grantorScopes: principal.scopes,
        }),
      ).rejects.toThrow(/step-up/);
      const key = await auth.createApiKey({
        userId: session.userId,
        name: 'refund-bot',
        scopes: ['pay:refund'],
        grantorScopes: principal.scopes,
        payStepUp: true,
      });
      expect(key.scopes).toEqual(['pay:refund']);
      const stored = await db.sql<Array<{ scopes: string[] }>>`
        SELECT scopes FROM api_keys WHERE id = ${key.id}
      `;
      expect(stored[0]?.scopes).toEqual(['pay:refund']);
      const exchanged = await auth.exchangeApiKey(key.key);
      expect(exchanged.scopes).toEqual(['pay:refund']);
    });

    it('refuses a passkey assertion signed over a challenge the server never issued and writes no mint', async () => {
      const session = await register();
      const authenticator = await enrolPasskey(session.userId);
      allow(session.userId);
      const neverIssued = generateChallenge();
      const assertion = authenticator.assertionResponse(neverIssued);
      await expect(
        auth.stepUpPay({
          userId: session.userId,
          sessionId: session.sessionId,
          merchantId: MERCHANT,
          scopes: ['pay:payout'],
          factorProof: replayProof(assertion, neverIssued),
        }),
      ).rejects.toMatchObject({ code: 'auth.webauthn_invalid' });
      const audit = await db.sql<Array<{ audit_id: string }>>`
        SELECT audit_id FROM pay_step_up_mints WHERE user_id = ${session.userId}
      `;
      expect(audit).toEqual([]);
    });

    it('mints once from a startWebauthnStepUp challenge and refuses the same assertion a second time', async () => {
      const session = await register();
      const authenticator = await enrolPasskey(session.userId);
      allow(session.userId);
      const options = await auth.startWebauthnStepUp(session.userId);
      const assertion = authenticator.assertionResponse(options.challenge);
      const factorProof = replayProof(assertion, options.challenge);
      const minted = await auth.stepUpPay({
        userId: session.userId,
        sessionId: session.sessionId,
        merchantId: MERCHANT,
        scopes: ['pay:refund'],
        factorProof,
      });
      expect(minted.scopes).toContain('pay:refund');
      const first = await db.sql<Array<{ factor: string }>>`
        SELECT factor FROM pay_step_up_mints WHERE user_id = ${session.userId}
      `;
      expect(first).toEqual([{ factor: 'passkey' }]);
      await expect(
        auth.stepUpPay({
          userId: session.userId,
          sessionId: session.sessionId,
          merchantId: MERCHANT,
          scopes: ['pay:refund'],
          factorProof,
        }),
      ).rejects.toMatchObject({ code: 'auth.webauthn_invalid' });
      const second = await db.sql<Array<{ factor: string }>>`
        SELECT factor FROM pay_step_up_mints WHERE user_id = ${session.userId}
      `;
      expect(second).toEqual([{ factor: 'passkey' }]);
    });
  });
}
