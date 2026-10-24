import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from './auth-service.js';
import { TrustedDeviceError, type DeviceAuthorisationDetails } from './trusted-devices.js';
import { RankService } from '../rank/rank-service.js';

/**
 * Trusted devices and new-device sign-in (I-signin-sessions-07; J-identity-02 #5). Sign-up trusts its device; with the
 * check on, any other browser waits after every factor passed and is approved by the mailed code or from a trusted
 * session, completing once; removal ends that device's sessions. Every number here is a TEST fixture.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@127.0.0.1:15491/intafaced_test';
const PASSWORD = 'a long enough sign-in passphrase';
const POLICY = { check: true, flowTtlSeconds: 600, maxAttempts: 3 } as const;
const T0 = Date.parse('2026-10-24T09:00:00.000Z');

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
const webauthnConfig = { rpID: 'localhost', rpName: 'INTAFACED', origin: 'http://localhost:3000' };

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('trusted devices (Postgres unavailable)', () => {
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
  auth.useLogger({ warn: () => undefined });

  const sent: Array<{ email: string; code: string; purpose?: string }> = [];
  let nowMs = T0;
  let counter = 0;
  const account = async () => {
    const handle = `td${process.pid}x${++counter}`;
    const email = `${handle}@example.com`;
    const session = await auth.register({ handle, email, password: PASSWORD });
    await db.sql`UPDATE users SET email_verified_at = ${new Date(T0)} WHERE id = ${session.userId}`;
    return { handle, email, userId: session.userId, deviceKey: session.deviceKey!, sessionId: session.sessionId };
  };
  const refused = async (promise: Promise<unknown>) => {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TrustedDeviceError);
    return err as TrustedDeviceError;
  };
  /** A sign-in from a browser with no trusted key for the account: the waiting sign-in it is handed. */
  const newDevice = async (who: { email: string }, deviceKey: string | null = null): Promise<DeviceAuthorisationDetails> => {
    const err = await refused(auth.login({ identifier: who.email, password: PASSWORD, deviceKey }));
    expect(err.code).toBe('auth.device_authorisation_required');
    return err.details!.deviceAuthorisation!;
  };
  const codesTo = (email: string) => sent.filter((m) => m.email === email && m.purpose === 'new-device-code').map((m) => m.code);
  const count = async (q: string) => (await db.sql.unsafe<Array<{ n: number }>>(q))[0]!.n;

  beforeEach(async () => {
    bus.reset();
    sent.length = 0;
    nowMs = T0;
    auth.usePasswordResetMail({
      async send(message) {
        sent.push(message);
      },
    });
    auth.usePasswordResetPolicy({ subjectKey: 'test-only-flow-subject-key-0123456789abcdef' });
    auth.useNewDevicePolicy(POLICY);
    auth.useMailRelayTrigger(async () => void (await auth.drainMailOutbox()));
    auth.usePasswordResetClock(() => new Date(nowMs));
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('new-device sign-in', () => {
    it('trusts the device an account was made on, and signs in there without asking', async () => {
      const who = await account();
      expect(who.deviceKey).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      const session = await auth.login({ identifier: who.email, password: PASSWORD, deviceKey: who.deviceKey });
      const [row] = await db.sql<
        Array<{ trusted_device_id: string | null }>
      >`SELECT trusted_device_id FROM sessions WHERE id = ${session.sessionId}`;
      expect(row!.trusted_device_id).toEqual(expect.any(String));
      // Only the key's hash is kept.
      expect(JSON.stringify(await db.sql`SELECT * FROM trusted_devices`)).not.toContain(who.deviceKey);
    });

    it('keeps the key a browser already holds, so one browser is one device across accounts', async () => {
      const first = await account();
      const handle = `td${process.pid}x${++counter}`;
      const second = await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD, deviceKey: first.deviceKey });
      expect(second.deviceKey).toBe(first.deviceKey);
      await auth.login({ identifier: `${handle}@example.com`, password: PASSWORD, deviceKey: first.deviceKey });
      // A malformed key is never stored; the browser gets a fresh one.
      const third = await auth.register({ handle: `${handle}b`, email: `${handle}b@example.com`, password: PASSWORD, deviceKey: 'short' });
      expect(third.deviceKey).not.toBe('short');
    });

    it('asks a browser with no key, or a key of another account, only after the password passed, and mails a code', async () => {
      const who = await account();
      const other = await account();
      const wrong = await auth.login({ identifier: who.email, password: `${PASSWORD}x`, deviceKey: null }).catch((e: unknown) => e);
      expect((wrong as { code?: string }).code).toBe('auth.invalid_credentials');
      expect(await count('SELECT count(*)::int AS n FROM device_authorisations')).toBe(0);

      const waiting = await newDevice(who);
      expect(waiting).toEqual({
        flowId: expect.any(String),
        secret: expect.any(String),
        expiresAt: '2026-10-24T09:10:00.000Z',
        mailed: true,
      });
      expect(codesTo(who.email)).toHaveLength(1);
      expect(codesTo(who.email)[0]).toMatch(/^\d{6}$/);
      // Another account's device key is not this account's device.
      await newDevice(who, other.deviceKey);
      expect(await count('SELECT count(*)::int AS n FROM sessions WHERE revoked = false')).toBe(2);
    });

    it('approves with the mailed code: one session, a trusted row, a key that then signs in without asking', async () => {
      const who = await account();
      const waiting = await newDevice(who);
      const session = await auth.deviceApprove({ flowId: waiting.flowId, secret: waiting.secret, code: codesTo(who.email)[0]! });
      expect(session).toMatchObject({ userId: who.userId, deviceKey: expect.any(String) });
      expect(await count(`SELECT count(*)::int AS n FROM trusted_devices WHERE user_id = '${who.userId}' AND removed_at IS NULL`)).toBe(2);

      // Once only.
      expect((await refused(auth.deviceComplete({ flowId: waiting.flowId, secret: waiting.secret }))).code).toBe(
        'auth.device_authorisation_used',
      );
      expect(
        (await refused(auth.deviceApprove({ flowId: waiting.flowId, secret: waiting.secret, code: codesTo(who.email)[0]! }))).code,
      ).toBe('auth.device_authorisation_used');
      await auth.login({ identifier: who.email, password: PASSWORD, deviceKey: session.deviceKey! });
    });

    it('locks after the owner count of wrong codes, and refuses a request without its secret', async () => {
      const who = await account();
      const waiting = await newDevice(who);
      const code = codesTo(who.email)[0]!;
      const wrong = code === '000000' ? '111111' : '000000';
      expect((await refused(auth.deviceApprove({ flowId: waiting.flowId, secret: 'x'.repeat(43), code }))).code).toBe(
        'auth.device_authorisation_invalid',
      );
      for (const expected of ['auth.code_invalid', 'auth.code_invalid', 'auth.too_many_attempts']) {
        expect((await refused(auth.deviceApprove({ flowId: waiting.flowId, secret: waiting.secret, code: wrong }))).code).toBe(expected);
      }
      expect((await refused(auth.deviceApprove({ flowId: waiting.flowId, secret: waiting.secret, code }))).code).toBe(
        'auth.too_many_attempts',
      );
      expect(await count(`SELECT count(*)::int AS n FROM sessions WHERE user_id = '${who.userId}'`)).toBe(1);
    });

    it('counts wrong codes against the account, so requests opened side by side share one allowance', async () => {
      const who = await account();
      const flows = [await newDevice(who), await newDevice(who), await newDevice(who)];
      const codes = codesTo(who.email);
      const wrongFor = (i: number) => (codes[i] === '000000' ? '111111' : '000000');
      const guess = async (i: number, code: string) =>
        (await refused(auth.deviceApprove({ flowId: flows[i]!.flowId, secret: flows[i]!.secret, code }))).code;
      expect(await guess(0, wrongFor(0))).toBe('auth.code_invalid');
      expect(await guess(1, wrongFor(1))).toBe('auth.code_invalid');
      expect(await guess(2, wrongFor(2))).toBe('auth.too_many_attempts');
      // The allowance is spent: even the first request's right code is refused, and nothing signed in.
      expect(await guess(0, codes[0]!)).toBe('auth.too_many_attempts');
      expect(await count(`SELECT count(*)::int AS n FROM sessions WHERE user_id = '${who.userId}'`)).toBe(1);
    });

    it('expires with the owner lifetime', async () => {
      const who = await account();
      const waiting = await newDevice(who);
      nowMs = T0 + 601_000;
      expect(
        (await refused(auth.deviceApprove({ flowId: waiting.flowId, secret: waiting.secret, code: codesTo(who.email)[0]! }))).code,
      ).toBe('auth.code_expired');
    });

    it('is approved from a session on a trusted device of the same account, and completes once', async () => {
      const who = await account();
      const stranger = await account();
      const waiting = await newDevice(who);
      expect(await auth.pendingDeviceAuthorisations(who.userId)).toEqual([expect.objectContaining({ flowId: waiting.flowId })]);
      expect((await refused(auth.deviceComplete({ flowId: waiting.flowId, secret: waiting.secret }))).code).toBe(
        'auth.device_authorisation_pending',
      );
      // Another account cannot approve it, even from its own trusted device.
      expect(
        (await refused(auth.deviceApproveFromSession({ flowId: waiting.flowId, userId: stranger.userId, sessionId: stranger.sessionId })))
          .code,
      ).toBe('identity.device_not_found');
      await auth.deviceApproveFromSession({ flowId: waiting.flowId, userId: who.userId, sessionId: who.sessionId });
      await auth.deviceApproveFromSession({ flowId: waiting.flowId, userId: who.userId, sessionId: who.sessionId });
      const session = await auth.deviceComplete({ flowId: waiting.flowId, secret: waiting.secret });
      expect(session.userId).toBe(who.userId);
      expect((await refused(auth.deviceComplete({ flowId: waiting.flowId, secret: waiting.secret }))).code).toBe(
        'auth.device_authorisation_used',
      );
    });

    it('refuses approval from a session that is not on a trusted device, and a flow locked by wrong codes', async () => {
      const who = await account();
      const untrusted = await auth.login({ identifier: who.email, password: PASSWORD, deviceKey: who.deviceKey });
      await db.sql`UPDATE sessions SET trusted_device_id = NULL WHERE id = ${untrusted.sessionId}`;
      const waiting = await newDevice(who);
      expect(
        (await refused(auth.deviceApproveFromSession({ flowId: waiting.flowId, userId: who.userId, sessionId: untrusted.sessionId }))).code,
      ).toBe('auth.device_not_trusted');

      const code = codesTo(who.email)[0]!;
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 3; i++) await refused(auth.deviceApprove({ flowId: waiting.flowId, secret: waiting.secret, code: wrong }));
      expect(
        (await refused(auth.deviceApproveFromSession({ flowId: waiting.flowId, userId: who.userId, sessionId: who.sessionId }))).code,
      ).toBe('auth.too_many_attempts');
    });

    it('caps new-device requests per account inside the lifetime window, and says when to try again', async () => {
      const who = await account();
      for (let i = 0; i < 3; i++) await newDevice(who);
      const capped = await refused(auth.login({ identifier: who.email, password: PASSWORD }));
      expect(capped.code).toBe('auth.too_many_attempts');
      expect(capped.details?.retryAfterSeconds).toBe(600);
      expect(codesTo(who.email)).toHaveLength(3);
      nowMs = T0 + 601_000;
      await newDevice(who);
    });

    it('spends nothing when the account was frozen between approval and completion', async () => {
      const who = await account();
      const waiting = await newDevice(who);
      await auth.deviceApproveFromSession({ flowId: waiting.flowId, userId: who.userId, sessionId: who.sessionId });
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${who.userId}`;
      expect((await refused(auth.deviceComplete({ flowId: waiting.flowId, secret: waiting.secret }))).code).toBe('auth.account_frozen');
      await db.sql`UPDATE users SET status = 'active' WHERE id = ${who.userId}`;
      expect((await auth.deviceComplete({ flowId: waiting.flowId, secret: waiting.secret })).userId).toBe(who.userId);
    });

    it('removing a device ends its sessions, including rotated ones, and the next sign-in there asks again', async () => {
      const who = await account();
      const [device] = await auth.trustedDevices(who.userId, who.sessionId);
      expect(device).toMatchObject({ current: true });
      const first = await auth.login({ identifier: who.email, password: PASSWORD, deviceKey: who.deviceKey });
      const rotated = await auth.refresh(first.refreshToken);
      const [moved] = await db.sql<
        Array<{ trusted_device_id: string | null }>
      >`SELECT trusted_device_id FROM sessions WHERE id = ${rotated.sessionId}`;
      expect(moved!.trusted_device_id).toBe(device!.id);

      expect(await auth.removeTrustedDevice(who.userId, device!.id)).toEqual({ removed: true, sessionsEnded: 2 });
      expect(await auth.removeTrustedDevice(who.userId, device!.id)).toEqual({ removed: false, sessionsEnded: 0 });
      expect(await count(`SELECT count(*)::int AS n FROM sessions WHERE user_id = '${who.userId}' AND revoked = false`)).toBe(0);
      await newDevice(who, who.deviceKey);
    });

    it('while the check is off, trusts each browser as it signs in, so it is not asked once the check is on', async () => {
      auth.useNewDevicePolicy({ check: false });
      const who = await account();
      const session = await auth.login({ identifier: who.email, password: PASSWORD });
      expect(session.deviceKey).toEqual(expect.any(String));
      const [row] = await db.sql<
        Array<{ trusted_device_id: string | null }>
      >`SELECT trusted_device_id FROM sessions WHERE id = ${session.sessionId}`;
      expect(row!.trusted_device_id).toEqual(expect.any(String));
      auth.useNewDevicePolicy(POLICY);
      await auth.login({ identifier: who.email, password: PASSWORD, deviceKey: session.deviceKey! });
    });

    it('refuses rather than skip the check when its lifetime is unpublished', async () => {
      const who = await account();
      auth.useNewDevicePolicy({ check: true });
      expect((await refused(auth.login({ identifier: who.email, password: PASSWORD }))).code).toBe('auth.device_check_unwired');
    });

    it('without mail, waits unmailed for a trusted session; with no trusted device either, names the missing email', async () => {
      const who = await account();
      auth.usePasswordResetMail(undefined);
      const waiting = await newDevice(who);
      expect(waiting.mailed).toBe(false);
      await db.sql`UPDATE trusted_devices SET removed_at = ${new Date(T0)} WHERE user_id = ${who.userId}`;
      expect((await refused(auth.login({ identifier: who.email, password: PASSWORD }))).code).toBe('vendor.email');
    });

    it('names the real blocker when nothing could approve: unpublished code setting, or no proved address', async () => {
      const who = await account();
      await db.sql`UPDATE trusted_devices SET removed_at = ${new Date(T0)} WHERE user_id = ${who.userId}`;
      auth.useNewDevicePolicy({ check: true, flowTtlSeconds: 600 });
      expect((await refused(auth.login({ identifier: who.email, password: PASSWORD }))).code).toBe('auth.device_check_unwired');
      auth.useNewDevicePolicy(POLICY);
      await db.sql`UPDATE users SET email_verified_at = NULL WHERE id = ${who.userId}`;
      expect((await refused(auth.login({ identifier: who.email, password: PASSWORD }))).code).toBe('auth.device_approval_unavailable');
    });

    it('never opens a flow for a frozen account', async () => {
      const who = await account();
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${who.userId}`;
      const err = await auth.login({ identifier: who.email, password: PASSWORD }).catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe('auth.account_frozen');
      expect(await count('SELECT count(*)::int AS n FROM device_authorisations')).toBe(0);
    });
  });

  describe('the trusted-device read for other services', () => {
    const deviceOf = async (sessionId: string) =>
      (await db.sql<Array<{ id: string }>>`SELECT trusted_device_id AS id FROM sessions WHERE id = ${sessionId}`)[0]!.id;

    it('says how each device was trusted: sign-up, approval, or a sign-in while the check was off', async () => {
      const who = await account();
      const signUp = await deviceOf(who.sessionId);
      expect(await auth.trustedDeviceState(who.userId, signUp)).toEqual({ live: true, trustedBy: 'sign-up', newDeviceCheck: 'on' });

      const waiting = await newDevice(who);
      const approved = await auth.deviceApprove({ flowId: waiting.flowId, secret: waiting.secret, code: codesTo(who.email)[0]! });
      expect(await auth.trustedDeviceState(who.userId, await deviceOf(approved.sessionId))).toEqual({
        live: true,
        trustedBy: 'approval',
        newDeviceCheck: 'on',
      });

      auth.useNewDevicePolicy({ check: false });
      const unasked = await auth.login({ identifier: who.email, password: PASSWORD });
      expect(await auth.trustedDeviceState(who.userId, await deviceOf(unasked.sessionId))).toEqual({
        live: true,
        trustedBy: 'sign-in',
        newDeviceCheck: 'off',
      });
    });

    it("reads an unknown device, another account's device, a removed one and an expired one as not live", async () => {
      const who = await account();
      const stranger = await account();
      const device = await deviceOf(who.sessionId);
      expect(await auth.trustedDeviceState(who.userId, '44444444-4444-4444-8444-444444444444')).toEqual({
        live: false,
        trustedBy: null,
        newDeviceCheck: 'on',
      });
      expect(await auth.trustedDeviceState(stranger.userId, device)).toEqual({ live: false, trustedBy: null, newDeviceCheck: 'on' });

      await db.sql`UPDATE trusted_devices SET trusted_until = ${new Date(T0 + 1000)} WHERE id = ${device}`;
      nowMs = T0 + 1000;
      expect(await auth.trustedDeviceState(who.userId, device)).toMatchObject({ live: false, trustedBy: 'sign-up' });
      nowMs = T0;
      expect(await auth.removeTrustedDevice(who.userId, device)).toMatchObject({ removed: true });
      expect(await auth.trustedDeviceState(who.userId, device)).toMatchObject({ live: false, trustedBy: 'sign-up' });
    });

    it('a device approved from a device trusted while the check was off is no better proved than its approver', async () => {
      const who = await account();
      auth.useNewDevicePolicy({ check: false });
      const unasked = await auth.login({ identifier: who.email, password: PASSWORD });
      auth.useNewDevicePolicy(POLICY);
      const waiting = await newDevice(who);
      await auth.deviceApproveFromSession({ flowId: waiting.flowId, userId: who.userId, sessionId: unasked.sessionId });
      const vouched = await auth.deviceComplete({ flowId: waiting.flowId, secret: waiting.secret });
      expect(await auth.trustedDeviceState(who.userId, await deviceOf(vouched.sessionId))).toEqual({
        live: true,
        trustedBy: 'sign-in',
        newDeviceCheck: 'on',
      });
      // Approved from the sign-up device instead, the same request is proved.
      const second = await newDevice(who);
      await auth.deviceApproveFromSession({ flowId: second.flowId, userId: who.userId, sessionId: who.sessionId });
      const proved = await auth.deviceComplete({ flowId: second.flowId, secret: second.secret });
      expect(await auth.trustedDeviceState(who.userId, await deviceOf(proved.sessionId))).toMatchObject({ trustedBy: 'approval' });
    });

    it('no device of a frozen account is live', async () => {
      const who = await account();
      const device = await deviceOf(who.sessionId);
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${who.userId}`;
      expect(await auth.trustedDeviceState(who.userId, device)).toEqual({ live: false, trustedBy: 'sign-up', newDeviceCheck: 'on' });
    });

    it('a device trusted again after its time ran out, with the check off, is no longer counted as approved', async () => {
      const who = await account();
      const waiting = await newDevice(who);
      const approved = await auth.deviceApprove({ flowId: waiting.flowId, secret: waiting.secret, code: codesTo(who.email)[0]! });
      const device = await deviceOf(approved.sessionId);
      await db.sql`UPDATE trusted_devices SET trusted_until = ${new Date(T0 + 1000)} WHERE id = ${device}`;
      nowMs = T0 + 2000;
      auth.useNewDevicePolicy({ check: false });
      const again = await auth.login({ identifier: who.email, password: PASSWORD, deviceKey: approved.deviceKey! });
      expect(await deviceOf(again.sessionId)).toBe(device);
      expect(await auth.trustedDeviceState(who.userId, device)).toEqual({ live: true, trustedBy: 'sign-in', newDeviceCheck: 'off' });
    });
  });
}
