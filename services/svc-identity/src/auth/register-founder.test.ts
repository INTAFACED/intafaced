import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from './auth-service.js';
import { canonicalInvite, founderEnrolmentConfig, generateFounderInvites, type FounderEnrolmentConfig } from './founder-enrolment.js';
import { totp } from './totp.js';
import { RankService } from '../rank/rank-service.js';
import { createIdentityRouter } from '../router.js';

/**
 * Founder enrolment (`auth.registerFounder`, `auth.founderEnrolmentStatus`)
 * against real Postgres, through the real router.
 *
 * Every invite here is generated fresh inside the test and is never configured
 * anywhere else. Skips cleanly when Postgres is unreachable (same as
 * identity.test.ts).
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
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
const PASSWORD = 'correct horse battery staple';

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('founder enrolment (Postgres unavailable)', () => {
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
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, undefined, randomBytes(32).toString('base64'));
  const logged: string[] = [];
  auth.useLogger({ warn: (obj, msg) => void logged.push(JSON.stringify({ ...obj, msg })) });
  await rank.seedTiers();

  let clock = new Date('2026-10-14T00:00:00.000Z');
  let invites = generateFounderInvites(clock);
  let config: FounderEnrolmentConfig | undefined;
  let counter = 0;
  const unique = () => `f${process.pid}x${++counter}`;

  /** A router wired like index.ts, for the current `config` and `clock`. REGISTRATION_OPEN is unset unless asked. */
  const api = (opts: { registrationOpen?: boolean; invites?: FounderEnrolmentConfig | undefined } = {}) =>
    createIdentityRouter(auth, rank, {
      ...(opts.registrationOpen === undefined ? {} : { registrationOpen: opts.registrationOpen }),
      founderEnrolment: { invites: 'invites' in opts ? opts.invites : config, now: () => clock },
    }).createCaller({ principal: null, service: null, region: 'DE', requestId: 'req-founder' });

  const enrol = (invite: string, over: Partial<{ handle: string; email: string; password: string }> = {}, caller = api()) => {
    const handle = over.handle ?? unique();
    return caller.auth.registerFounder({
      invite,
      handle,
      email: over.email ?? `${handle}@example.com`,
      password: over.password ?? PASSWORD,
    });
  };

  const pinFounders = async () => {
    const [a, b] = await Promise.all([enrol(invites.codes[0]!), enrol(invites.codes[1]!)]);
    await db.sql`INSERT INTO founder_control_configuration (founder_ids) VALUES (${db.sql.array([a.userId, b.userId])}::uuid[])`;
    return [a.userId, b.userId] as const;
  };

  beforeEach(async () => {
    await db.truncateAll();
    logged.length = 0;
    clock = new Date('2026-10-14T00:00:00.000Z');
    invites = generateFounderInvites(clock);
    config = founderEnrolmentConfig(invites.hashes.join(','), invites.expiresAt);
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('auth.registerFounder', () => {
    it('creates an account and a password session (mfa false) and records the spent invite', async () => {
      const session = await enrol(invites.codes[0]!, { handle: 'founder_one', email: 'one@example.com' });
      expect(session.userId).toMatch(/^[0-9a-f-]{36}$/);
      expect(session.accessToken).toBeTruthy();
      expect(session.refreshToken).toBeTruthy();
      expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(clock.getTime() - 1);
      const principal = await verifyAccessToken(session.accessToken, tokenConfig);
      expect(principal.userId).toBe(session.userId);
      expect(principal.mfa).toBe(false);
      const users = await db.sql`SELECT handle, email, status FROM users WHERE id = ${session.userId}`;
      expect(users).toEqual([{ handle: 'founder_one', email: 'one@example.com', status: 'active' }]);
      const used = await db.sql`SELECT hash, user_id FROM founder_invites_used`;
      expect(used).toEqual([{ hash: invites.hashes[0], user_id: session.userId }]);
    });

    it('refuses a password equal to the handle, the email or its local part with auth.password_policy and spends nothing', async () => {
      const handle = unique();
      for (const password of [handle, `${handle}@example.com`, handle.toUpperCase()]) {
        await expect(
          auth.registerFounder({ invite: invites.codes[0]!, handle, email: `${handle}@example.com`, password }, config, clock),
        ).rejects.toMatchObject({ code: 'auth.password_policy' });
      }
      expect(await db.sql`SELECT count(*)::int AS n FROM users`).toEqual([{ n: 0 }]);
      expect(await db.sql`SELECT count(*)::int AS n FROM founder_invites_used`).toEqual([{ n: 0 }]);
      // The invite is still good for a valid password.
      await expect(enrol(invites.codes[0]!)).resolves.toMatchObject({ userId: expect.any(String) });
    });

    it('accepts the code however it is typed', async () => {
      const lower = invites.codes[0]!.toLowerCase().replaceAll('-', ' ');
      await expect(enrol(lower)).resolves.toMatchObject({ userId: expect.any(String) });
      await expect(enrol(canonicalInvite(invites.codes[1]!))).resolves.toMatchObject({ userId: expect.any(String) });
    });

    it('works while REGISTRATION_OPEN is off, and public register stays closed', async () => {
      for (const registrationOpen of [false, undefined]) {
        const caller = api({ registrationOpen });
        await expect(
          caller.auth.register({ handle: unique(), email: `${unique()}@example.com`, password: PASSWORD }),
        ).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|PRECONDITION_FAILED/) });
      }
      const founder = await enrol(invites.codes[0]!, {}, api({ registrationOpen: false }));
      expect(founder.userId).toBeTruthy();
      expect(await db.sql`SELECT count(*)::int AS n FROM users`).toEqual([{ n: 1 }]);
    });

    it('auth.invite_invalid: a wrong, malformed or recycled-hash code creates nothing', async () => {
      const other = generateFounderInvites(clock);
      for (const bad of [other.codes[0]!, 'not-a-code', invites.hashes[0]!, 'A'.repeat(32)]) {
        await expect(enrol(bad)).rejects.toMatchObject({ code: 'FORBIDDEN', cause: { code: 'auth.invite_invalid' } });
      }
      expect(await db.sql`SELECT count(*)::int AS n FROM users`).toEqual([{ n: 0 }]);
      expect(await db.sql`SELECT count(*)::int AS n FROM founder_invites_used`).toEqual([{ n: 0 }]);
    });

    it('auth.invite_used: a spent invite is refused, and the other invite still works', async () => {
      await enrol(invites.codes[0]!);
      await expect(enrol(invites.codes[0]!)).rejects.toMatchObject({ code: 'CONFLICT', cause: { code: 'auth.invite_used' } });
      await expect(enrol(invites.codes[1]!)).resolves.toMatchObject({ userId: expect.any(String) });
      expect(await db.sql`SELECT count(*)::int AS n FROM users`).toEqual([{ n: 2 }]);
    });

    it('a refused attempt leaves the invite usable (handle taken does not burn it)', async () => {
      await enrol(invites.codes[0]!, { handle: 'taken_one', email: 'a@example.com' });
      await expect(enrol(invites.codes[1]!, { handle: 'taken_one', email: 'b@example.com' })).rejects.toMatchObject({
        cause: { code: 'auth.handle_taken' },
      });
      expect(await db.sql`SELECT count(*)::int AS n FROM founder_invites_used`).toEqual([{ n: 1 }]);
      await expect(enrol(invites.codes[1]!, { handle: 'taken_two', email: 'b@example.com' })).resolves.toBeTruthy();
    });

    it('auth.invite_expired: refused at and after the expiry, still fine just before it', async () => {
      clock = new Date(new Date(invites.expiresAt).getTime() - 1);
      await expect(enrol(invites.codes[0]!)).resolves.toBeTruthy();
      clock = new Date(invites.expiresAt);
      await expect(enrol(invites.codes[1]!)).rejects.toMatchObject({ code: 'FORBIDDEN', cause: { code: 'auth.invite_expired' } });
      clock = new Date('2030-01-01T00:00:00Z');
      await expect(enrol(invites.codes[1]!)).rejects.toMatchObject({ cause: { code: 'auth.invite_expired' } });
      // A wrong code on an expired door is still just "invalid": expiry reveals nothing about guesses.
      await expect(enrol(generateFounderInvites().codes[0]!)).rejects.toMatchObject({ cause: { code: 'auth.invite_invalid' } });
    });

    it('auth.founder_enrolment_closed: not configured (nothing, or only half) is closed', async () => {
      for (const unset of [
        undefined,
        founderEnrolmentConfig(invites.hashes.join(','), undefined),
        founderEnrolmentConfig(undefined, invites.expiresAt),
      ]) {
        await expect(enrol(invites.codes[0]!, {}, api({ invites: unset }))).rejects.toMatchObject({
          code: 'FORBIDDEN',
          cause: { code: 'auth.founder_enrolment_closed' },
        });
      }
      expect(await db.sql`SELECT count(*)::int AS n FROM users`).toEqual([{ n: 0 }]);
    });

    it('auth.founder_enrolment_closed: refuses forever once the founder pair is pinned', async () => {
      await pinFounders();
      // Even a fresh, valid, unspent, unexpired invite is refused.
      const fresh = generateFounderInvites(clock);
      const freshConfig = founderEnrolmentConfig(fresh.hashes.join(','), fresh.expiresAt);
      await expect(enrol(fresh.codes[0]!, {}, api({ invites: freshConfig }))).rejects.toMatchObject({
        cause: { code: 'auth.founder_enrolment_closed' },
      });
      // A spent invite reads as closed too, not as "used": closed is checked first.
      await expect(enrol(invites.codes[0]!)).rejects.toMatchObject({ cause: { code: 'auth.founder_enrolment_closed' } });
      clock = new Date('2031-01-01T00:00:00Z');
      await expect(enrol(fresh.codes[1]!, {}, api({ invites: freshConfig }))).rejects.toMatchObject({
        cause: { code: 'auth.founder_enrolment_closed' },
      });
      expect(await db.sql`SELECT count(*)::int AS n FROM users`).toEqual([{ n: 2 }]);
    });

    it('rejects a weak password or bad handle before anything is consumed', async () => {
      await expect(enrol(invites.codes[0]!, { password: 'short' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(enrol(invites.codes[0]!, { handle: 'no spaces!' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await db.sql`SELECT count(*)::int AS n FROM founder_invites_used`).toEqual([{ n: 0 }]);
    });

    it('RACE: parallel enrolments with the same invite give exactly one winner and one account', async () => {
      for (let round = 0; round < 3; round += 1) {
        await db.truncateAll();
        const fresh = generateFounderInvites(clock);
        const cfg = founderEnrolmentConfig(fresh.hashes.join(','), fresh.expiresAt);
        const caller = api({ invites: cfg });
        const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () => enrol(fresh.codes[0]!, {}, caller)));
        const won = outcomes.filter((o) => o.status === 'fulfilled');
        const lost = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(5);
        for (const l of lost) expect(l.reason).toMatchObject({ code: 'CONFLICT', cause: { code: 'auth.invite_used' } });
        expect(await db.sql`SELECT count(*)::int AS n FROM users`).toEqual([{ n: 1 }]);
        expect(await db.sql`SELECT count(*)::int AS n FROM founder_invites_used`).toEqual([{ n: 1 }]);
        expect(await db.sql`SELECT count(*)::int AS n FROM profiles`).toEqual([{ n: 1 }]);
      }
    });

    it('RACE: same invite AND same handle/email still gives one winner, with a clean refusal', async () => {
      const handle = unique();
      const outcomes = await Promise.allSettled(
        Array.from({ length: 4 }, () => enrol(invites.codes[0]!, { handle, email: `${handle}@example.com` })),
      );
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      for (const o of outcomes) {
        if (o.status === 'rejected')
          expect(o.reason).toMatchObject({ cause: { code: expect.stringMatching(/^auth\.(invite_used|handle_taken|email_taken)$/) } });
      }
      expect(await db.sql`SELECT count(*)::int AS n FROM users`).toEqual([{ n: 1 }]);
    });

    it('RACE: the two founders enrolling at once each get an account', async () => {
      const [a, b] = await Promise.all([enrol(invites.codes[0]!), enrol(invites.codes[1]!)]);
      expect(a.userId).not.toBe(b.userId);
      expect(await db.sql`SELECT count(*)::int AS n FROM founder_invites_used`).toEqual([{ n: 2 }]);
    });

    it('the spent-invite history cannot be edited or deleted (a spent invite cannot be revived)', async () => {
      await enrol(invites.codes[0]!);
      await expect(db.sql`DELETE FROM founder_invites_used`).rejects.toThrow(/immutable/);
      await expect(db.sql`UPDATE founder_invites_used SET used_at = now()`).rejects.toThrow(/immutable/);
    });

    it('writes the audit event founder.enrolled {userId} and logs no invite, password or hash', async () => {
      const handle = unique();
      const email = `${handle}@example.com`;
      const secretPassword = 'a-very-unlikely-password-value-91823';
      const session = await enrol(invites.codes[0]!, { handle, email, password: secretPassword });
      await expect(enrol(invites.codes[0]!)).rejects.toBeTruthy();
      await expect(enrol('WRONG-CODE-WRONG-CODE-WRONG-CODE-12')).rejects.toBeTruthy();
      expect(logged).toContainEqual(JSON.stringify({ audit: 'founder.enrolled', userId: session.userId, msg: 'founder.enrolled' }));
      const everything = logged.join('\n');
      for (const secret of [
        canonicalInvite(invites.codes[0]!),
        invites.codes[0]!,
        invites.hashes[0]!,
        invites.hashes[1]!,
        secretPassword,
        email,
      ]) {
        expect(everything).not.toContain(secret);
      }
    });

    it('the new account is not privileged: its first TOTP enrols the normal way, then login needs the code', async () => {
      const session = await enrol(invites.codes[0]!, { handle: 'first_totp', email: 'first_totp@example.com' });
      const ctx: Context = {
        principal: await verifyAccessToken(session.accessToken, tokenConfig),
        service: null,
        region: 'DE',
        requestId: 'req-totp',
      };
      // privilegedUserIds is empty: the pair is not pinned, so factor-gate lets a password session enrol.
      const authed = createIdentityRouter(auth, rank, { founderEnrolment: { invites: config, now: () => clock } }).createCaller(ctx);
      const started = await authed.totp.enrol();
      expect(started.secret.length).toBeGreaterThanOrEqual(16);
      expect(started.recoveryCodes).toHaveLength(10);
      await expect(authed.totp.confirm({ secret: started.secret, code: totp(started.secret) })).resolves.toEqual({ ok: true });
      const [row] = await db.sql<
        Array<{ enrolled: boolean }>
      >`SELECT totp_enrolled_at IS NOT NULL AS enrolled FROM users WHERE id = ${session.userId}`;
      expect(row?.enrolled).toBe(true);
      // Password alone no longer signs in: the code is required, and a recovery code works.
      await expect(auth.login({ identifier: 'first_totp', password: PASSWORD })).rejects.toMatchObject({ code: 'auth.mfa_required' });
      const recovery = await auth.login({ identifier: 'first_totp', password: PASSWORD, totpCode: started.recoveryCodes[0]! });
      expect((await verifyAccessToken(recovery.accessToken, tokenConfig)).mfa).toBe(true);
    });
  });

  describe('auth.founderEnrolmentStatus', () => {
    const status = (caller = api()) => caller.auth.founderEnrolmentStatus();

    it('is { open: true } and nothing else while invites are configured, unexpired and unspent', async () => {
      expect(await status()).toEqual({ open: true });
    });

    it('stays open while one invite is left, and closes when both are spent', async () => {
      await enrol(invites.codes[0]!);
      expect(await status()).toEqual({ open: true });
      await enrol(invites.codes[1]!);
      expect(await status()).toEqual({ open: false });
    });

    it('is closed when not configured, half configured, or past the expiry', async () => {
      expect(await status(api({ invites: undefined }))).toEqual({ open: false });
      expect(await status(api({ invites: founderEnrolmentConfig(invites.hashes.join(','), undefined) }))).toEqual({ open: false });
      clock = new Date(new Date(invites.expiresAt).getTime() - 1);
      expect(await status()).toEqual({ open: true });
      clock = new Date(invites.expiresAt);
      expect(await status()).toEqual({ open: false });
    });

    it('is closed once the founder pair is pinned, even with fresh invites', async () => {
      await pinFounders();
      const fresh = generateFounderInvites(clock);
      expect(await status(api({ invites: founderEnrolmentConfig(fresh.hashes.join(','), fresh.expiresAt) }))).toEqual({ open: false });
    });

    it('does not depend on REGISTRATION_OPEN', async () => {
      expect(await status(api({ registrationOpen: false }))).toEqual({ open: true });
      expect(await status(api({ registrationOpen: true }))).toEqual({ open: true });
    });
  });
}
