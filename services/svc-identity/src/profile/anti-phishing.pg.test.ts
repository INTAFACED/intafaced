/**
 * Anti-phishing code against Postgres (I-signin-sessions-25): set and cleared only with a step-up bound to the exact code,
 * read back only by its owner on a live session, stored encrypted, never the handle, email or password.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyAccessToken } from '@intafaced/auth';
import { mergeRouters, type Context, type TRPCError } from '@intafaced/contracts';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { createIdentityRouter } from '../router.js';
import { createStepUpRouter } from '../step-up-router.js';
import { ActionApprovalService } from '../auth/action-approval-service.js';
import { SqlActionApprovalStore } from '../auth/action-approval-store.js';
import { AuthService, type SessionTokens } from '../auth/auth-service.js';
import { CustomerStepUpService } from '../auth/customer-step-up.js';
import { SqlCustomerStepUpStore } from '../auth/customer-step-up-store.js';
import { totp } from '../auth/totp.js';
import { AntiPhishingService, antiPhishingKey } from './anti-phishing.js';

function identityTestUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const parsed = new URL(raw);
  if (!parsed.pathname.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

const DATABASE_URL = identityTestUrl();
const PASSWORD = 'Plain4Password9Text';
const SCOPE = 'identity.step_up.anti_phishing_set' as const;
const tokenConfig = {
  secret: 'an-identity-anti-phishing-test-secret-x-long-enough',
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

const available = await postgresAvailable(DATABASE_URL);

if (!available) {
  describe.skip('anti-phishing code (Postgres unavailable)', () => {
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
  const key = antiPhishingKey(randomBytes(32));
  const antiPhishing = new AntiPhishingService({ sql: db.sql, approvals, key });
  const keyless = new AntiPhishingService({ sql: db.sql, approvals, key: antiPhishingKey(null) });
  const rekeyed = new AntiPhishingService({ sql: db.sql, approvals, key: antiPhishingKey(randomBytes(32)) });
  const routerWith = (service?: AntiPhishingService) =>
    mergeRouters(createIdentityRouter(auth, rank, { registrationOpen: true, antiPhishing: service }), createStepUpRouter(stepUps));
  const api = routerWith(antiPhishing);

  let n = 0;
  const unique = () => `ap${process.pid}x${++n}`;

  beforeEach(async () => {
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    await db.drop();
  });

  async function ctxOf(tokens: SessionTokens, extra: Record<string, unknown> = {}): Promise<Context> {
    const principal = await verifyAccessToken(tokens.accessToken, tokenConfig);
    return { principal: { ...principal, ...extra }, service: null, region: 'DE', requestId: 'req-antiphish' };
  }
  const callerOf = async (tokens: SessionTokens, extra?: Record<string, unknown>, router = api) =>
    router.createCaller(await ctxOf(tokens, extra));

  async function setup() {
    const handle = unique();
    const user = await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD, region: 'DE' });
    const started = await auth.startTotpEnrolment(user.userId, { mfa: false, privileged: false });
    await auth.confirmTotpEnrolment(user.userId, { mfa: false, privileged: false }, started.secret, totp(started.secret));
    return { user, handle, secret: started.secret, caller: await callerOf(user) };
  }
  async function mint(tokens: SessionTokens, secret: string, code: string, clientRequestId: string) {
    await db.sql`UPDATE users SET totp_last_step = NULL WHERE id = ${tokens.userId}`;
    const caller = await callerOf(tokens);
    const begun = await caller.stepUp.begin({ scope: SCOPE, purpose: 'account.antiPhishing.set', fields: { code, clientRequestId } });
    const done = await caller.stepUp.complete({ challengeId: begun.challengeId, totpCode: totp(secret) });
    return done.stepUpApprovalId;
  }
  async function refusal(run: Promise<unknown>) {
    try {
      await run;
    } catch (err) {
      const wrapped = err as TRPCError & { cause?: { code?: string } };
      return { trpc: wrapped.code, code: wrapped.cause?.code };
    }
    throw new Error('expected a refusal');
  }
  const auditOf = async (userId: string) =>
    (await db.sql<Array<{ action: string }>>`SELECT action FROM anti_phishing_audit WHERE user_id = ${userId} ORDER BY at, id`).map(
      (row) => row.action,
    );

  it('sets, reads back, changes and clears the code; a repeat spends nothing; the stored row is not the code', async () => {
    const { user, secret, caller } = await setup();
    expect(await caller.profile.antiPhishing.get()).toEqual({ code: null, updatedAt: null });

    const first = randomUUID();
    const set = await caller.profile.antiPhishing.set({
      code: 'Owl42',
      stepUpApprovalId: await mint(user, secret, 'Owl42', first),
      clientRequestId: first,
    });
    expect(set).toMatchObject({ code: 'Owl42', changed: true, updatedAt: expect.any(String) });
    expect(await caller.profile.antiPhishing.get()).toMatchObject({ code: 'Owl42' });
    const stored = await db.sql<Array<{ ciphertext: Buffer }>>`SELECT ciphertext FROM anti_phishing_codes WHERE user_id = ${user.userId}`;
    expect(stored[0]!.ciphertext.includes(Buffer.from('Owl42'))).toBe(false);

    // The same code again: answered from the row, no step-up needed or spent.
    expect(
      await caller.profile.antiPhishing.set({ code: 'Owl42', stepUpApprovalId: randomUUID(), clientRequestId: randomUUID() }),
    ).toMatchObject({ code: 'Owl42', changed: false });

    const second = randomUUID();
    await caller.profile.antiPhishing.set({
      code: 'Heron7',
      stepUpApprovalId: await mint(user, secret, 'Heron7', second),
      clientRequestId: second,
    });
    expect(await caller.profile.antiPhishing.get()).toMatchObject({ code: 'Heron7' });

    const third = randomUUID();
    expect(
      await caller.profile.antiPhishing.set({ code: '', stepUpApprovalId: await mint(user, secret, '', third), clientRequestId: third }),
    ).toEqual({ code: null, updatedAt: null, changed: true });
    expect(await caller.profile.antiPhishing.get()).toEqual({ code: null, updatedAt: null });
    expect(await auditOf(user.userId)).toEqual(['set', 'set', 'cleared']);
  });

  it('refuses a code equal to the handle, the email or the password, after spending the step-up', async () => {
    const { user, handle, secret, caller } = await setup();
    await db.sql`UPDATE users SET email = ${'Mail7Box@example.com'} WHERE id = ${user.userId}`;
    for (const code of [handle.toUpperCase(), handle, 'mail7box', PASSWORD]) {
      const c = randomUUID();
      const approval = await mint(user, secret, code, c);
      expect(await refusal(caller.profile.antiPhishing.set({ code, stepUpApprovalId: approval, clientRequestId: c }))).toEqual({
        trpc: 'BAD_REQUEST',
        code: 'identity.anti_phishing_guessable',
      });
      // A refused guess spent its confirmation: testing a password guess costs a fresh factor every time.
      expect(await refusal(caller.profile.antiPhishing.set({ code, stepUpApprovalId: approval, clientRequestId: c }))).toMatchObject({
        code: 'identity.step_up_used',
      });
    }
    expect(await caller.profile.antiPhishing.get()).toEqual({ code: null, updatedAt: null });
    expect(await auditOf(user.userId)).toEqual([]);
  });

  it('refuses a bad shape before any step-up, and a step-up for another code, a missing one or a used one', async () => {
    const { user, secret, caller } = await setup();
    for (const code of ['abc', 'with space', 'x'.repeat(21), 'émoji1']) {
      expect(
        await refusal(caller.profile.antiPhishing.set({ code, stepUpApprovalId: randomUUID(), clientRequestId: randomUUID() })),
      ).toEqual({
        trpc: 'BAD_REQUEST',
        code: 'identity.anti_phishing_invalid',
      });
    }
    const c = randomUUID();
    const forOwl = await mint(user, secret, 'Owl42', c);
    expect(await refusal(caller.profile.antiPhishing.set({ code: 'Crow11', stepUpApprovalId: forOwl, clientRequestId: c }))).toMatchObject({
      trpc: 'PRECONDITION_FAILED',
      code: 'identity.step_up_target',
    });
    expect(
      await refusal(caller.profile.antiPhishing.set({ code: 'Crow11', stepUpApprovalId: randomUUID(), clientRequestId: randomUUID() })),
    ).toMatchObject({ trpc: 'PRECONDITION_FAILED', code: 'identity.step_up_required' });
    expect(await caller.profile.antiPhishing.get()).toEqual({ code: null, updatedAt: null });
  });

  it('reads and writes only for a live session of the owner, never for an API key, a sub-account or after sign-out', async () => {
    const { user, secret, caller } = await setup();
    const c = randomUUID();
    await caller.profile.antiPhishing.set({ code: 'Owl42', stepUpApprovalId: await mint(user, secret, 'Owl42', c), clientRequestId: c });

    for (const extra of [{ kid: 'key-1' }, { sub_account: randomUUID() }]) {
      const delegated = await callerOf(user, extra);
      expect(await refusal(delegated.profile.antiPhishing.get())).toEqual({ trpc: 'FORBIDDEN', code: 'identity.anti_phishing_delegated' });
    }

    // A refresh rotates the session row: the new token reads, the one it replaced is refused (as the edge refuses it).
    const rotated = await auth.refresh(user.refreshToken);
    expect(await (await callerOf(rotated)).profile.antiPhishing.get()).toMatchObject({ code: 'Owl42' });
    expect(await refusal(caller.profile.antiPhishing.get())).toEqual({ trpc: 'UNAUTHORIZED', code: 'identity.session_not_live' });

    // Signing out ends the sign-in.
    await auth.logout(rotated.refreshToken);
    expect(await refusal((await callerOf(rotated)).profile.antiPhishing.get())).toEqual({
      trpc: 'UNAUTHORIZED',
      code: 'identity.session_not_live',
    });

    // The request id is a fresh uuid; anything else is refused before any step-up.
    expect(
      await refusal(
        (await callerOf(rotated)).profile.antiPhishing.set({ code: 'Crow11', stepUpApprovalId: randomUUID(), clientRequestId: 'req-1' }),
      ),
    ).toMatchObject({ code: 'identity.client_request_id_invalid' });
  });

  it('after a key change, names the stored code unreadable, and still replaces or clears it', async () => {
    const { user, secret, caller } = await setup();
    const c = randomUUID();
    const first = await caller.profile.antiPhishing.set({
      code: 'Owl42',
      stepUpApprovalId: await mint(user, secret, 'Owl42', c),
      clientRequestId: c,
    });
    // One change carries one time: the answer to set is the time get reads back.
    expect((await caller.profile.antiPhishing.get()).updatedAt).toBe(first.updatedAt);

    const other = await callerOf(user, undefined, routerWith(rekeyed));
    expect(await refusal(other.profile.antiPhishing.get())).toEqual({
      trpc: 'PRECONDITION_FAILED',
      code: 'identity.anti_phishing_unreadable',
    });
    const d = randomUUID();
    expect(
      await other.profile.antiPhishing.set({ code: 'Owl42', stepUpApprovalId: await mint(user, secret, 'Owl42', d), clientRequestId: d }),
    ).toMatchObject({ code: 'Owl42', changed: true });
    expect(await other.profile.antiPhishing.get()).toMatchObject({ code: 'Owl42' });

    const back = await callerOf(user, undefined, routerWith(antiPhishing));
    expect(await refusal(back.profile.antiPhishing.get())).toMatchObject({ code: 'identity.anti_phishing_unreadable' });
    const e = randomUUID();
    expect(
      await back.profile.antiPhishing.set({ code: '', stepUpApprovalId: await mint(user, secret, '', e), clientRequestId: e }),
    ).toEqual({ code: null, updatedAt: null, changed: true });
    // A clear with nothing stored changes nothing and spends nothing.
    expect(await back.profile.antiPhishing.set({ code: '', stepUpApprovalId: randomUUID(), clientRequestId: randomUUID() })).toEqual({
      code: null,
      updatedAt: null,
      changed: false,
    });
  });

  it('refuses to store a code without a key but still clears one, and refuses when not wired', async () => {
    const { user, secret, caller } = await setup();
    const withoutKey = await callerOf(user, undefined, routerWith(keyless));
    expect(
      await refusal(withoutKey.profile.antiPhishing.set({ code: 'Owl42', stepUpApprovalId: randomUUID(), clientRequestId: randomUUID() })),
    ).toEqual({ trpc: 'PRECONDITION_FAILED', code: 'identity.anti_phishing_key_unset' });

    const c = randomUUID();
    await caller.profile.antiPhishing.set({ code: 'Owl42', stepUpApprovalId: await mint(user, secret, 'Owl42', c), clientRequestId: c });
    expect(await refusal(withoutKey.profile.antiPhishing.get())).toEqual({
      trpc: 'PRECONDITION_FAILED',
      code: 'identity.anti_phishing_key_unset',
    });
    const d = randomUUID();
    expect(
      await withoutKey.profile.antiPhishing.set({ code: '', stepUpApprovalId: await mint(user, secret, '', d), clientRequestId: d }),
    ).toMatchObject({ code: null, changed: true });

    const unwired = await callerOf(user, undefined, routerWith(undefined));
    expect(await refusal(unwired.profile.antiPhishing.get())).toEqual({
      trpc: 'PRECONDITION_FAILED',
      code: 'identity.anti_phishing_unavailable',
    });
  });
}
