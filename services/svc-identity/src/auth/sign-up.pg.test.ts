import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@intafaced/contracts';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from './auth-service.js';
import { ageOn, countryCode } from './sign-up.js';
import { stubActionApprovals } from './privileged-dual-control.js';
import { createIdentityRouter } from '../router.js';
import { RankService } from '../rank/rank-service.js';

/**
 * Sign-up by email (I-signin-sessions-18) with the eligibility check at the door (I-kyc-compliance-06).
 * No account and no session until the mailed code is entered; a new address and a known one get the same
 * answer and the same rows; age and country refuse before anything is written. Every number in this file is a
 * TEST fixture, not an owner setting.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@127.0.0.1:15491/intafaced_test';
const PASSWORD = 'a long enough sign-up passphrase';
const POLICY = {
  minAgeYears: 18,
  codeTtlSeconds: 600,
  maxAttempts: 3,
  resendSeconds: 60,
  requestMax: 4,
  requestWindowSeconds: 3600,
  closedCountries: ['AQ'],
} as const;
const T0 = Date.parse('2026-10-22T09:00:00.000Z');

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
const anonContext: Context = { principal: null, service: null, region: 'DE', requestId: 'req-signup' };

describe('sign-up eligibility helpers', () => {
  it('reads whole years in UTC and refuses dates that are not real or are in the future', () => {
    const now = new Date(T0);
    expect(ageOn('2008-10-22', now)).toBe(18);
    expect(ageOn('2008-10-23', now)).toBe(17);
    expect(ageOn('2008-02-30', now)).toBeUndefined();
    expect(ageOn('2030-01-01', now)).toBeUndefined();
    expect(ageOn('22/10/2008', now)).toBeUndefined();
  });

  it('takes real ISO countries only', () => {
    expect(countryCode('de')).toBe('DE');
    expect(countryCode('ZZ')).toBeUndefined();
    expect(countryCode('EU')).toBeUndefined();
    expect(countryCode('QQ')).toBeUndefined();
    expect(countryCode('D')).toBeUndefined();
  });
});

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('sign-up (Postgres unavailable)', () => {
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
  const router = createIdentityRouter(auth, rank, { registrationOpen: true, actionApprovals: stubActionApprovals() });
  const anon = () => router.createCaller(anonContext);

  const sent: Array<{ email: string; code: string; purpose?: string }> = [];
  let nowMs = T0;
  let counter = 0;
  const unique = () => `su${process.pid}x${++counter}`;
  const saved: Record<string, string | undefined> = {};
  const SCREENING_ENV = ['INTAFACED_SANCTIONS_REGIONS', 'INTAFACED_SANCTIONS_LIST_SOURCE', 'INTAFACED_SCREENING_FAIL_CLOSED', 'APP_ENV'];

  const form = (over: Record<string, unknown> = {}) => {
    const handle = unique();
    return {
      channel: 'email' as const,
      handle,
      email: `${handle}@example.com`,
      password: PASSWORD,
      country: 'DE',
      dateOfBirth: '1990-05-01',
      accountType: 'individual' as const,
      ...over,
    };
  };
  const refusal = async (promise: Promise<unknown>) => {
    const err = (await promise.then(
      () => undefined,
      (e: unknown) => e,
    )) as { code?: string; cause?: { code?: string; details?: { retryAfterSeconds?: number } } } | undefined;
    expect(err).toBeDefined();
    return { trpc: err!.code, code: err!.cause?.code, retryAfterSeconds: err!.cause?.details?.retryAfterSeconds };
  };
  const count = async (table: string) => (await db.sql.unsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM ${table}`))[0]!.n;
  const rows = async () => ({
    users: await count('users'),
    flows: await count('auth_flows'),
    drafts: await count('signup_drafts'),
    outbox: await count('mail_outbox'),
  });

  beforeAll(() => {
    for (const k of SCREENING_ENV) saved[k] = process.env[k];
    // A TEST screening list naming one region, read as a list on a test stack (APP_ENV test, fail-closed off).
    process.env.INTAFACED_SANCTIONS_REGIONS = 'KP:TEST fixture';
    process.env.INTAFACED_SANCTIONS_LIST_SOURCE = 'TEST fixture for the sign-up test';
    process.env.INTAFACED_SCREENING_FAIL_CLOSED = 'off';
    process.env.APP_ENV = 'test';
  });
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
    auth.useSignUpPolicy(POLICY);
    auth.useMailRelayTrigger(async () => void (await auth.drainMailOutbox()));
    auth.usePasswordResetClock(() => new Date(nowMs));
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    for (const k of SCREENING_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await db.drop();
  });

  describe('sign-up', () => {
    it('opens no session until the mailed code is entered, then makes one account with the email proved', async () => {
      const input = form();
      const answer = await anon().auth.signUpStart(input);

      expect(answer).toEqual({ accepted: true, next: 'confirm_email', flowId: expect.any(String), resendAfterSeconds: 60 });
      expect(JSON.stringify(answer)).not.toContain('accessToken');
      expect(await rows()).toEqual({ users: 0, flows: 1, drafts: 1, outbox: 1 });
      expect(sent).toEqual([
        expect.objectContaining({ email: input.email, purpose: 'signup-code', code: expect.stringMatching(/^\d{6}$/) }),
      ]);
      // The code is only in the mail: the flow keeps a keyed hash, the outbox row was cleared on claim.
      expect(JSON.stringify(await db.sql`SELECT * FROM auth_flows`)).not.toContain(sent[0]!.code);
      expect(JSON.stringify(await db.sql`SELECT * FROM mail_outbox`)).not.toContain(sent[0]!.code);

      const session = await anon().auth.signUpConfirm({ flowId: answer.flowId, code: sent[0]!.code });

      expect(session).toMatchObject({ accessToken: expect.any(String), userId: expect.any(String), accountType: 'individual' });
      const [user] = await db.sql<Array<{ handle: string; email: string; email_verified_at: Date | null }>>`
        SELECT handle, email, email_verified_at FROM users WHERE id = ${session.userId}
      `;
      expect(user).toMatchObject({ handle: input.handle, email: input.email });
      expect(user!.email_verified_at).not.toBeNull();
      expect(await db.sql`SELECT region FROM profiles WHERE user_id = ${session.userId}`).toEqual([{ region: 'DE' }]);
      expect(await count('signup_drafts')).toBe(0);
      expect(bus.published.some((e) => e.subject.endsWith('identity.user.created'))).toBe(true);
      // The date of birth is checked, not kept.
      expect(JSON.stringify(await db.sql`SELECT * FROM profiles`)).not.toContain('1990-05-01');
      await expect(anon().auth.login({ identifier: input.email, password: PASSWORD })).resolves.toMatchObject({ userId: session.userId });
    });

    it('answers a known address exactly like a new one, mails its owner a notice, and no code can finish it', async () => {
      const first = form();
      const done = await anon().auth.signUpStart(first);
      await anon().auth.signUpConfirm({ flowId: done.flowId, code: sent[0]!.code });
      const before = await rows();
      sent.length = 0;

      const fresh = await anon().auth.signUpStart(form());
      const fresher = await rows();
      const known = await anon().auth.signUpStart(form({ email: first.email.toUpperCase() }));
      const after = await rows();

      expect(Object.keys(known).sort()).toEqual(Object.keys(fresh).sort());
      expect({ ...known, flowId: 'x' }).toEqual({ ...fresh, flowId: 'x' });
      expect(fresher.flows - before.flows).toBe(after.flows - fresher.flows);
      expect(fresher.drafts - before.drafts).toBe(after.drafts - fresher.drafts);
      expect(fresher.outbox - before.outbox).toBe(after.outbox - fresher.outbox);
      expect(sent[1]).toMatchObject({ email: first.email, purpose: 'signup-existing', code: '' });
      for (const code of ['000000', sent[0]!.code]) {
        expect((await refusal(anon().auth.signUpConfirm({ flowId: known.flowId, code }))).code).toBe('identity.signup_code_invalid');
      }
      expect(await count('users')).toBe(before.users);
    });

    it('locks after the wrong-code count with the time left, and a used code is refused', async () => {
      const answer = await anon().auth.signUpStart(form());
      const code = sent[0]!.code;
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 1; i < POLICY.maxAttempts; i++) {
        expect((await refusal(anon().auth.signUpConfirm({ flowId: answer.flowId, code: wrong }))).code).toBe(
          'identity.signup_code_invalid',
        );
      }
      const locked = await refusal(anon().auth.signUpConfirm({ flowId: answer.flowId, code: wrong }));
      expect(locked).toMatchObject({ trpc: 'TOO_MANY_REQUESTS', code: 'auth.too_many_attempts', retryAfterSeconds: 600 });
      expect((await refusal(anon().auth.signUpConfirm({ flowId: answer.flowId, code }))).code).toBe('auth.too_many_attempts');
      expect(await count('users')).toBe(0);
      expect(await count('signup_drafts')).toBe(0);

      const again = await anon().auth.signUpStart(form());
      const second = sent.at(-1)!.code;
      await anon().auth.signUpConfirm({ flowId: again.flowId, code: second });
      expect((await refusal(anon().auth.signUpConfirm({ flowId: again.flowId, code: second }))).code).toBe('identity.signup_code_used');
      expect(await count('users')).toBe(1);
    });

    it('resends only after the interval, with the seconds left, and the new code replaces the old one', async () => {
      const answer = await anon().auth.signUpStart(form());
      const early = await refusal(anon().auth.signUpResend({ flowId: answer.flowId }));
      expect(early).toMatchObject({ trpc: 'TOO_MANY_REQUESTS', code: 'identity.resend_too_soon' });

      nowMs += 61_000;
      await anon().auth.signUpResend({ flowId: answer.flowId });
      expect(sent).toHaveLength(2);
      expect((await refusal(anon().auth.signUpConfirm({ flowId: answer.flowId, code: sent[0]!.code }))).code).toMatch(
        /identity.signup_code_invalid|auth.too_many_attempts/,
      );
      await expect(anon().auth.signUpConfirm({ flowId: answer.flowId, code: sent[1]!.code })).resolves.toMatchObject({
        userId: expect.any(String),
      });
    });

    it('expires the code after its lifetime', async () => {
      const answer = await anon().auth.signUpStart(form());
      nowMs += 601_000;
      expect((await refusal(anon().auth.signUpConfirm({ flowId: answer.flowId, code: sent[0]!.code }))).code).toBe(
        'identity.signup_expired',
      );
      expect(await count('users')).toBe(0);
    });

    it('refuses an under-age date, a closed, screened or unlisted country, and writes nothing', async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ dateOfBirth: '2008-10-23' }, 'identity.underage'],
        [{ dateOfBirth: '2008-02-30' }, 'identity.date_of_birth_invalid'],
        [{ country: 'AQ' }, 'identity.region_blocked'],
        [{ country: 'KP' }, 'identity.region_blocked'],
        [{ country: 'DE', nationality: 'KP' }, 'identity.region_blocked'],
        [{ country: 'ZZ' }, 'identity.country_invalid'],
        [{ password: 'short' }, 'auth.password_policy'],
        [{ channel: 'phone', phone: '+4915112345678' }, 'vendor.sms'],
      ];
      for (const [over, code] of cases) {
        expect((await refusal(anon().auth.signUpStart(form(over)))).code, JSON.stringify(over)).toBe(code);
      }
      expect(await rows()).toEqual({ users: 0, flows: 0, drafts: 0, outbox: 0 });
      expect(sent).toHaveLength(0);
    });

    it('refuses every sign-up the same way while an owner number, the mail transport or the screening list is blank', async () => {
      auth.useSignUpPolicy({ ...POLICY, minAgeYears: undefined });
      expect((await refusal(anon().auth.signUpStart(form()))).code).toBe('identity.age_rule_unset');
      auth.useSignUpPolicy({ ...POLICY, resendSeconds: undefined });
      expect((await refusal(anon().auth.signUpStart(form()))).code).toBe('identity.signup_unwired');
      auth.useSignUpPolicy(POLICY);
      auth.usePasswordResetMail(undefined);
      expect((await refusal(anon().auth.signUpStart(form()))).code).toBe('vendor.email');
      // Production posture: no list and the fail-closed switch not turned off.
      const regions = process.env.INTAFACED_SANCTIONS_REGIONS;
      delete process.env.INTAFACED_SANCTIONS_REGIONS;
      delete process.env.INTAFACED_SCREENING_FAIL_CLOSED;
      try {
        auth.usePasswordResetMail({ send: async () => undefined });
        expect((await refusal(anon().auth.signUpStart(form()))).code).toBe('identity.screening_unset');
      } finally {
        process.env.INTAFACED_SANCTIONS_REGIONS = regions;
        process.env.INTAFACED_SCREENING_FAIL_CLOSED = 'off';
      }
      expect(await rows()).toEqual({ users: 0, flows: 0, drafts: 0, outbox: 0 });
    });

    it('caps sign-ups per address and says when to try again', async () => {
      const email = `${unique()}@example.com`;
      for (let i = 0; i < POLICY.requestMax; i++) await anon().auth.signUpStart(form({ email }));
      const capped = await refusal(anon().auth.signUpStart(form({ email })));
      expect(capped).toMatchObject({ code: 'auth.too_many_attempts', retryAfterSeconds: 3600 });
    });

    it('keeps a business choice on the profile and tells the app to open business verification', async () => {
      const answer = await anon().auth.signUpStart(form({ accountType: 'business' }));
      const session = await anon().auth.signUpConfirm({ flowId: answer.flowId, code: sent[0]!.code });
      expect(session.accountType).toBe('business');
      expect(await db.sql`SELECT account_type FROM profiles WHERE user_id = ${session.userId}`).toEqual([{ account_type: 'business' }]);
    });

    it('closes the code-less register door unless the stack is a dev or test stack', async () => {
      const input = { handle: unique(), email: `${unique()}@example.com`, password: PASSWORD };
      expect(await refusal(anon().auth.register(input))).toMatchObject({ trpc: 'FORBIDDEN', code: 'identity.register_replaced' });
      expect(await count('users')).toBe(0);
      const testStack = createIdentityRouter(auth, rank, {
        registrationOpen: true,
        directRegister: true,
        actionApprovals: stubActionApprovals(),
      });
      await expect(testStack.createCaller(anonContext).auth.register(input)).resolves.toMatchObject({ userId: expect.any(String) });
    });

    it('never renews a code past one day from the start of the sign-up', async () => {
      auth.useSignUpPolicy({ ...POLICY, requestMax: 1_000 });
      const answer = await anon().auth.signUpStart(form());
      // A resend every 9 minutes keeps the 10-minute code alive, but only until one day after the start.
      for (let i = 0; i < 170; i++) {
        nowMs += 9 * 60_000;
        if (
          (await anon()
            .auth.signUpResend({ flowId: answer.flowId })
            .catch(() => 'refused')) === 'refused'
        )
          break;
      }
      const [flow] = await db.sql<Array<{ expires_at: Date }>>`SELECT expires_at FROM auth_flows WHERE id = ${answer.flowId}`;
      expect(new Date(flow!.expires_at).getTime()).toBe(T0 + 86_400_000);
      expect(nowMs).toBeGreaterThanOrEqual(T0 + 86_400_000);
      expect((await refusal(anon().auth.signUpConfirm({ flowId: answer.flowId, code: sent.at(-1)!.code }))).code).toBe(
        'identity.signup_expired',
      );
    });

    it('says a taken handle out loud (handles are public) and refuses a closed registration with its own code', async () => {
      const first = form();
      const answer = await anon().auth.signUpStart(first);
      await anon().auth.signUpConfirm({ flowId: answer.flowId, code: sent[0]!.code });
      expect((await refusal(anon().auth.signUpStart(form({ handle: first.handle.toUpperCase() })))).code).toBe('auth.handle_taken');

      const closed = createIdentityRouter(auth, rank, { registrationOpen: false, actionApprovals: stubActionApprovals() });
      expect(await refusal(closed.createCaller(anonContext).auth.signUpStart(form()))).toMatchObject({
        trpc: 'FORBIDDEN',
        code: 'identity.registration_closed',
      });
    });
  });
}
