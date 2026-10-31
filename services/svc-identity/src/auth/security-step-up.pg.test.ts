/**
 * The security step-up guard against Postgres: a real begin and complete mint the approval, and the
 * guard spends it once for exactly this action and these field values.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyAccessToken } from '@intafaced/auth';
import { doorForScope, type Context, type SamePersonActionType } from '@intafaced/contracts';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { ActionApprovalService } from './action-approval-service.js';
import { SqlActionApprovalStore } from './action-approval-store.js';
import { AuthService } from './auth-service.js';
import { CustomerStepUpService } from './customer-step-up.js';
import { SqlCustomerStepUpStore } from './customer-step-up-store.js';
import { SECURITY_STEP_UP_SCOPES, SecurityStepUp, type SecurityStepUpPrincipal } from './security-step-up.js';
import { totp } from './totp.js';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { createStepUpRouter } from '../step-up-router.js';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const PASSWORD_SESSION = { mfa: false, privileged: false } as const;
const REMOVE = 'identity.step_up.passkey_remove' as const;
const ADD = 'identity.step_up.passkey_add' as const;

const tokenConfig = {
  secret: 'an-identity-security-step-up-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const webauthnConfig = { rpID: 'localhost', rpName: 'INTAFACED', origin: 'http://localhost:3000' };

function totpNext(secret: string): string {
  const step = 30;
  const counter = Math.floor(Math.floor(Date.now() / 1000) / step);
  return totp(secret, { at: new Date((counter + 1) * step * 1000) });
}

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

if (!(await postgresAvailable(URL))) {
  describe.skip('security step-up guard (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_security_step_up',
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

  let clockMs = Date.now();
  const clock = () => new Date(clockMs);
  const store = new SqlCustomerStepUpStore(db.sql);
  const approvals = new ActionApprovalService(new SqlActionApprovalStore(db.sql), { ttlSeconds: 60 }, clock, (row, at) =>
    store.auditConsumed({ ...row, at }),
  );
  const api = createStepUpRouter(new CustomerStepUpService(db.sql, store, auth, clock));
  const guard = new SecurityStepUp({
    sql: db.sql,
    approvals,
    secondFactor: (userId) => auth.customerStepUpMaterial(userId, 'security_change'),
    now: clock,
  });

  let n = 0;
  const unique = () => `ssu${process.pid}${++n}`;

  beforeEach(async () => {
    clockMs = Date.now();
    await db.truncateAll();
    await rank.seedTiers();
  });

  afterAll(async () => {
    await db.drop();
  });

  async function ctxOf(accessToken: string): Promise<Context> {
    return { principal: await verifyAccessToken(accessToken, tokenConfig), service: null, region: 'DE', requestId: 'req-security-step-up' };
  }

  async function newUser(withTotp = true) {
    const handle = unique();
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
    let secret = '';
    let recoveryCodes: string[] = [];
    if (withTotp) {
      const started = await auth.startTotpEnrolment(session.userId, PASSWORD_SESSION);
      await auth.confirmTotpEnrolment(session.userId, PASSWORD_SESSION, started.secret, totp(started.secret));
      secret = started.secret;
      recoveryCodes = started.recoveryCodes;
    }
    const principal: SecurityStepUpPrincipal = { userId: session.userId, sid: session.sessionId };
    return { session, secret, recoveryCodes, principal };
  }

  /** Runs the real ceremony and returns the approval id. */
  async function mint(
    user: Awaited<ReturnType<typeof newUser>>,
    scope: SamePersonActionType,
    purpose: string,
    fields: Record<string, string>,
    target: string,
  ) {
    const caller = api.createCaller(await ctxOf(user.session.accessToken));
    const begun = await caller.stepUp.begin({ scope, purpose, target, fields });
    const done = await caller.stepUp.complete({ challengeId: begun.challengeId, totpCode: totpNext(user.secret) });
    return done.stepUpApprovalId;
  }

  const removeFields = { credentialId: 'cred-1', clientRequestId: 'req-1' };
  const mintRemove = (user: Awaited<ReturnType<typeof newUser>>, fields = removeFields) =>
    mint(user, REMOVE, 'account.passkey.remove', fields, fields.credentialId);

  describe('SecurityStepUp.require', () => {
    it('names the 13 STP-3 scopes, the security lock unlock, new-device approval and recovery keys, and each has a door the guard can bind', () => {
      expect(new Set(SECURITY_STEP_UP_SCOPES).size).toBe(18);
      for (const scope of SECURITY_STEP_UP_SCOPES) expect(doorForScope(scope)?.scope).toBe(scope);
    });

    it('refuses an account with no second factor so the client can offer enrolment', async () => {
      const user = await newUser(false);
      await expect(guard.require(user.principal, REMOVE, removeFields, undefined)).rejects.toMatchObject({
        code: 'identity.second_factor_required',
      });
      await expect(guard.require(user.principal, REMOVE, removeFields, 'appr_made_up')).rejects.toMatchObject({
        code: 'identity.second_factor_required',
      });
    });

    it('asks for a step-up when none is presented', async () => {
      const user = await newUser();
      await expect(guard.require(user.principal, REMOVE, removeFields, undefined)).rejects.toMatchObject({
        code: 'identity.step_up_required',
      });
      await expect(guard.require(user.principal, REMOVE, removeFields, null)).rejects.toMatchObject({ code: 'identity.step_up_required' });
    });

    it('spends one approval once, and a second use is already used', async () => {
      const user = await newUser();
      const approvalId = await mintRemove(user);
      await expect(guard.require(user.principal, REMOVE, removeFields, approvalId)).resolves.toBeUndefined();
      await expect(guard.require(user.principal, REMOVE, removeFields, approvalId)).rejects.toMatchObject({
        code: 'identity.step_up_used',
      });
    });

    it('does not spend an approval minted for another action or other field values', async () => {
      const user = await newUser();
      const approvalId = await mintRemove(user);
      await expect(guard.require(user.principal, ADD, { label: 'Phone', clientRequestId: 'req-1' }, approvalId)).rejects.toMatchObject({
        code: 'identity.step_up_target',
      });
      await expect(
        guard.require(user.principal, REMOVE, { credentialId: 'cred-2', clientRequestId: 'req-1' }, approvalId),
      ).rejects.toMatchObject({ code: 'identity.step_up_target' });
      await expect(guard.require(user.principal, REMOVE, { credentialId: 'cred-1' }, approvalId)).rejects.toMatchObject({
        code: 'identity.step_up_target',
      });
      // None of the refusals spent it.
      await expect(guard.require(user.principal, REMOVE, removeFields, approvalId)).resolves.toBeUndefined();
    });

    it('says another person’s approval is not theirs, and another session’s too', async () => {
      const owner = await newUser();
      const other = await newUser();
      const approvalId = await mintRemove(owner);
      await expect(guard.require(other.principal, REMOVE, removeFields, approvalId)).rejects.toMatchObject({
        code: 'identity.step_up_not_yours',
      });
      await expect(
        guard.require({ userId: owner.principal.userId, sid: '22222222-2222-4222-8222-222222222222' }, REMOVE, removeFields, approvalId),
      ).rejects.toMatchObject({ code: 'identity.step_up_not_yours' });
      await expect(guard.require(owner.principal, REMOVE, removeFields, approvalId)).resolves.toBeUndefined();
    });

    it('refuses an API key and a sub-account before touching the approval', async () => {
      const user = await newUser();
      const approvalId = await mintRemove(user);
      await expect(guard.require({ ...user.principal, kid: 'key-1' }, REMOVE, removeFields, approvalId)).rejects.toMatchObject({
        code: 'identity.delegated_refused',
      });
      await expect(
        guard.require({ ...user.principal, sub_account: '33333333-3333-4333-8333-333333333333' }, REMOVE, removeFields, approvalId),
      ).rejects.toMatchObject({ code: 'identity.delegated_refused' });
      await expect(guard.require(user.principal, REMOVE, removeFields, approvalId)).resolves.toBeUndefined();
    });

    it('refuses an approval that expired between complete and the call', async () => {
      const user = await newUser();
      const approvalId = await mintRemove(user);
      clockMs += 301_000;
      await expect(guard.require(user.principal, REMOVE, removeFields, approvalId)).rejects.toMatchObject({
        code: 'identity.step_up_expired',
      });
    });

    it('refuses a scope that is not a security scope', async () => {
      const user = await newUser();
      await expect(
        guard.require(user.principal, 'identity.step_up.close_account' as never, { intent: 'close', clientRequestId: 'x' }, 'a'),
      ).rejects.toThrow(/not a security step-up scope/);
    });
  });

  describe('a recovery code in place of the app (J-identity-05 #4)', () => {
    const REPLACE = 'identity.step_up.totp_replace' as const;
    const begin = async (
      user: Awaited<ReturnType<typeof newUser>>,
      scope: SamePersonActionType,
      purpose: string,
      fields: Record<string, string> = { clientRequestId: 'req-lost-phone' },
      target = fields.clientRequestId!,
    ) => {
      const caller = api.createCaller(await ctxOf(user.session.accessToken));
      return { caller, begun: await caller.stepUp.begin({ scope, purpose, target, fields }) };
    };
    const left = async (userId: string) =>
      (await db.sql<Array<{ n: number }>>`SELECT jsonb_array_length(recovery_code_hashes) AS n FROM users WHERE id = ${userId}`)[0]!.n;

    it('completes the replace step-up once, and the code is spent', async () => {
      const user = await newUser();
      const before = await left(user.session.userId);
      const { caller, begun } = await begin(user, REPLACE, 'account.totp.replace');
      const done = await caller.stepUp.complete({ challengeId: begun.challengeId, recoveryCode: user.recoveryCodes[0]! });
      expect(done.stepUpApprovalId).toBeTruthy();
      expect(await left(user.session.userId)).toBe(before - 1);
      const again = await begin(user, REPLACE, 'account.totp.replace');
      await expect(
        again.caller.stepUp.complete({ challengeId: again.begun.challengeId, recoveryCode: user.recoveryCodes[0]! }),
      ).rejects.toMatchObject({
        cause: { code: 'auth.mfa_invalid' },
      });
    });

    it('never confirms anything but the authenticator itself, and spends nothing when refused', async () => {
      const user = await newUser();
      const before = await left(user.session.userId);
      const { caller, begun } = await begin(user, REMOVE, 'account.passkey.remove', removeFields, removeFields.credentialId);
      await expect(caller.stepUp.complete({ challengeId: begun.challengeId, recoveryCode: user.recoveryCodes[0]! })).rejects.toMatchObject({
        cause: { code: 'auth.mfa_invalid' },
      });
      expect(await left(user.session.userId)).toBe(before);
    });

    it('a code and a recovery code together are refused', async () => {
      const user = await newUser();
      const { caller, begun } = await begin(user, REPLACE, 'account.totp.replace');
      await expect(
        caller.stepUp.complete({ challengeId: begun.challengeId, totpCode: totpNext(user.secret), recoveryCode: user.recoveryCodes[0]! }),
      ).rejects.toThrow(/exactly one of totpCode, recoveryCode or webauthn/);
      expect(await left(user.session.userId)).toBe(10);
    });
  });

  describe('SecurityStepUp.assertHeld', () => {
    it("accepts this session's approval for these values without spending it; require then spends it once", async () => {
      const user = await newUser();
      const approvalId = await mintRemove(user);
      await expect(guard.assertHeld(user.principal, REMOVE, removeFields, approvalId)).resolves.toBeUndefined();
      await expect(guard.assertHeld(user.principal, REMOVE, removeFields, approvalId)).resolves.toBeUndefined();
      await expect(guard.require(user.principal, REMOVE, removeFields, approvalId)).resolves.toBeUndefined();
      await expect(guard.assertHeld(user.principal, REMOVE, removeFields, approvalId)).rejects.toMatchObject({
        code: 'identity.step_up_used',
      });
    });

    it('refuses no approval, an unknown one, other values, another scope, another session and another person', async () => {
      const user = await newUser();
      const other = await newUser();
      const approvalId = await mintRemove(user);
      await expect(guard.assertHeld(user.principal, REMOVE, removeFields, undefined)).rejects.toMatchObject({
        code: 'identity.step_up_required',
      });
      await expect(guard.assertHeld(user.principal, REMOVE, removeFields, 'appr_made_up')).rejects.toMatchObject({
        code: 'identity.step_up_required',
      });
      await expect(
        guard.assertHeld(user.principal, REMOVE, { credentialId: 'cred-2', clientRequestId: 'req-1' }, approvalId),
      ).rejects.toMatchObject({ code: 'identity.step_up_target' });
      await expect(guard.assertHeld(user.principal, ADD, { label: 'Phone', clientRequestId: 'req-1' }, approvalId)).rejects.toMatchObject({
        code: 'identity.step_up_target',
      });
      await expect(guard.assertHeld({ ...user.principal, sid: 'another-session' }, REMOVE, removeFields, approvalId)).rejects.toMatchObject(
        {
          code: 'identity.step_up_not_yours',
        },
      );
      await expect(guard.assertHeld(other.principal, REMOVE, removeFields, approvalId)).rejects.toMatchObject({
        code: 'identity.step_up_not_yours',
      });
      await expect(guard.assertHeld({ ...user.principal, kid: 'key-1' }, REMOVE, removeFields, approvalId)).rejects.toMatchObject({
        code: 'identity.delegated_refused',
      });
      // None of those spent it.
      await expect(guard.require(user.principal, REMOVE, removeFields, approvalId)).resolves.toBeUndefined();
    });

    it('refuses an expired approval', async () => {
      const user = await newUser();
      const approvalId = await mintRemove(user);
      clockMs += 301_000;
      await expect(guard.assertHeld(user.principal, REMOVE, removeFields, approvalId)).rejects.toMatchObject({
        code: 'identity.step_up_expired',
      });
    });
  });
}
