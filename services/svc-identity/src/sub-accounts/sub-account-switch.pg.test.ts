/**
 * Sub-account sign-in control and switching against Postgres (I-account-lifecycle-04): step-up, audit, default off,
 * switch tokens scoped to the sub-account, refusals for revoked, frozen and delegated callers, the owner's interval.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken as _unused, verifyAccessToken } from '@intafaced/auth';
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
import { FounderControls } from '../controls/founder-controls.js';
import { SubAccountSwitchService } from './sub-account-switch.js';

void _unused;

function identityTestUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const parsed = new URL(raw);
  if (!parsed.pathname.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

const DATABASE_URL = identityTestUrl();
const PASSWORD = 'correct horse battery staple';
const SCOPE = 'identity.step_up.sub_account_signin' as const;
const tokenConfig = {
  secret: 'an-identity-sub-account-switch-test-secret-x-long-enough',
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
  describe.skip('sub-account switch (Postgres unavailable)', () => {
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
  let minSeconds: number | undefined;
  let clock = new Date();
  const subAccountSwitch = new SubAccountSwitchService({
    sql: db.sql,
    approvals,
    issue: (input) => auth.issueSubAccountSwitchToken(input),
    minSwitchSeconds: () => minSeconds,
    now: () => clock,
  });
  const api = mergeRouters(createIdentityRouter(auth, rank, { registrationOpen: true, subAccountSwitch }), createStepUpRouter(stepUps));

  let n = 0;
  const unique = () => `sw${process.pid}x${++n}`;

  beforeEach(async () => {
    await db.truncateAll();
    await rank.seedTiers();
    minSeconds = undefined;
    clock = new Date();
  });
  afterAll(async () => {
    await db.drop();
  });

  async function ctxOf(tokens: SessionTokens, extra: Record<string, unknown> = {}): Promise<Context> {
    const principal = await verifyAccessToken(tokens.accessToken, tokenConfig);
    return { principal: { ...principal, ...extra }, service: null, region: 'DE', requestId: 'req-subswitch' };
  }
  const callerOf = async (tokens: SessionTokens, extra?: Record<string, unknown>) => api.createCaller(await ctxOf(tokens, extra));

  async function register() {
    const handle = unique();
    return auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD, region: 'DE' });
  }
  async function enrolTotp(userId: string) {
    const started = await auth.startTotpEnrolment(userId, { mfa: false, privileged: false });
    await auth.confirmTotpEnrolment(userId, { mfa: false, privileged: false }, started.secret, totp(started.secret));
    return started.secret;
  }
  async function mint(tokens: SessionTokens, subAccountId: string, enabled: boolean, clientRequestId: string, secret: string) {
    await db.sql`UPDATE users SET totp_last_step = NULL WHERE id = ${tokens.userId}`;
    const caller = await callerOf(tokens);
    const begun = await caller.stepUp.begin({
      scope: SCOPE,
      purpose: 'account.subAccount.signin',
      target: subAccountId,
      fields: { subAccountId, enabled: enabled ? 'true' : 'false', clientRequestId },
    });
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
  const rowOf = async (id: string) =>
    (await db.sql<Array<{ signin_enabled: boolean }>>`SELECT signin_enabled FROM sub_accounts WHERE id = ${id}`)[0];
  const auditOf = async (id: string) =>
    db.sql<Array<{ enabled: boolean }>>`SELECT enabled FROM sub_account_signin_audit WHERE sub_account_id = ${id} ORDER BY at, id`;

  it('sign-in is off by default; the main turns it on and off with a step-up, audited, and a repeat spends nothing', async () => {
    const user = await register();
    const secret = await enrolTotp(user.userId);
    const caller = await callerOf(user);
    const { id } = await auth.createSubAccount(user.userId, 'desk', undefined);
    expect((await rowOf(id))?.signin_enabled).toBe(false);
    const c = randomUUID();
    const approval = await mint(user, id, true, c, secret);
    expect(await caller.subAccounts.setSignIn({ subAccountId: id, enabled: true, stepUpApprovalId: approval, clientRequestId: c })).toEqual(
      {
        id,
        signInEnabled: true,
        changed: true,
      },
    );
    expect(
      await caller.subAccounts.setSignIn({ subAccountId: id, enabled: true, stepUpApprovalId: randomUUID(), clientRequestId: c }),
    ).toEqual({
      id,
      signInEnabled: true,
      changed: false,
    });
    const d = randomUUID();
    await caller.subAccounts.setSignIn({
      subAccountId: id,
      enabled: false,
      stepUpApprovalId: await mint(user, id, false, d, secret),
      clientRequestId: d,
    });
    expect((await rowOf(id))?.signin_enabled).toBe(false);
    expect(await auditOf(id)).toEqual([{ enabled: true }, { enabled: false }]);
  });

  it('a step-up approval id (also the operation id) is one-time and bound to its user and payload: replay and cross-user use refuse', async () => {
    const user = await register();
    const stranger = await register();
    const secret = await enrolTotp(user.userId);
    const caller = await callerOf(user);
    const strangerCaller = await callerOf(stranger);
    const { id } = await auth.createSubAccount(user.userId, 'desk', undefined);
    const { id: theirs } = await auth.createSubAccount(stranger.userId, 'desk', undefined);
    const c = randomUUID();
    const a = await mint(user, id, true, c, secret);
    await caller.subAccounts.setSignIn({ subAccountId: id, enabled: true, stepUpApprovalId: a, clientRequestId: c });
    const d = randomUUID();
    await caller.subAccounts.setSignIn({
      subAccountId: id,
      enabled: false,
      stepUpApprovalId: await mint(user, id, false, d, secret),
      clientRequestId: d,
    });
    // Replay of the spent id with the exact same payload: refused, nothing changes.
    expect(
      (await refusal(caller.subAccounts.setSignIn({ subAccountId: id, enabled: true, stepUpApprovalId: a, clientRequestId: c }))).code,
    ).toBe('identity.step_up_used');
    expect((await rowOf(id))?.signin_enabled).toBe(false);
    // An unspent id of one user cannot be spent by another user, on their own sub-account or on this one.
    const e = randomUUID();
    const b = await mint(user, id, true, e, secret);
    const cross = await refusal(
      strangerCaller.subAccounts.setSignIn({ subAccountId: theirs, enabled: true, stepUpApprovalId: b, clientRequestId: e }),
    );
    // The payload hash binds the actor and the sub-account, so it fails on the hash before the requester check.
    expect(cross.code).toBe('identity.step_up_target');
    expect(
      (await refusal(strangerCaller.subAccounts.setSignIn({ subAccountId: id, enabled: true, stepUpApprovalId: b, clientRequestId: e })))
        .code,
    ).toBe('auth.not_found');
    // Still unspent for its owner, exactly once.
    await expect(
      caller.subAccounts.setSignIn({ subAccountId: id, enabled: true, stepUpApprovalId: b, clientRequestId: e }),
    ).resolves.toMatchObject({ changed: true });
    expect(await db.sql`SELECT status FROM action_approvals WHERE approval_id IN (${a}, ${b})`).toEqual([
      { status: 'CONSUMED' },
      { status: 'CONSUMED' },
    ]);
    expect(await auditOf(id)).toEqual([{ enabled: true }, { enabled: false }, { enabled: true }]);
  });

  it('setSignIn refuses a step-up for the other value, a missing one, a bad request id, a revoked or foreign sub-account and delegated callers', async () => {
    const user = await register();
    const stranger = await register();
    const secret = await enrolTotp(user.userId);
    const caller = await callerOf(user);
    const { id } = await auth.createSubAccount(user.userId, 'desk', undefined);
    const c = randomUUID();
    const forOff = await mint(user, id, false, c, secret);
    expect(
      (await refusal(caller.subAccounts.setSignIn({ subAccountId: id, enabled: true, stepUpApprovalId: forOff, clientRequestId: c }))).code,
    ).toBe('identity.step_up_target');
    expect(
      (await refusal(caller.subAccounts.setSignIn({ subAccountId: id, enabled: true, stepUpApprovalId: randomUUID(), clientRequestId: c })))
        .code,
    ).toBe('identity.step_up_required');
    expect(
      await refusal(
        caller.subAccounts.setSignIn({ subAccountId: id, enabled: true, stepUpApprovalId: randomUUID(), clientRequestId: '-bad id' }),
      ),
    ).toMatchObject({ trpc: 'BAD_REQUEST', code: 'identity.client_request_id_invalid' });
    const input = { subAccountId: id, enabled: true, stepUpApprovalId: randomUUID(), clientRequestId: randomUUID() };
    expect(await refusal((await callerOf(stranger)).subAccounts.setSignIn(input))).toMatchObject({
      trpc: 'NOT_FOUND',
      code: 'auth.not_found',
    });
    expect(await refusal((await callerOf(user, { sub_account: id })).subAccounts.setSignIn(input))).toMatchObject({
      trpc: 'FORBIDDEN',
      code: 'identity.sub_account_switch_delegated',
    });
    expect((await refusal((await callerOf(user, { kid: 'key-1', scopes: ['identity:write'] })).subAccounts.setSignIn(input))).code).toBe(
      'identity.sub_account_switch_delegated',
    );
    await db.sql`UPDATE sub_accounts SET revoked = true WHERE id = ${id}`;
    expect((await refusal(caller.subAccounts.setSignIn(input))).code).toBe('identity.sub_account_revoked');
    expect(await auditOf(id)).toHaveLength(0);
  });

  it('switchTo issues a short-lived token scoped to the sub-account and keeps the main session', async () => {
    const user = await register();
    const caller = await callerOf(user);
    const { id } = await auth.createSubAccount(user.userId, 'desk', undefined);
    const switched = await caller.subAccounts.switchTo({ subAccountId: id });
    const principal = await verifyAccessToken(switched.accessToken, tokenConfig);
    expect(principal).toMatchObject({ userId: user.userId, sub_account: id, sid: user.sessionId });
    const ttl = new Date(switched.expiresAt).getTime() - Date.now();
    expect(ttl).toBeLessThanOrEqual(300_000);
    expect(ttl).toBeGreaterThan(0);
    // The main session still works.
    expect(await caller.subAccounts.list({ limit: 5 })).toHaveLength(1);
    // A switched token is a sub-account principal: main-only doors refuse it.
    const asSub = api.createCaller({ principal, service: null, region: 'DE', requestId: 'req-sub' } as Context);
    expect((await refusal(asSub.subAccounts.switchTo({ subAccountId: id }))).code).toBe('identity.sub_account_switch_delegated');
    expect(
      (
        await refusal(
          asSub.subAccounts.setSignIn({ subAccountId: id, enabled: true, stepUpApprovalId: randomUUID(), clientRequestId: 'r1' }),
        )
      ).code,
    ).toBe('identity.sub_account_switch_delegated');
    expect(await db.sql`SELECT sub_account_id FROM sub_account_switches WHERE user_id = ${user.userId}`).toEqual([{ sub_account_id: id }]);
  });

  it('switchTo refuses a frozen, revoked or foreign sub-account, a frozen main account, and an API key', async () => {
    const user = await register();
    const stranger = await register();
    const caller = await callerOf(user);
    const { id } = await auth.createSubAccount(user.userId, 'desk', undefined);
    expect(await refusal((await callerOf(stranger)).subAccounts.switchTo({ subAccountId: id }))).toMatchObject({
      trpc: 'NOT_FOUND',
      code: 'auth.not_found',
    });
    expect(
      (await refusal((await callerOf(user, { kid: 'key-1', scopes: ['identity:write'] })).subAccounts.switchTo({ subAccountId: id }))).code,
    ).toBe('identity.sub_account_switch_delegated');
    await db.sql`UPDATE sub_accounts SET frozen = 1 WHERE id = ${id}`;
    expect(await refusal(caller.subAccounts.switchTo({ subAccountId: id }))).toMatchObject({
      trpc: 'PRECONDITION_FAILED',
      code: 'identity.sub_account_switch_frozen',
    });
    await db.sql`UPDATE sub_accounts SET frozen = 0, revoked = true WHERE id = ${id}`;
    expect((await refusal(caller.subAccounts.switchTo({ subAccountId: id }))).code).toBe('identity.sub_account_revoked');
    const { id: other } = await auth.createSubAccount(user.userId, 'desk2', undefined);
    await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${user.userId}`;
    expect((await refusal(caller.subAccounts.switchTo({ subAccountId: other }))).code).toBe('auth.account_frozen');
    // A refused issue is not a switch: nothing is recorded for the owner's interval.
    expect(await db.sql`SELECT 1 FROM sub_account_switches WHERE sub_account_id = ${other}`).toHaveLength(0);
  });

  it("the edge's per-request authority read refuses a switch token once its sub-account is frozen or revoked", async () => {
    const user = await register();
    const caller = await callerOf(user);
    const controls = new FounderControls(db.sql, null);
    const authorityOf = async (token: string) => {
      const p = await verifyAccessToken(token, tokenConfig);
      return controls.currentAuthority({
        userId: p.userId,
        credential: { kind: 'session', sessionId: p.sid },
        ...(p.sub_account ? { subAccountId: p.sub_account } : {}),
      });
    };
    const { id } = await auth.createSubAccount(user.userId, 'desk', undefined);
    const { id: other } = await auth.createSubAccount(user.userId, 'desk2', undefined);
    const a = (await caller.subAccounts.switchTo({ subAccountId: id })).accessToken;
    const b = (await caller.subAccounts.switchTo({ subAccountId: other })).accessToken;
    expect(await authorityOf(a)).toMatchObject({ status: 'eligible' });
    await db.sql`UPDATE sub_accounts SET frozen = 1 WHERE id = ${id}`;
    expect(await authorityOf(a)).toMatchObject({ status: 'denied', code: 'auth.sub_account_denied' });
    await auth.revokeSubAccount(user.userId, other);
    expect(await authorityOf(b)).toMatchObject({ status: 'denied', code: 'auth.sub_account_denied' });
    // The main session is untouched.
    expect(await authorityOf(user.accessToken)).toMatchObject({ status: 'eligible' });
  });

  it("applies the owner's minimum interval only when it is set", async () => {
    const user = await register();
    const caller = await callerOf(user);
    const { id } = await auth.createSubAccount(user.userId, 'desk', undefined);
    await caller.subAccounts.switchTo({ subAccountId: id });
    await caller.subAccounts.switchTo({ subAccountId: id });
    minSeconds = 60;
    clock = new Date(Date.now() + 30_000);
    expect(await refusal(caller.subAccounts.switchTo({ subAccountId: id }))).toMatchObject({
      trpc: 'TOO_MANY_REQUESTS',
      code: 'identity.sub_account_switch_too_soon',
    });
    clock = new Date(Date.now() + 61_000);
    await expect(caller.subAccounts.switchTo({ subAccountId: id })).resolves.toMatchObject({ subAccountId: id });
  });

  it('refuses identity.sub_account_switch_unavailable when the service is not wired', async () => {
    const user = await register();
    const { id } = await auth.createSubAccount(user.userId, 'desk', undefined);
    const bare = mergeRouters(createIdentityRouter(auth, rank, { registrationOpen: true }), createStepUpRouter(stepUps));
    const off = await refusal(bare.createCaller(await ctxOf(user)).subAccounts.switchTo({ subAccountId: id }));
    expect(off).toMatchObject({ trpc: 'PRECONDITION_FAILED', code: 'identity.sub_account_switch_unavailable' });
  });
}
