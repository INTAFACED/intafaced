import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthError, AuthService } from './auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { SessionLimitError, sessionLimitsView, setChosenIdleSeconds, ownerSessionNumber } from './session-limits.js';

/**
 * Idle sign-out and the limit on signed-in devices (I-signin-sessions-06; J-identity-06 #4). Every number here is a TEST
 * fixture, never an owner value.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@127.0.0.1:15491/intafaced_test';
const PASSWORD = 'a long enough sign-in passphrase';

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

describe('owner session numbers from env', () => {
  it('reads blank as unpublished and refuses anything outside its range', () => {
    expect(ownerSessionNumber(undefined, 'X', 1, 50)).toBeUndefined();
    expect(ownerSessionNumber('  ', 'X', 1, 50)).toBeUndefined();
    expect(ownerSessionNumber('3', 'X', 1, 50)).toBe(3);
    expect(() => ownerSessionNumber('0', 'X', 1, 50)).toThrow(/X must be a whole number from 1 to 50/);
    expect(() => ownerSessionNumber('2.5', 'X', 1, 50)).toThrow(/whole number/);
    expect(() => ownerSessionNumber('lots', 'X', 1, 50)).toThrow(/whole number/);
  });
});

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('session limits (Postgres unavailable)', () => {
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

  let counter = 0;
  const account = async () => {
    const handle = `sl${process.pid}x${++counter}`;
    const email = `${handle}@example.com`;
    const session = await auth.register({ handle, email, password: PASSWORD });
    return { email, userId: session.userId, deviceKey: session.deviceKey!, session };
  };
  const signIn = (who: { email: string; deviceKey: string }) =>
    auth.login({ identifier: who.email, password: PASSWORD, deviceKey: who.deviceKey });
  /** The session row behind a refresh token, as if it was last used `seconds` ago. */
  const idleFor = async (sessionId: string, seconds: number) =>
    db.sql`UPDATE sessions SET last_used_at = now() - make_interval(secs => ${seconds}) WHERE id = ${sessionId}`;
  const refusal = async (promise: Promise<unknown>) => {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    return err;
  };
  const liveFamilies = async (userId: string) =>
    (
      await db.sql<Array<{ family_id: string }>>`
        SELECT DISTINCT family_id FROM sessions WHERE user_id = ${userId} AND revoked = false AND expires_at > now()`
    ).map((row) => row.family_id);

  beforeEach(async () => {
    auth.useSessionLimits({});
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('idle sign-out', () => {
    it("ends a sign-in idle past the owner's limit at its next refresh, and keeps one inside it", async () => {
      auth.useSessionLimits({ idleSeconds: 600 });
      const who = await account();
      await idleFor(who.session.sessionId, 500);
      const next = await auth.refresh(who.session.refreshToken);
      await idleFor(next.sessionId, 601);
      const err = await refusal(auth.refresh(next.refreshToken));
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).code).toBe('auth.session_idle');
      const [row] = await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM sessions WHERE id = ${next.sessionId}`;
      expect(row!.revoked).toBe(true);
    });

    it("applies a customer's shorter choice, refuses a longer one, and refuses any choice while the owner's is blank", async () => {
      const who = await account();
      const unset = await refusal(setChosenIdleSeconds(db.sql, {}, who.userId, 300));
      expect(unset).toBeInstanceOf(SessionLimitError);
      expect((unset as SessionLimitError).code).toBe('identity.session_idle_unset');

      const policy = { idleSeconds: 3600 };
      auth.useSessionLimits(policy);
      const longer = await refusal(setChosenIdleSeconds(db.sql, policy, who.userId, 7200));
      expect((longer as SessionLimitError).code).toBe('identity.session_setting_out_of_range');
      const tooShort = await refusal(setChosenIdleSeconds(db.sql, policy, who.userId, 30));
      expect((tooShort as SessionLimitError).code).toBe('identity.session_setting_out_of_range');
      expect(await sessionLimitsView(db.sql, policy, who.userId)).toEqual({
        ownerIdleSeconds: 3600,
        chosenIdleSeconds: null,
        maxConcurrent: null,
      });

      await setChosenIdleSeconds(db.sql, policy, who.userId, 300);
      expect(await sessionLimitsView(db.sql, policy, who.userId)).toEqual({
        ownerIdleSeconds: 3600,
        chosenIdleSeconds: 300,
        maxConcurrent: null,
      });
      // 301 seconds idle: inside the owner's hour, past the customer's five minutes.
      await idleFor(who.session.sessionId, 301);
      expect(((await refusal(auth.refresh(who.session.refreshToken))) as AuthError).code).toBe('auth.session_idle');

      // Cleared, the owner's limit applies again.
      await setChosenIdleSeconds(db.sql, policy, who.userId, null);
      const again = await signIn(who);
      await idleFor(again.sessionId, 301);
      await auth.refresh(again.refreshToken);
    });

    it('with no owner limit, an old but unexpired sign-in still refreshes', async () => {
      const who = await account();
      await idleFor(who.session.sessionId, 86_400 * 3);
      await auth.refresh(who.session.refreshToken);
    });
  });

  describe('limit on signed-in devices', () => {
    it('ends the oldest sign-in when one more would pass the limit; the newer ones stay', async () => {
      auth.useSessionLimits({ maxConcurrent: 3 });
      const who = await account();
      const first = (await liveFamilies(who.userId))[0]!;
      await signIn(who);
      await signIn(who);
      expect(await liveFamilies(who.userId)).toHaveLength(3);
      // The fourth sign-in: the account's first device is ended, three stay.
      await signIn(who);
      const live = await liveFamilies(who.userId);
      expect(live).toHaveLength(3);
      expect(live).not.toContain(first);
      expect(((await refusal(auth.refresh(who.session.refreshToken))) as AuthError).code).toBe('auth.session_invalid');
    });

    it('a refresh is not a new sign-in, and with no limit every sign-in stays', async () => {
      auth.useSessionLimits({ maxConcurrent: 2 });
      const who = await account();
      const second = await signIn(who);
      await auth.refresh(second.refreshToken);
      expect(await liveFamilies(who.userId)).toHaveLength(2);

      auth.useSessionLimits({});
      for (let i = 0; i < 4; i++) await signIn(who);
      expect(await liveFamilies(who.userId)).toHaveLength(6);
    });
  });
}
