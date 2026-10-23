/**
 * Customer step-up against Postgres.
 *
 * begin records the payment. complete, with a fresh authenticator code or a
 * passkey assertion, mints one stepUpApprovalId. The bank consume spends it
 * once. A refresh token does not.
 */
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken, hasScope } from '@intafaced/auth';
import { bindCustomerStepUp, customerStepUpPayloadHash, type Context } from '@intafaced/contracts';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { ActionApprovalService } from './action-approval-service.js';
import { SqlActionApprovalStore } from './action-approval-store.js';
import { AuthService } from './auth-service.js';
import { CUSTOMER_STEP_UP_BEGIN_MAX, CustomerStepUpService } from './customer-step-up.js';
import { SqlCustomerStepUpStore } from './customer-step-up-store.js';
import { encodeCbor } from './cbor.js';
import { totp } from './totp.js';
import {
  b64urlEncode,
  buildAuthenticatorData,
  buildClientDataJSON,
  coseKeyFromJwk,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from './webauthn.js';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { createStepUpRouter } from '../step-up-router.js';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const PASSWORD_SESSION = { mfa: false, privileged: false } as const;
const SCOPE = 'bank.step_up.transfers.toUser' as const;
const PURPOSE = 'transfers.toUser';

const tokenConfig = {
  secret: 'an-identity-customer-step-up-test-secret-long-enough',
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

function totpNext(secret: string): string {
  const step = 30;
  const counter = Math.floor(Math.floor(Date.now() / 1000) / step);
  return totp(secret, { at: new Date((counter + 1) * step * 1000) });
}

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
      counter += 1;
      const clientDataJSON = buildClientDataJSON({ type: 'webauthn.get', challenge, origin: webauthnConfig.origin });
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

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('customer step-up (Postgres unavailable)', () => {
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
  const totpSecretKeyMaterial = randomBytes(32).toString('base64');
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, webauthnConfig, totpSecretKeyMaterial, undefined, undefined, 25);
  await rank.seedTiers();

  let clockMs = Date.now();
  const clock = () => new Date(clockMs);
  const store = new SqlCustomerStepUpStore(db.sql);
  const approvals = new ActionApprovalService(new SqlActionApprovalStore(db.sql), { ttlSeconds: 60 }, clock, (row, at) =>
    store.auditConsumed({ ...row, at }),
  );
  const stepUps = new CustomerStepUpService(db.sql, store, auth, clock);
  const api = createStepUpRouter(stepUps);

  let n = 0;
  const unique = () => `su${process.pid}${++n}`;

  beforeEach(async () => {
    clockMs = Date.now();
    await db.truncateAll();
    await rank.seedTiers();
  });

  afterAll(async () => {
    await db.drop();
  });

  async function ctxOf(accessToken: string): Promise<Context> {
    return { principal: await verifyAccessToken(accessToken, tokenConfig), service: null, region: 'DE', requestId: 'req-stepup' };
  }

  async function register() {
    const handle = unique();
    return auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
  }

  async function enrolTotp(userId: string) {
    const started = await auth.startTotpEnrolment(userId, PASSWORD_SESSION);
    await auth.confirmTotpEnrolment(userId, PASSWORD_SESSION, started.secret, totp(started.secret));
    return started;
  }

  function sendInput(userId: string, amount = '10.50', target = 'user-2') {
    return {
      scope: SCOPE,
      purpose: PURPOSE,
      amount,
      target,
      fields: {
        transferId: 'transfer-1',
        fromSpaceId: 'space-from',
        toUserId: target,
        assetId: 'USDT',
        amount,
      },
    };
  }

  function consumeOf(approvalId: string, userId: string, sessionId: string, payloadHash: string) {
    return {
      approvalId,
      operationId: approvalId,
      payloadHash,
      targetService: 'svc-bank',
      targetId: SCOPE,
      expectedVersion: '1',
      principalUserId: userId,
      principalSessionId: sessionId,
    };
  }

  describe('stepUp.begin and stepUp.complete', () => {
    it('mints one approval a consumer can spend once, and writes mint and consume audit', async () => {
      const session = await register();
      const { secret } = await enrolTotp(session.userId);
      const caller = api.createCaller(await ctxOf(session.accessToken));
      const input = sendInput(session.userId);
      const begun = await caller.stepUp.begin(input);
      expect(begun.totp).toBe(true);
      expect(begun.webauthn).toBeNull();
      expect(new Date(begun.expiresAt).getTime() - clockMs).toBe(120_000);

      const done = await caller.stepUp.complete({ challengeId: begun.challengeId, totpCode: totpNext(secret) });
      expect(Object.keys(done).sort()).toEqual(['amount', 'expiresAt', 'purpose', 'scope', 'stepUpApprovalId', 'target']);
      expect(done).toMatchObject({ scope: SCOPE, purpose: PURPOSE, amount: '10.50', target: 'user-2' });
      expect(new Date(done.expiresAt).getTime() - clockMs).toBe(300_000);

      const bound = bindCustomerStepUp(session.userId, input);
      expect(bound.ok).toBe(true);
      if (!bound.ok) return;
      const wrongAmount = customerStepUpPayloadHash(SCOPE, {
        actor: session.userId,
        transferId: 'transfer-1',
        fromSpaceId: 'space-from',
        toUserId: 'user-2',
        assetId: 'USDT',
        amount: '11.00',
      });
      await expect(
        approvals.consume('svc-bank', consumeOf(done.stepUpApprovalId, session.userId, session.sessionId, wrongAmount)),
      ).rejects.toMatchObject({
        code: 'action_approval.payload_mismatch',
      });
      await expect(
        approvals.consume(
          'svc-bank',
          consumeOf(done.stepUpApprovalId, session.userId, '22222222-2222-4222-8222-222222222222', bound.payloadHash),
        ),
      ).rejects.toMatchObject({ code: 'action_approval.not_requester' });

      const spent = await approvals.consume(
        'svc-bank',
        consumeOf(done.stepUpApprovalId, session.userId, session.sessionId, bound.payloadHash),
      );
      expect(spent.status).toBe('CONSUMED');
      await expect(
        approvals.consume('svc-bank', consumeOf(done.stepUpApprovalId, session.userId, session.sessionId, bound.payloadHash)),
      ).rejects.toMatchObject({
        code: 'action_approval.consumed',
      });

      const audit = await db.sql<Array<{ event: string; amount: string | null; target: string | null; scope: string }>>`
        SELECT event, amount, target, scope FROM step_up_audit WHERE approval_id = ${done.stepUpApprovalId} ORDER BY created_at, event
      `;
      expect(audit.map((row) => row.event).sort()).toEqual(['consumed', 'minted']);
      expect(audit.every((row) => row.scope === SCOPE && row.amount === '10.50' && row.target === 'user-2')).toBe(true);
    });

    it('refuses a recovery code, an API key, a sub-account, and a caller with no access token', async () => {
      const session = await register();
      const enrolled = await enrolTotp(session.userId);
      const caller = api.createCaller(await ctxOf(session.accessToken));
      const begun = await caller.stepUp.begin(sendInput(session.userId));
      const before = await db.sql<Array<{ recovery_code_hashes: unknown }>>`
        SELECT recovery_code_hashes FROM users WHERE id = ${session.userId}
      `;
      await expect(caller.stepUp.complete({ challengeId: begun.challengeId, totpCode: enrolled.recoveryCodes[0] })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      const after = await db.sql<Array<{ recovery_code_hashes: unknown }>>`
        SELECT recovery_code_hashes FROM users WHERE id = ${session.userId}
      `;
      expect(after[0]?.recovery_code_hashes).toEqual(before[0]?.recovery_code_hashes);

      const keyToken = await issueAccessToken(
        { userId: session.userId, sessionId: session.sessionId, scopes: ['identity:write'], tier: 'none', mfa: true, apiKeyId: 'key-1' },
        tokenConfig,
      );
      const keyCaller = api.createCaller(await ctxOf(keyToken.token));
      await expect(keyCaller.stepUp.begin(sendInput(session.userId))).rejects.toMatchObject({ code: 'FORBIDDEN' });

      const subToken = await issueAccessToken(
        {
          userId: session.userId,
          sessionId: session.sessionId,
          scopes: ['identity:write'],
          tier: 'none',
          mfa: true,
          subAccountId: '33333333-3333-4333-8333-333333333333',
        },
        tokenConfig,
      );
      const subCaller = api.createCaller(await ctxOf(subToken.token));
      await expect(subCaller.stepUp.begin(sendInput(session.userId))).rejects.toMatchObject({ code: 'FORBIDDEN' });

      const anon = api.createCaller({ principal: null, service: null, region: 'DE', requestId: 'anon' });
      await expect(anon.stepUp.begin(sendInput(session.userId))).rejects.toThrow(/Authentication required/);
    });

    it('does not let a refresh token finish a confirmation, and the refreshed session still has no withdraw scope', async () => {
      const session = await register();
      const { secret } = await enrolTotp(session.userId);
      const caller = api.createCaller(await ctxOf(session.accessToken));
      const begun = await caller.stepUp.begin(sendInput(session.userId));
      const rotated = await auth.refresh(session.refreshToken);
      const rotatedCaller = api.createCaller(await ctxOf(rotated.accessToken));
      await expect(rotatedCaller.stepUp.complete({ challengeId: begun.challengeId, totpCode: totpNext(secret) })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
      const refreshed = await verifyAccessToken(rotated.accessToken, tokenConfig);
      expect(hasScope(refreshed.scopes, 'trade:withdraw')).toBe(false);

      const again = await rotatedCaller.stepUp.begin(sendInput(session.userId));
      const done = await rotatedCaller.stepUp.complete({ challengeId: again.challengeId, totpCode: totpNext(secret) });
      expect(done.stepUpApprovalId).toMatch(/^[0-9a-f-]{36}$/);
      expect(hasScope((await verifyAccessToken(rotated.accessToken, tokenConfig)).scopes, 'trade:withdraw')).toBe(false);
    });

    it('refuses the ninth begin inside ten minutes', async () => {
      expect(CUSTOMER_STEP_UP_BEGIN_MAX).toBe(8);
      const session = await register();
      await enrolTotp(session.userId);
      const caller = api.createCaller(await ctxOf(session.accessToken));
      for (let i = 0; i < 8; i += 1) {
        await caller.stepUp.begin(sendInput(session.userId, '1.00', `user-${i}`));
      }
      await expect(caller.stepUp.begin(sendInput(session.userId))).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    });

    it('refuses an expired challenge and an expired approval', async () => {
      const session = await register();
      const { secret } = await enrolTotp(session.userId);
      const caller = api.createCaller(await ctxOf(session.accessToken));
      const stale = await caller.stepUp.begin(sendInput(session.userId));
      clockMs += 121_000;
      await expect(caller.stepUp.complete({ challengeId: stale.challengeId, totpCode: totpNext(secret) })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });

      clockMs = Date.now();
      const begun = await caller.stepUp.begin(sendInput(session.userId, '3.00', 'user-9'));
      const done = await caller.stepUp.complete({ challengeId: begun.challengeId, totpCode: totpNext(secret) });
      clockMs += 301_000;
      const bound = bindCustomerStepUp(session.userId, sendInput(session.userId, '3.00', 'user-9'));
      if (!bound.ok) throw new Error('bind');
      await expect(
        approvals.consume('svc-bank', consumeOf(done.stepUpApprovalId, session.userId, session.sessionId, bound.payloadHash)),
      ).rejects.toMatchObject({
        code: 'action_approval.expired',
      });
    });

    it('stamps lastVerifiedAt on the asserted passkey only, which the API key mint rule reads', async () => {
      const session = await register();
      const used = softAuthenticator();
      const options = await auth.startWebauthnRegistration(session.userId, PASSWORD_SESSION);
      await auth.confirmWebauthnRegistration(session.userId, PASSWORD_SESSION, used.registrationResponse(options.challenge));
      // A second passkey on the account, stored as enrolment stores one; it is never asserted here.
      await db.sql`
        UPDATE users SET webauthn_creds = webauthn_creds || ${db.sql.json([{ credentialId: 'other-passkey', publicKey: 'unused', counter: 0 }])}
        WHERE id = ${session.userId}`;
      const credsOf = async () =>
        (
          await db.sql<Array<{ webauthn_creds: Array<{ credentialId: string; lastVerifiedAt?: string }> }>>`
          SELECT webauthn_creds FROM users WHERE id = ${session.userId}`
        )[0]!.webauthn_creds;
      expect((await credsOf()).every((c) => c.lastVerifiedAt === undefined)).toBe(true);
      const caller = api.createCaller(await ctxOf(session.accessToken));
      const begun = await caller.stepUp.begin(sendInput(session.userId));
      const assertion = used.assertionResponse(begun.webauthn!.challenge);
      await caller.stepUp.complete({ challengeId: begun.challengeId, webauthn: assertion });
      const creds = await credsOf();
      const stamped = creds.filter((c) => typeof c.lastVerifiedAt === 'string');
      expect(stamped.map((c) => c.credentialId)).toEqual([assertion.id]);
      expect(Number.isFinite(Date.parse(stamped[0]!.lastVerifiedAt!))).toBe(true);
    });

    it('accepts a passkey assertion that cannot be reused as a withdraw bearer', async () => {
      const session = await register();
      const authenticator = softAuthenticator();
      const options = await auth.startWebauthnRegistration(session.userId, PASSWORD_SESSION);
      await auth.confirmWebauthnRegistration(session.userId, PASSWORD_SESSION, authenticator.registrationResponse(options.challenge));
      const caller = api.createCaller(await ctxOf(session.accessToken));
      const begun = await caller.stepUp.begin(sendInput(session.userId));
      expect(begun.webauthn?.challenge).toBeTruthy();
      const assertion = authenticator.assertionResponse(begun.webauthn!.challenge);
      await expect(auth.stepUp({ userId: session.userId, sessionId: session.sessionId, webauthn: assertion })).rejects.toMatchObject({
        code: 'auth.webauthn_invalid',
      });
      const done = await caller.stepUp.complete({ challengeId: begun.challengeId, webauthn: assertion });
      expect(done.stepUpApprovalId).toBeTruthy();
      const bound = bindCustomerStepUp(session.userId, sendInput(session.userId));
      if (!bound.ok) throw new Error('bind');
      await expect(
        approvals.consume('svc-bank', consumeOf(done.stepUpApprovalId, session.userId, session.sessionId, bound.payloadHash)),
      ).resolves.toMatchObject({
        status: 'CONSUMED',
      });
    });
  });
}
