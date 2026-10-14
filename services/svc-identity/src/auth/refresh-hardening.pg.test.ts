import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb, postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { verifyAccessToken } from '@intafaced/auth';
import { AuthService, type SessionTokens } from './auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { totp } from './totp.js';
import { hashToken } from './passwords.js';
import { openGracePayload, type RefreshPolicy } from './refresh-policy.js';

/**
 * Refresh hardening against real Postgres (own isolated schema): the MFA max age and the
 * refresh grace window (security review of the stay-signed-in PRs #4733 / #4759).
 *
 * What these hold:
 *   · `mfa` rides a refresh only while `now - auth_time` is within the max age, the founder pair
 *     and admins get a shorter one, and `auth_time` is carried forward unchanged (never reset);
 *   · a retired refresh token presented inside the grace window is answered once with the SAME
 *     successor pair; outside the window, a second time, or after the successor was used, it is
 *     theft and revokes every session; a replay that does not fit its session family is refused;
 *   · the stored successor is unreadable without the retired token and the service secret.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const PASSWORD = 'correct horse battery staple';
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

/** Fixture values for these tests only; the service takes its real ones from the environment and refuses boot without them. */
const POLICY: RefreshPolicy = {
  mfaMaxAgeSeconds: 3600,
  privilegedMfaMaxAgeSeconds: 600,
  graceSeconds: 30,
  privilegedUserIds: [],
};

function totpNext(secret: string): string {
  const step = 30;
  const counter = Math.floor(Math.floor(Date.now() / 1000) / step);
  return totp(secret, { at: new Date((counter + 1) * step * 1000) });
}

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('refresh hardening (Postgres unavailable)', () => {
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
  const totpKey = randomBytes(32).toString('base64');
  const build = (policy: RefreshPolicy | undefined) =>
    new AuthService(db.sql, bus, rank, tokenConfig, webauthnConfig, totpKey, undefined, undefined, 25, policy);
  const auth = build(POLICY);

  let counter = 0;
  const unique = () => `rh${process.pid}${++counter}`;
  const register = async () => {
    const handle = unique();
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD, region: 'DE' });
    return { handle, session };
  };
  const claims = (s: SessionTokens) => verifyAccessToken(s.accessToken, tokenConfig);
  const liveSessions = async (userId: string) =>
    Number(
      (await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM sessions WHERE user_id = ${userId} AND revoked = false`)[0]!.n,
    );

  /** A password session turned into a second-factor session whose last real check was `ageSeconds` ago. */
  const mfaSessionAged = async (ageSeconds: number) => {
    const { handle, session } = await register();
    await db.sql`UPDATE sessions SET mfa = true, auth_time = now() - make_interval(secs => ${ageSeconds}) WHERE id = ${session.sessionId}`;
    return { handle, session };
  };

  beforeEach(async () => {
    bus.reset();
    await db.truncateAll();
    await rank.seedTiers();
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('auth_time and the MFA max age', () => {
    it('a real second-factor sign-in records auth_time as now, in the session and in the token', async () => {
      const { handle, session } = await register();
      const { secret } = await auth.startTotpEnrolment(session.userId, { mfa: false, privileged: false });
      await auth.confirmTotpEnrolment(session.userId, { mfa: false, privileged: false }, secret, totp(secret));
      const before = Math.floor(Date.now() / 1000);
      const signedIn = await auth.login({ identifier: handle, password: PASSWORD, totpCode: totpNext(secret) });
      const principal = await claims(signedIn);
      expect(principal.mfa).toBe(true);
      expect(principal.auth_time).toBeGreaterThanOrEqual(before - 1);
      expect(principal.auth_time).toBeLessThanOrEqual(before + 5);
      const row = await db.sql<
        Array<{ at: string }>
      >`SELECT extract(epoch from auth_time)::bigint::text AS at FROM sessions WHERE id = ${signedIn.sessionId}`;
      expect(Number(row[0]!.at)).toBe(principal.auth_time);
    });

    it('keeps mfa across a refresh inside the max age, and carries auth_time unchanged', async () => {
      const { session } = await mfaSessionAged(1800);
      const original = await db.sql<
        Array<{ at: string }>
      >`SELECT extract(epoch from auth_time)::bigint::text AS at FROM sessions WHERE id = ${session.sessionId}`;
      const first = await auth.refresh(session.refreshToken);
      const second = await auth.refresh(first.refreshToken);
      for (const refreshed of [first, second]) {
        const principal = await claims(refreshed);
        expect(principal.mfa).toBe(true);
        expect(principal.auth_time).toBe(Number(original[0]!.at));
      }
      const rows = await db.sql<
        Array<{ at: string }>
      >`SELECT extract(epoch from auth_time)::bigint::text AS at FROM sessions WHERE user_id = ${session.userId}`;
      expect(new Set(rows.map((r) => r.at)).size).toBe(1);
    });

    it('drops the mfa claim once the max age has passed, and it never comes back', async () => {
      const { session } = await mfaSessionAged(3600 + 120);
      const refreshed = await auth.refresh(session.refreshToken);
      const principal = await claims(refreshed);
      expect(principal.mfa).toBe(false);
      // auth_time is still the old sign-in: a refresh is not a sign-in.
      const aged = Math.floor(Date.now() / 1000) - (3600 + 120);
      expect(Math.abs(principal.auth_time! - aged)).toBeLessThan(10);
      const stored = await db.sql<Array<{ mfa: boolean }>>`SELECT mfa FROM sessions WHERE id = ${refreshed.sessionId}`;
      expect(stored[0]!.mfa).toBe(false);
      const again = await claims(await auth.refresh(refreshed.refreshToken));
      expect(again.mfa).toBe(false);
      expect(again.auth_time).toBe(principal.auth_time);
    });

    it('the founder pair gets the shorter max age', async () => {
      const founderMfa = await mfaSessionAged(1800); // inside 3600, outside 600
      const ordinaryMfa = await mfaSessionAged(1800);
      const authWithFounder = build({ ...POLICY, privilegedUserIds: [founderMfa.session.userId] });

      expect((await claims(await authWithFounder.refresh(ordinaryMfa.session.refreshToken))).mfa).toBe(true);
      expect((await claims(await authWithFounder.refresh(founderMfa.session.refreshToken))).mfa).toBe(false);
    });

    it('a founder inside the shorter max age keeps mfa', async () => {
      const founder = await mfaSessionAged(300);
      const authWithFounder = build({ ...POLICY, privilegedUserIds: [founder.session.userId] });
      expect((await claims(await authWithFounder.refresh(founder.session.refreshToken))).mfa).toBe(true);
    });

    it('a service built without a policy fails closed: refresh never carries mfa', async () => {
      const { session } = await mfaSessionAged(5);
      const unconfigured = build(undefined);
      expect((await claims(await unconfigured.refresh(session.refreshToken))).mfa).toBe(false);
    });

    it('a password-only session never gains mfa from a refresh', async () => {
      const { session } = await register();
      expect((await claims(await auth.refresh(session.refreshToken))).mfa).toBe(false);
    });
  });

  describe('refresh grace window', () => {
    const ageRotation = (retiredToken: string, seconds: number) =>
      db.sql`UPDATE session_refresh_grace SET rotated_at = now() - make_interval(secs => ${seconds}) WHERE retired_hash = ${hashToken(retiredToken)}`;

    it('a replay inside the window returns the same pair, and the pair keeps working', async () => {
      const { session } = await register();
      const firstTry = await auth.refresh(session.refreshToken); // the response that "got lost"
      const replay = await auth.refresh(session.refreshToken);
      expect(replay.refreshToken).toBe(firstTry.refreshToken);
      expect(replay.accessToken).toBe(firstTry.accessToken);
      expect(replay.sessionId).toBe(firstTry.sessionId);
      expect(replay.userId).toBe(firstTry.userId);
      expect(replay.expiresAt.getTime()).toBe(firstTry.expiresAt.getTime());
      await expect(claims(replay)).resolves.toMatchObject({ sid: firstTry.sessionId });

      const next = await auth.refresh(replay.refreshToken);
      expect(next.refreshToken).not.toBe(replay.refreshToken);
      expect(await liveSessions(session.userId)).toBe(1);
    });

    it('a replay inside the window leaves the person other devices signed in', async () => {
      const { handle, session } = await register();
      const phone = await auth.login({ identifier: handle, password: PASSWORD });
      await auth.refresh(session.refreshToken);
      await auth.refresh(session.refreshToken);
      expect(await liveSessions(session.userId)).toBe(2);
      await expect(auth.refresh(phone.refreshToken)).resolves.toBeTruthy();
    });

    it('a replay after the window is theft and revokes every session', async () => {
      const { handle, session } = await register();
      const phone = await auth.login({ identifier: handle, password: PASSWORD });
      const rotated = await auth.refresh(session.refreshToken);
      await ageRotation(session.refreshToken, 31);
      await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({ code: 'auth.session_reused' });
      expect(await liveSessions(session.userId)).toBe(0);
      await expect(auth.refresh(rotated.refreshToken)).rejects.toThrow();
      await expect(auth.refresh(phone.refreshToken)).rejects.toThrow();
    });

    it('a second replay inside the window revokes every session, including the successor', async () => {
      const { handle, session } = await register();
      const phone = await auth.login({ identifier: handle, password: PASSWORD });
      const rotated = await auth.refresh(session.refreshToken);
      await expect(auth.refresh(session.refreshToken)).resolves.toMatchObject({ refreshToken: rotated.refreshToken }); // once
      await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({ code: 'auth.session_reused' }); // twice
      expect(await liveSessions(session.userId)).toBe(0);
      await expect(auth.refresh(rotated.refreshToken)).rejects.toThrow();
      await expect(auth.refresh(phone.refreshToken)).rejects.toThrow();
    });

    it('a replay after the successor was already used is theft, not a lost response', async () => {
      const { session } = await register();
      const rotated = await auth.refresh(session.refreshToken);
      await auth.refresh(rotated.refreshToken); // the real holder carried on from the successor
      await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({ code: 'auth.session_reused' });
      expect(await liveSessions(session.userId)).toBe(0);
    });

    it('a replay from a different family is refused, returns nothing, and revokes nothing else', async () => {
      const { handle, session } = await register();
      await auth.login({ identifier: handle, password: PASSWORD }); // second device, its own family
      const rotated = await auth.refresh(session.refreshToken);
      const other = await db.sql<Array<{ family_id: string }>>`
        SELECT family_id FROM sessions WHERE user_id = ${session.userId} AND id <> ${session.sessionId} AND id <> ${rotated.sessionId}`;
      // The rotation record is pointed at a successor that belongs to the other device's family.
      await db.sql`UPDATE sessions SET family_id = ${other[0]!.family_id} WHERE id = ${rotated.sessionId}`;
      await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({ code: 'auth.session_invalid' });
      expect(await liveSessions(session.userId)).toBe(2);
    });

    it('a rotation record that names another family or another person is refused', async () => {
      const { session } = await register();
      const rotated = await auth.refresh(session.refreshToken);
      await db.sql`UPDATE session_refresh_grace SET family_id = gen_random_uuid() WHERE retired_hash = ${hashToken(session.refreshToken)}`;
      await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({ code: 'auth.session_invalid' });
      expect(await liveSessions(session.userId)).toBe(1);
      await expect(auth.refresh(rotated.refreshToken)).resolves.toBeTruthy();
    });

    it('a logged-out token is not a lost response: presenting it revokes every session', async () => {
      const { handle, session } = await register();
      await auth.login({ identifier: handle, password: PASSWORD });
      await auth.logout(session.refreshToken);
      await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({ code: 'auth.session_reused' });
      expect(await liveSessions(session.userId)).toBe(0);
    });

    it('logging out with the retired token also ends the successor', async () => {
      const { handle, session } = await register();
      const phone = await auth.login({ identifier: handle, password: PASSWORD });
      const rotated = await auth.refresh(session.refreshToken);
      await auth.logout(session.refreshToken); // the cookie the browser still holds
      // Only the phone (a different family) is left signed in.
      expect(await liveSessions(session.userId)).toBe(1);
      const live = await db.sql<Array<{ id: string }>>`SELECT id FROM sessions WHERE user_id = ${session.userId} AND revoked = false`;
      expect(live[0]!.id).toBe(phone.sessionId);
      await expect(auth.refresh(rotated.refreshToken)).rejects.toThrow();
    });

    it('with the window at zero a replay is always theft', async () => {
      const strict = build({ ...POLICY, graceSeconds: 0 });
      const { session } = await register();
      await strict.refresh(session.refreshToken);
      const stored = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM session_refresh_grace`;
      expect(stored[0]!.n).toBe('0');
      await expect(strict.refresh(session.refreshToken)).rejects.toMatchObject({ code: 'auth.session_reused' });
    });

    it('a service built without a policy grants no grace', async () => {
      const unconfigured = build(undefined);
      const { session } = await register();
      await unconfigured.refresh(session.refreshToken);
      await expect(unconfigured.refresh(session.refreshToken)).rejects.toMatchObject({ code: 'auth.session_reused' });
    });

    it('stores the successor sealed: neither token appears in the database, and the hash alone cannot open it', async () => {
      const { session } = await register();
      const rotated = await auth.refresh(session.refreshToken);
      const rows = await db.sql<Array<{ sealed: string; retired_hash: string }>>`SELECT sealed, retired_hash FROM session_refresh_grace`;
      expect(rows).toHaveLength(1);
      const dump = JSON.stringify(rows[0]);
      expect(dump).not.toContain(rotated.refreshToken);
      expect(dump).not.toContain(rotated.accessToken);
      const { sealed, retired_hash: retiredHash } = rows[0]!;
      expect(retiredHash).toBe(hashToken(session.refreshToken));
      // Opens with the retired token and the service secret...
      expect(openGracePayload(session.refreshToken, retiredHash, tokenConfig.secret, sealed)?.refreshToken).toBe(rotated.refreshToken);
      // ...and with nothing a database reader holds.
      expect(openGracePayload(retiredHash, retiredHash, tokenConfig.secret, sealed)).toBeNull();
      expect(openGracePayload(session.refreshToken, retiredHash, 'a-different-signing-secret-long-enough!!', sealed)).toBeNull();
      expect(openGracePayload(session.refreshToken, 'f'.repeat(64), tokenConfig.secret, sealed)).toBeNull();
    });

    it('prunes rotation records once their window is over', async () => {
      const { session } = await register();
      const first = await auth.refresh(session.refreshToken);
      await ageRotation(session.refreshToken, 3600);
      await auth.refresh(first.refreshToken);
      const left = await db.sql<Array<{ retired_hash: string }>>`SELECT retired_hash FROM session_refresh_grace`;
      expect(left.map((r) => r.retired_hash)).toEqual([hashToken(first.refreshToken)]);
    });

    it('refuses a frozen account and an unknown token as before', async () => {
      const { session } = await register();
      await expect(auth.refresh('not-a-real-token')).rejects.toMatchObject({ code: 'auth.session_invalid' });
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${session.userId}`;
      await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({ code: 'auth.account_frozen' });
    });
  });
}
