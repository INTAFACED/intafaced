/**
 * Profile edit, email change, and phone change against Postgres.
 *
 * The database name must end in `_test`. The shared env file points at `/test`,
 * which assertTestDatabase refuses, so a non-`_test` name is rewritten to
 * `intafaced_test` on the same server.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyAccessToken } from '@intafaced/auth';
import { mergeRouters, TRPCError, type Context } from '@intafaced/contracts';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { createIdentityRouter } from '../router.js';
import { createStepUpRouter } from '../step-up-router.js';
import { AccountChange } from './account-router.js';
import type { ContactDeps } from './contact-common.js';
import type { PhoneCodeSender } from './phone-change.js';
import { hashToken } from '../auth/passwords.js';
import { ActionApprovalService } from '../auth/action-approval-service.js';
import { SqlActionApprovalStore } from '../auth/action-approval-store.js';
import { AuthService, type SessionTokens } from '../auth/auth-service.js';
import { CustomerStepUpService } from '../auth/customer-step-up.js';
import { SqlCustomerStepUpStore } from '../auth/customer-step-up-store.js';
import { totp } from '../auth/totp.js';
import { ProfileService } from '../profile/profile-service.js';

function identityTestUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const parsed = new globalThis.URL(raw);
  if (!parsed.pathname.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

const DATABASE_URL = identityTestUrl();
const PASSWORD = 'correct horse battery staple';
const EMAIL_SCOPE = 'identity.step_up.email_change' as const;
const PHONE_SCOPE = 'identity.step_up.phone_change' as const;
const REMOVE_SCOPE = 'identity.step_up.phone_remove' as const;

const tokenConfig = {
  secret: 'an-identity-account-controls-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const webauthnConfig = { rpID: 'localhost', rpName: 'INTAFACED', origin: 'http://localhost:3000' };

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

type SentMail = { email: string; code: string; purpose?: string; userId?: string };
type SentPhone = { phone: string; code: string; purpose: string };

const available = await postgresAvailable(DATABASE_URL);

if (!available) {
  describe.skip('account controls (Postgres unavailable)', () => {
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
  const approvals = new ActionApprovalService(new SqlActionApprovalStore(db.sql), { ttlSeconds: 60 });
  const stepUps = new CustomerStepUpService(db.sql, new SqlCustomerStepUpStore(db.sql), auth);
  const profile = new ProfileService(db.sql);
  const sentMail: SentMail[] = [];
  const sentPhone: SentPhone[] = [];
  const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  let failEmailNotice = false;
  let failPhoneNotice = false;
  const mail = {
    async send(message: SentMail & { expiresAt: Date }) {
      if (failEmailNotice && message.purpose === 'email-change-notice') {
        const leaked = sentMail.find((row) => row.purpose === 'email-change')?.code ?? 'none';
        throw new Error(`smtp down ${leaked}`);
      }
      sentMail.push({ email: message.email, code: message.code, purpose: message.purpose, userId: message.userId });
    },
  };
  const phoneSender: PhoneCodeSender = {
    async send(message) {
      if (failPhoneNotice && message.purpose === 'phone-notice') {
        const leaked = sentPhone.find((row) => row.purpose === 'phone-change')?.code ?? 'none';
        throw new Error(`sms down ${leaked}`);
      }
      sentPhone.push({ phone: message.phone, code: message.code, purpose: message.purpose });
    },
  };
  const deps: ContactDeps = {
    sql: db.sql,
    approvals,
    mail,
    phone: undefined as PhoneCodeSender | undefined,
    ttlSeconds: 600 as number | undefined,
    maxAttempts: 5 as number | undefined,
    now: () => new Date(),
    log: {
      warn(obj: Record<string, unknown>, msg: string) {
        warnings.push({ obj, msg });
      },
    },
  };
  const confirmedInvites: string[] = [];
  const account = new AccountChange(deps);
  account.email.useOnConfirmed(async (userId) => {
    confirmedInvites.push(userId);
  });
  const api = mergeRouters(createIdentityRouter(auth, rank, { registrationOpen: true, profile, account }), createStepUpRouter(stepUps));

  let n = 0;
  const unique = () => `ac${process.pid}x${++n}`;

  beforeEach(async () => {
    await db.truncateAll();
    await rank.seedTiers();
    sentMail.length = 0;
    sentPhone.length = 0;
    warnings.length = 0;
    confirmedInvites.length = 0;
    failEmailNotice = false;
    failPhoneNotice = false;
    deps.mail = mail;
    deps.phone = undefined;
    deps.ttlSeconds = 600;
    deps.maxAttempts = 5;
  });

  afterAll(async () => {
    await db.drop();
  });

  async function ctxOf(tokens: SessionTokens, extra: Record<string, unknown> = {}): Promise<Context> {
    const principal = await verifyAccessToken(tokens.accessToken, tokenConfig);
    return { principal: { ...principal, ...extra }, service: null, region: 'DE', requestId: 'req-identacct' };
  }

  const callerOf = async (tokens: SessionTokens, extra?: Record<string, unknown>) => api.createCaller(await ctxOf(tokens, extra));

  async function register(region = 'DE') {
    const handle = unique();
    const email = `${handle}@example.com`;
    const session = await auth.register({ handle, email, password: PASSWORD, region });
    return { ...session, handle, email };
  }

  async function enrolTotp(userId: string) {
    const started = await auth.startTotpEnrolment(userId, { mfa: false, privileged: false });
    await auth.confirmTotpEnrolment(userId, { mfa: false, privileged: false }, started.secret, totp(started.secret));
    return started.secret;
  }

  function nextCode(secret: string): string {
    const step = 30;
    const counter = Math.floor(Math.floor(Date.now() / 1000) / step);
    return totp(secret, { at: new Date((counter + 1) * step * 1000) });
  }

  async function mint(
    tokens: SessionTokens,
    scope: typeof EMAIL_SCOPE | typeof PHONE_SCOPE | typeof REMOVE_SCOPE,
    purpose: string,
    field: string,
    value: string,
    secret: string,
  ) {
    const caller = await callerOf(tokens);
    const begun = await caller.stepUp.begin({
      scope,
      purpose,
      target: value,
      fields: { [field]: value },
    });
    const done = await caller.stepUp.complete({ challengeId: begun.challengeId, totpCode: nextCode(secret) });
    return done.stepUpApprovalId;
  }

  async function refusal(run: Promise<unknown>) {
    try {
      await run;
    } catch (err) {
      const wrapped = err as TRPCError & {
        cause?: { code?: string; profile?: { displayName: string | null; locale: string; region: string | null; version: number } };
      };
      return { trpc: wrapped.code, code: wrapped.cause?.code, message: wrapped.message, profile: wrapped.cause?.profile };
    }
    throw new Error('expected a refusal');
  }

  async function proofCount(userId: string) {
    const rows = await db.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM contact_change_proofs WHERE user_id = ${userId}
    `;
    return rows[0]?.n ?? 0;
  }

  describe('profile.get and profile.update', () => {
    it('round-trips a display name and locale, and resolveHandle still returns no display name', async () => {
      const user = await register();
      const caller = await callerOf(user);
      expect(await caller.profile.get()).toMatchObject({ displayName: user.handle, locale: 'en', region: 'DE', version: 0 });
      const updated = await caller.profile.update({ displayName: '  Ada Lovelace  ', locale: 'fr', ifVersion: 0, userId: 'ignored' });
      expect(updated).toMatchObject({ displayName: 'Ada Lovelace', locale: 'fr', region: 'DE', version: 1 });
      expect(await caller.profile.get()).toEqual(updated);
      const resolved = await caller.users.resolveHandle({ handle: user.handle });
      expect(resolved).toEqual({ found: true, userId: user.userId, handle: user.handle, self: true });
      expect(resolved).not.toHaveProperty('displayName');
      const audit = await db.sql<Array<{ fields: string[]; old_display_name: string; new_display_name: string; session_id: string }>>`
        SELECT fields, old_display_name, new_display_name, session_id::text FROM profile_audit WHERE user_id = ${user.userId}
      `;
      expect(audit).toHaveLength(1);
      expect(audit[0]?.fields).toEqual(['displayName', 'locale']);
      expect(audit[0]?.old_display_name).toBe(user.handle);
      expect(audit[0]?.new_display_name).toBe('Ada Lovelace');
      expect(audit[0]?.session_id).toBe((await verifyAccessToken(user.accessToken, tokenConfig)).sid);
    });

    it('refuses a stale version and changes nothing', async () => {
      const user = await register();
      const caller = await callerOf(user);
      await caller.profile.update({ displayName: 'Kept', ifVersion: 0 });
      const refused = await refusal(caller.profile.update({ displayName: 'Other', ifVersion: 0 }));
      expect(refused).toMatchObject({ trpc: 'CONFLICT', code: 'identity.profile_version_conflict' });
      expect(refused.profile).toMatchObject({ displayName: 'Kept', version: 1 });
      expect(await caller.profile.get()).toMatchObject({ displayName: 'Kept', version: 1 });
    });

    it('keeps user B on their own row, even if the body names user A', async () => {
      const a = await register();
      const b = await register();
      await (await callerOf(a)).profile.update({ displayName: 'Only A', ifVersion: 0 });
      const bCaller = await callerOf(b);
      expect((await bCaller.profile.get()).displayName).toBe(b.handle);
      await bCaller.profile.update({ displayName: 'Only B', ifVersion: 0, userId: a.userId });
      expect((await (await callerOf(a)).profile.get()).displayName).toBe('Only A');
      expect((await bCaller.profile.get()).displayName).toBe('Only B');
    });

    it('refuses an API key and a sub-account', async () => {
      const user = await register();
      const viaKey = await callerOf(user, { kid: '55555555-5555-4555-8555-555555555555' });
      const viaSub = await callerOf(user, { sub_account: '66666666-6666-4666-8666-666666666666' });
      expect(await refusal(viaKey.profile.get())).toMatchObject({ trpc: 'FORBIDDEN', code: 'identity.delegated_refused' });
      expect(await refusal(viaSub.profile.update({ displayName: 'Nope', ifVersion: 0 }))).toMatchObject({
        code: 'identity.delegated_refused',
      });
      expect((await (await callerOf(user)).profile.get()).displayName).toBe(user.handle);
    });

    it('refuses a region change', async () => {
      const user = await register();
      const refused = await refusal((await callerOf(user)).profile.update({ region: 'US', ifVersion: 0 }));
      expect(refused.code).toBe('identity.region_change_requires_review');
      expect((await (await callerOf(user)).profile.get()).region).toBe('DE');
    });

    it("refuses a display name that matches someone else's handle, and hidden characters", async () => {
      const a = await register();
      const b = await register();
      const caller = await callerOf(a);
      expect((await refusal(caller.profile.update({ displayName: b.handle.toUpperCase(), ifVersion: 0 }))).code).toBe(
        'identity.handle_impersonation',
      );
      expect((await refusal(caller.profile.update({ displayName: 'Ann\u0000a', ifVersion: 0 }))).code).toBe(
        'identity.display_name_invalid',
      );
      expect((await refusal(caller.profile.update({ displayName: 'Ann\u200Ba', ifVersion: 0 }))).code).toBe(
        'identity.display_name_invalid',
      );
      expect((await refusal(caller.profile.update({ displayName: 'Ann\u202Ee', ifVersion: 0 }))).code).toBe(
        'identity.display_name_invalid',
      );
      expect((await refusal(caller.profile.update({ displayName: '   ', ifVersion: 0 }))).code).toBe('identity.display_name_invalid');
      expect((await caller.profile.get()).version).toBe(0);
      await caller.profile.update({ displayName: 'Own Name', ifVersion: 0 });
      await caller.profile.update({ displayName: a.handle, ifVersion: 1 });
      expect((await caller.profile.get()).displayName).toBe(a.handle);
    });

    it('refuses an unknown locale', async () => {
      const user = await register();
      const refused = await refusal((await callerOf(user)).profile.update({ locale: 'zz', ifVersion: 0 }));
      expect(refused.code).toBe('identity.locale_unsupported');
    });
  });

  describe('account.email', () => {
    it('refuses begin with no approval and stores nothing', async () => {
      const user = await register();
      const refused = await refusal(
        (await callerOf(user)).account.email.begin({
          newEmail: 'fresh@example.com',
          stepUpApprovalId: '11111111-1111-4111-8111-111111111111',
        }),
      );
      expect(refused.code).toBe('identity.step_up_required');
      expect(await proofCount(user.userId)).toBe(0);
    });

    it('refuses an expired approval and stores nothing', async () => {
      const user = await register();
      const secret = await enrolTotp(user.userId);
      const approval = await mint(user, EMAIL_SCOPE, 'account.email.change', 'newEmail', 'fresh@example.com', secret);
      await db.sql`UPDATE action_approvals SET expires_at = now() - interval '1 second' WHERE approval_id = ${approval}`;
      const refused = await refusal(
        (await callerOf(user)).account.email.begin({ newEmail: 'fresh@example.com', stepUpApprovalId: approval }),
      );
      expect(refused.code).toBe('identity.step_up_expired');
      expect(await proofCount(user.userId)).toBe(0);
    });

    it("refuses another user's approval and stores nothing", async () => {
      const user = await register();
      const other = await register();
      const otherSecret = await enrolTotp(other.userId);
      const theirs = await mint(other, EMAIL_SCOPE, 'account.email.change', 'newEmail', 'other@example.com', otherSecret);
      const refused = await refusal(
        (await callerOf(user)).account.email.begin({ newEmail: 'other@example.com', stepUpApprovalId: theirs }),
      );
      expect(refused.code).toBe('identity.step_up_not_yours');
      expect(await proofCount(user.userId)).toBe(0);
      expect(await proofCount(other.userId)).toBe(0);
    });

    it('refuses an approval bound to a different email and stores nothing', async () => {
      const user = await register();
      const secret = await enrolTotp(user.userId);
      const approval = await mint(user, EMAIL_SCOPE, 'account.email.change', 'newEmail', 'one@example.com', secret);
      const refused = await refusal(
        (await callerOf(user)).account.email.begin({ newEmail: 'two@example.com', stepUpApprovalId: approval }),
      );
      expect(refused.code).toBe('identity.step_up_target');
      expect(await proofCount(user.userId)).toBe(0);
    });

    it('refuses a used approval and does not store a second proof', async () => {
      const user = await register();
      const secret = await enrolTotp(user.userId);
      const caller = await callerOf(user);
      const used = await mint(user, EMAIL_SCOPE, 'account.email.change', 'newEmail', 'used@example.com', secret);
      expect(await caller.account.email.begin({ newEmail: 'used@example.com', stepUpApprovalId: used })).toEqual({ accepted: true });
      expect((await refusal(caller.account.email.begin({ newEmail: 'used@example.com', stepUpApprovalId: used }))).code).toBe(
        'identity.step_up_used',
      );
      expect(await proofCount(user.userId)).toBe(1);
    });

    it('swaps once, tells the old address, revokes other sessions, and kills open reset proofs', async () => {
      const user = await register();
      const secret = await enrolTotp(user.userId);
      const caller = await callerOf(user);
      const sid = (await verifyAccessToken(user.accessToken, tokenConfig)).sid;
      const before = await db.sql<Array<{ password_hash: string; totp_secret: string }>>`
        SELECT password_hash, totp_secret FROM users WHERE id = ${user.userId}
      `;
      const otherSession = await db.sql<Array<{ id: string }>>`
        INSERT INTO sessions (user_id, refresh_hash, expires_at, mfa)
        VALUES (${user.userId}, ${hashToken('other-session')}, now() + interval '1 day', true)
        RETURNING id
      `;
      await db.sql`
        INSERT INTO password_reset_proofs (user_id, code_hash, expires_at)
        VALUES (${user.userId}, ${hashToken('reset-code')}, now() + interval '1 hour')
      `;
      const next = 'next@example.com';
      const approval = await mint(user, EMAIL_SCOPE, 'account.email.change', 'newEmail', next, secret);
      expect(await caller.account.email.begin({ newEmail: `  ${next.toUpperCase()}  `, stepUpApprovalId: approval })).toEqual({
        accepted: true,
      });
      const code = sentMail.find((row) => row.purpose === 'email-change')?.code ?? '';
      expect(code.length).toBeGreaterThan(20);
      expect(await caller.account.email.confirm({ code })).toEqual({ ok: true });
      expect((await refusal(caller.account.email.confirm({ code }))).code).toBe('identity.contact_code_invalid');
      const row = await db.sql<Array<{ email: string; password_hash: string; totp_secret: string; email_verified_at: Date | null }>>`
        SELECT email, password_hash, totp_secret, email_verified_at FROM users WHERE id = ${user.userId}
      `;
      expect(row[0]?.email).toBe(next);
      expect(row[0]?.password_hash).toBe(before[0]?.password_hash);
      expect(row[0]?.totp_secret).toBe(before[0]?.totp_secret);
      expect(row[0]?.email_verified_at).not.toBeNull();
      expect(confirmedInvites).toEqual([user.userId]);
      const sessions = await db.sql<Array<{ id: string; revoked: boolean }>>`
        SELECT id, revoked FROM sessions WHERE user_id = ${user.userId}
      `;
      expect(sessions.find((s) => s.id === sid)?.revoked).toBe(false);
      expect(sessions.find((s) => s.id === otherSession[0]?.id)?.revoked).toBe(true);
      const resets = await db.sql<Array<{ consumed_at: Date | null }>>`
        SELECT consumed_at FROM password_reset_proofs WHERE user_id = ${user.userId}
      `;
      expect(resets[0]?.consumed_at).not.toBeNull();
      const audit = await db.sql<Array<{ event: string; old_notice: string | null }>>`
        SELECT event, old_notice FROM contact_change_audit WHERE user_id = ${user.userId} ORDER BY created_at
      `;
      expect(audit.map((row) => row.event)).toEqual(['begin', 'confirm']);
      expect(audit[1]?.old_notice).toBe('sent');
      expect(JSON.stringify(warnings)).not.toContain(code);
      expect(JSON.stringify(audit)).not.toContain(code);
      await db.sql`UPDATE users SET totp_last_step = NULL WHERE id = ${user.userId}`;
      await expect(auth.login({ identifier: user.email, password: PASSWORD, totpCode: totp(secret) })).rejects.toMatchObject({
        code: 'auth.invalid_credentials',
      });
      expect((await auth.login({ identifier: next, password: PASSWORD, totpCode: totp(secret) })).userId).toBe(user.userId);
    });

    it('locks the proof after five wrong codes', async () => {
      const user = await register();
      const secret = await enrolTotp(user.userId);
      const caller = await callerOf(user);
      const approval = await mint(user, EMAIL_SCOPE, 'account.email.change', 'newEmail', 'five@example.com', secret);
      await caller.account.email.begin({ newEmail: 'five@example.com', stepUpApprovalId: approval });
      const code = sentMail[0]?.code ?? '';
      for (let i = 0; i < 5; i += 1) {
        expect((await refusal(caller.account.email.confirm({ code: `wrong-${i}` }))).code).toBe('identity.contact_code_invalid');
      }
      expect((await refusal(caller.account.email.confirm({ code }))).code).toBe('identity.contact_code_invalid');
      const email = await db.sql<Array<{ email: string }>>`SELECT email FROM users WHERE id = ${user.userId}`;
      expect(email[0]?.email).toBe(user.email);
      expect(JSON.stringify(warnings)).not.toContain(code);
    });

    it('answers a taken address the same as a free one', async () => {
      const taken = await register();
      const freeUser = await register();
      const freeSecret = await enrolTotp(freeUser.userId);
      const free = await mint(freeUser, EMAIL_SCOPE, 'account.email.change', 'newEmail', 'free@example.com', freeSecret);
      const freeReply = await (await callerOf(freeUser)).account.email.begin({ newEmail: 'free@example.com', stepUpApprovalId: free });
      const other = await register();
      const otherSecret = await enrolTotp(other.userId);
      const occupied = await mint(other, EMAIL_SCOPE, 'account.email.change', 'newEmail', taken.email, otherSecret);
      const occupiedReply = await (await callerOf(other)).account.email.begin({ newEmail: taken.email, stepUpApprovalId: occupied });
      expect(occupiedReply).toEqual(freeReply);
    });

    it('answers a duplicate address like a wrong code', async () => {
      const taken = await register();
      const user = await register();
      const secret = await enrolTotp(user.userId);
      const caller = await callerOf(user);
      const swap = await mint(user, EMAIL_SCOPE, 'account.email.change', 'newEmail', taken.email, secret);
      await caller.account.email.begin({ newEmail: taken.email, stepUpApprovalId: swap });
      const code = sentMail.find((row) => row.email === taken.email && row.purpose === 'email-change')?.code ?? '';
      const refused = await refusal(caller.account.email.confirm({ code }));
      expect(refused.code).toBe('identity.contact_code_invalid');
      expect(refused.message).not.toContain(code);
      const emails = await db.sql<Array<{ email: string }>>`SELECT email FROM users WHERE id = ${user.userId}`;
      expect(emails[0]?.email).toBe(user.email);
    });

    it('refuses an unwired mail port or a blank TTL and stores nothing', async () => {
      const user = await register();
      const secret = await enrolTotp(user.userId);
      const approval = await mint(user, EMAIL_SCOPE, 'account.email.change', 'newEmail', 'wire@example.com', secret);
      deps.mail = undefined;
      const unwired = await refusal(
        (await callerOf(user)).account.email.begin({ newEmail: 'wire@example.com', stepUpApprovalId: approval }),
      );
      expect(unwired.code).toBe('auth.change_unwired');
      expect(unwired.message).toContain('IDENTITY_MAIL_TRANSPORT');
      deps.mail = mail;
      deps.ttlSeconds = undefined;
      const noTtl = await refusal((await callerOf(user)).account.email.begin({ newEmail: 'wire@example.com', stepUpApprovalId: approval }));
      expect(noTtl.code).toBe('auth.change_unwired');
      expect(noTtl.message).toContain('IDENTITY_CONTACT_CHANGE_TTL_SECONDS');
      deps.ttlSeconds = 600;
      deps.maxAttempts = undefined;
      const noCap = await refusal((await callerOf(user)).account.email.begin({ newEmail: 'wire@example.com', stepUpApprovalId: approval }));
      expect(noCap.code).toBe('auth.change_unwired');
      expect(noCap.message).toContain('IDENTITY_CONTACT_CHANGE_MAX_ATTEMPTS');
      expect(await proofCount(user.userId)).toBe(0);
      const status = await db.sql<Array<{ status: string }>>`SELECT status FROM action_approvals WHERE approval_id = ${approval}`;
      expect(status[0]?.status).toBe('APPROVED');
    });

    it('records a failed old-address notice and still keeps the new email', async () => {
      const user = await register();
      const secret = await enrolTotp(user.userId);
      failEmailNotice = true;
      const approval = await mint(user, EMAIL_SCOPE, 'account.email.change', 'newEmail', 'kept@example.com', secret);
      const caller = await callerOf(user);
      await caller.account.email.begin({ newEmail: 'kept@example.com', stepUpApprovalId: approval });
      const code = sentMail[0]?.code ?? '';
      expect(await caller.account.email.confirm({ code })).toEqual({ ok: true });
      const audit = await db.sql<Array<{ old_notice: string }>>`
        SELECT old_notice FROM contact_change_audit WHERE user_id = ${user.userId} AND event = 'confirm'
      `;
      expect(audit[0]?.old_notice).toBe('failed');
      expect(JSON.stringify(warnings)).not.toContain(code);
      const email = await db.sql<Array<{ email: string }>>`SELECT email FROM users WHERE id = ${user.userId}`;
      expect(email[0]?.email).toBe('kept@example.com');
    });

    it('names the account on the old-address notice only when that address was proved (the anti-phishing code rides on it)', async () => {
      const notices: Array<string | undefined> = [];
      for (const proved of [false, true]) {
        const user = await register();
        await db.sql`UPDATE users SET email_verified_at = ${proved ? new Date() : null} WHERE id = ${user.userId}`;
        const secret = await enrolTotp(user.userId);
        const target = `moved-${proved}-${user.handle}@example.com`;
        const approval = await mint(user, EMAIL_SCOPE, 'account.email.change', 'newEmail', target, secret);
        const caller = await callerOf(user);
        sentMail.length = 0;
        await caller.account.email.begin({ newEmail: target, stepUpApprovalId: approval });
        expect(await caller.account.email.confirm({ code: sentMail[0]?.code ?? '' })).toEqual({ ok: true });
        const notice = sentMail.find((m) => m.purpose === 'email-change-notice');
        expect(notice?.email).toBe(user.email);
        notices.push(notice?.userId === user.userId ? 'named' : notice?.userId);
      }
      expect(notices).toEqual([undefined, 'named']);
    });

    it('refuses an API key and a sub-account', async () => {
      const user = await register();
      const viaKey = await callerOf(user, { kid: '55555555-5555-4555-8555-555555555555' });
      const viaSub = await callerOf(user, { sub_account: '66666666-6666-4666-8666-666666666666' });
      expect(
        (await refusal(viaKey.account.email.begin({ newEmail: 'a@b.co', stepUpApprovalId: '11111111-1111-4111-8111-111111111111' }))).code,
      ).toBe('identity.delegated_refused');
      expect((await refusal(viaSub.account.email.confirm({ code: 'nope' }))).code).toBe('identity.delegated_refused');
      expect(await proofCount(user.userId)).toBe(0);
    });
  });

  describe('account.phone', () => {
    it('refuses an unwired sender and writes no row', async () => {
      const user = await register();
      const secret = await enrolTotp(user.userId);
      const approval = await mint(user, PHONE_SCOPE, 'account.phone.change', 'newPhone', '+14155552671', secret);
      const refused = await refusal((await callerOf(user)).account.phone.begin({ newPhone: '+14155552671', stepUpApprovalId: approval }));
      expect(refused.code).toBe('auth.change_unwired');
      expect(refused.message).toContain('phone code sender');
      expect(await proofCount(user.userId)).toBe(0);
      const phones = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM user_phones`;
      expect(phones[0]?.n).toBe(0);
    });

    it('confirms, ignores a replay, locks five wrong codes, and refuses a duplicate number', async () => {
      deps.phone = phoneSender;
      const user = await register();
      const secret = await enrolTotp(user.userId);
      const caller = await callerOf(user);
      const approval = await mint(user, PHONE_SCOPE, 'account.phone.change', 'newPhone', '+14155552671', secret);
      expect(await caller.account.phone.begin({ newPhone: ' +14155552671 ', stepUpApprovalId: approval })).toEqual({ accepted: true });
      const code = sentPhone[0]?.code ?? '';
      expect(await caller.account.phone.confirm({ code })).toEqual({ ok: true });
      expect((await refusal(caller.account.phone.confirm({ code }))).code).toBe('identity.contact_code_invalid');
      const stored = await db.sql<Array<{ phone: string }>>`SELECT phone FROM user_phones WHERE user_id = ${user.userId}`;
      expect(stored[0]?.phone).toBe('+14155552671');

      const again = await register();
      const againSecret = await enrolTotp(again.userId);
      const second = await mint(again, PHONE_SCOPE, 'account.phone.change', 'newPhone', '+14155552671', againSecret);
      await (await callerOf(again)).account.phone.begin({ newPhone: '+14155552671', stepUpApprovalId: second });
      const secondCode = sentPhone.find((row) => row.purpose === 'phone-change' && row !== sentPhone[0])?.code ?? '';
      expect((await refusal((await callerOf(again)).account.phone.confirm({ code: secondCode }))).code).toBe(
        'identity.contact_code_invalid',
      );
      const theirs = await db.sql<Array<{ phone: string }>>`SELECT phone FROM user_phones WHERE user_id = ${again.userId}`;
      expect(theirs).toHaveLength(0);

      const third = await register();
      const thirdSecret = await enrolTotp(third.userId);
      const thirdApproval = await mint(third, PHONE_SCOPE, 'account.phone.change', 'newPhone', '+14155550100', thirdSecret);
      const thirdCaller = await callerOf(third);
      await thirdCaller.account.phone.begin({ newPhone: '+14155550100', stepUpApprovalId: thirdApproval });
      const thirdCode = sentPhone.at(-1)?.code ?? '';
      for (let i = 0; i < 5; i += 1)
        expect((await refusal(thirdCaller.account.phone.confirm({ code: `bad-${i}` }))).code).toBe('identity.contact_code_invalid');
      expect((await refusal(thirdCaller.account.phone.confirm({ code: thirdCode }))).code).toBe('identity.contact_code_invalid');
      expect(JSON.stringify(warnings)).not.toContain(code);
      expect(JSON.stringify(warnings)).not.toContain(thirdCode);
    });

    it('refuses a step-up bound to a different number', async () => {
      deps.phone = phoneSender;
      const user = await register();
      const secret = await enrolTotp(user.userId);
      const mismatched = await mint(user, PHONE_SCOPE, 'account.phone.change', 'newPhone', '+14155552671', secret);
      const refused = await refusal((await callerOf(user)).account.phone.begin({ newPhone: '+14155550199', stepUpApprovalId: mismatched }));
      expect(refused.code).toBe('identity.step_up_target');
      expect(await proofCount(user.userId)).toBe(0);
    });

    it('does not let another user confirm the code, then removes the number', async () => {
      deps.phone = phoneSender;
      const user = await register();
      const secret = await enrolTotp(user.userId);
      const caller = await callerOf(user);
      const approval = await mint(user, PHONE_SCOPE, 'account.phone.change', 'newPhone', '+14155552671', secret);
      await caller.account.phone.begin({ newPhone: '+14155552671', stepUpApprovalId: approval });
      const code = sentPhone.at(-1)?.code ?? '';
      const other = await register();
      expect((await refusal((await callerOf(other)).account.phone.confirm({ code }))).code).toBe('identity.contact_code_invalid');
      expect(await caller.account.phone.confirm({ code })).toEqual({ ok: true });
      const still = await db.sql<Array<{ phone: string }>>`SELECT phone FROM user_phones WHERE user_id = ${user.userId}`;
      expect(still[0]?.phone).toBe('+14155552671');
      const audit = await db.sql<Array<{ event: string }>>`
        SELECT event FROM contact_change_audit WHERE user_id = ${user.userId}
      `;
      expect(audit.map((row) => row.event)).toContain('confirm');
      await expect(auth.login({ identifier: '+14155552671', password: PASSWORD })).rejects.toMatchObject({
        code: 'auth.invalid_credentials',
      });
    });

    it('removes the verified number after a step-up bound to it', async () => {
      deps.phone = phoneSender;
      const user = await register();
      const secret = await enrolTotp(user.userId);
      await db.sql`
        INSERT INTO user_phones (user_id, phone, verified_at) VALUES (${user.userId}, '+14155552671', now())
      `;
      const remove = await mint(user, REMOVE_SCOPE, 'account.phone.remove', 'phone', '+14155552671', secret);
      expect(await (await callerOf(user)).account.phone.remove({ stepUpApprovalId: remove })).toEqual({ ok: true });
      const gone = await db.sql<Array<{ phone: string }>>`SELECT phone FROM user_phones WHERE user_id = ${user.userId}`;
      expect(gone).toHaveLength(0);
      const audit = await db.sql<Array<{ event: string }>>`
        SELECT event FROM contact_change_audit WHERE user_id = ${user.userId} AND event = 'remove'
      `;
      expect(audit).toHaveLength(1);
    });

    it('refuses a number that is not E.164', async () => {
      const user = await register();
      const refused = await refusal(
        (await callerOf(user)).account.phone.begin({ newPhone: '4155552671', stepUpApprovalId: '11111111-1111-4111-8111-111111111111' }),
      );
      expect(refused.code).toBe('identity.phone_invalid');
      expect(await proofCount(user.userId)).toBe(0);
    });
  });
}
