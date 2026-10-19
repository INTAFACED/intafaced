/**
 * Account closure against Postgres. Each case fails on main: there is no door.
 * Closing does not erase history and does not delete the user.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { SESSION_SCOPES, issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { mergeRouters, retainRawBody, serviceAuthHeadersForBody, TRPCError, type Context } from '@intafaced/contracts';
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
import type { ClosureBalance, ClosureBlocker, ClosureCheckResult } from './closure-client.js';
import { registerClosureFinalize } from './closure-job.js';
import { createClosureOpsRouter } from './closure-ops-router.js';
import { AccountClosureService, type ClosureDeps } from './closure-service.js';

function identityTestUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const parsed = new URL(raw);
  if (!parsed.pathname.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

const DATABASE_URL = identityTestUrl();
const PASSWORD = 'correct horse battery staple';
const CLOSE_SCOPE = 'identity.step_up.close_account' as const;
const SECRET = 'identity-closure-job-secret-at-least-32-characters';
const tokenConfig = {
  secret: 'an-identity-account-closure-test-secret-long-enough',
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

describe('closure diff', () => {
  it('greps the identity closure diff and finds no delete of users, profiles, or ledger rows', () => {
    const diff = execFileSync('git', ['diff', 'origin/main', '--', 'services/svc-identity'], {
      cwd: join(here, '..', '..', '..', '..'),
      encoding: 'utf8',
    });
    const files = ['closure-service.ts', 'closure-job.ts', 'closure-router.ts', 'closure-ops-router.ts', 'closure-client.ts'].map((name) =>
      readFileSync(join(here, name), 'utf8'),
    );
    files.push(readFileSync(join(drizzleDir, '0048_account_closures.sql'), 'utf8'));
    const text = `${diff}\n${files.join('\n')}`;
    expect(text).not.toMatch(/DELETE\s+FROM\s+("?identity"?\.)?"?users"?/i);
    expect(text).not.toMatch(/DELETE\s+FROM\s+("?identity"?\.)?"?profiles"?/i);
    expect(text).not.toMatch(/DELETE\s+FROM\s+("?ledger"?\.)/i);
    expect(text).not.toMatch(/data\.erase\s*\(/);
    expect(text).not.toMatch(/ledger\.balances/);
  });
});

const available = await postgresAvailable(DATABASE_URL);

if (!available) {
  describe.skip('account closure (Postgres unavailable)', () => {
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
  let enabled = true;
  let coolingOffDays: number | undefined = 7;
  let founderUserIds: string[] = [];
  let bankResult: ClosureCheckResult = { ok: true, blockers: [], balances: [] };
  let tradeResult: ClosureCheckResult = { ok: true, blockers: [], balances: [] };
  let p2pResult: ClosureCheckResult = { ok: true, blockers: [], balances: [] };
  let now = new Date('2026-10-18T00:00:00.000Z');
  const deps = {
    sql: db.sql,
    approvals,
    get enabled() {
      return enabled;
    },
    get coolingOffDays() {
      return coolingOffDays;
    },
    get founderUserIds() {
      return founderUserIds;
    },
    bank: { check: async () => bankResult },
    trade: { check: async () => tradeResult },
    p2p: { check: async () => p2pResult },
    now: () => now,
  } as ClosureDeps;
  const closure = new AccountClosureService(deps);
  const api = mergeRouters(
    createIdentityRouter(auth, rank, { registrationOpen: true, closure }),
    createStepUpRouter(stepUps),
    createClosureOpsRouter(db.sql),
  );
  const job = Fastify();
  retainRawBody(job);
  registerClosureFinalize(job, { secret: SECRET, closure });

  let n = 0;
  const unique = () => `cl${process.pid}x${++n}`;

  beforeEach(async () => {
    await db.truncateAll();
    await rank.seedTiers();
    enabled = true;
    coolingOffDays = 7;
    founderUserIds = [];
    bankResult = { ok: true, blockers: [], balances: [] };
    tradeResult = { ok: true, blockers: [], balances: [] };
    p2pResult = { ok: true, blockers: [], balances: [] };
    now = new Date('2026-10-18T00:00:00.000Z');
  });

  afterAll(async () => {
    await job.close();
    await db.drop();
  });

  async function ctxOf(tokens: SessionTokens, extra: Record<string, unknown> = {}): Promise<Context> {
    const principal = await verifyAccessToken(tokens.accessToken, tokenConfig);
    return { principal: { ...principal, ...extra }, service: null, region: 'DE', requestId: 'req-acctclose' };
  }

  const callerOf = async (tokens: SessionTokens, extra?: Record<string, unknown>) => api.createCaller(await ctxOf(tokens, extra));

  async function register() {
    const handle = unique();
    const email = `${handle}@example.com`;
    const session = await auth.register({ handle, email, password: PASSWORD, region: 'DE' });
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

  async function mint(tokens: SessionTokens, intent: 'request' | 'cancel', clientRequestId: string, secret: string) {
    await db.sql`UPDATE users SET totp_last_step = NULL WHERE id = ${tokens.userId}`;
    const caller = await callerOf(tokens);
    const begun = await caller.stepUp.begin({
      scope: CLOSE_SCOPE,
      purpose: 'account.close',
      target: clientRequestId,
      fields: { intent, clientRequestId },
    });
    const done = await caller.stepUp.complete({ challengeId: begun.challengeId, totpCode: totp(secret) });
    return done.stepUpApprovalId;
  }

  async function refusal(run: Promise<unknown>) {
    try {
      await run;
    } catch (err) {
      const wrapped = err as TRPCError & { cause?: { code?: string; blockers?: ClosureBlocker[]; balances?: ClosureBalance[] } };
      return {
        trpc: wrapped.code,
        code: wrapped.cause?.code,
        blockers: wrapped.cause?.blockers,
        balances: wrapped.cause?.balances,
        message: wrapped.message,
      };
    }
    throw new Error('expected a refusal');
  }

  async function stored(userId: string) {
    const rows = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM account_closures WHERE user_id = ${userId}`;
    return rows[0]?.n ?? 0;
  }

  describe('request and cancel', () => {
    it('refuses flag off, blank days, frozen, founder, restricted, and an API key, and stores nothing', async () => {
      const user = await register();
      const caller = await callerOf(user);
      const clientRequestId = randomUUID();
      enabled = false;
      const off = await refusal(caller.accountClosure.request({ stepUpApprovalId: randomUUID(), clientRequestId }));
      expect(off.code).toBe('identity.close_disabled');
      expect(await stored(user.userId)).toBe(0);

      enabled = true;
      coolingOffDays = undefined;
      const blank = await refusal(caller.accountClosure.request({ stepUpApprovalId: randomUUID(), clientRequestId }));
      expect(blank.code).toBe('identity.close_cooling_off_unset');
      expect(await stored(user.userId)).toBe(0);

      coolingOffDays = 7;
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${user.userId}`;
      const frozen = await refusal(caller.accountClosure.request({ stepUpApprovalId: randomUUID(), clientRequestId }));
      expect(frozen.code).toBe('identity.close_account_not_active');
      await db.sql`UPDATE users SET status = 'active' WHERE id = ${user.userId}`;

      founderUserIds = [user.userId];
      const founder = await refusal(caller.accountClosure.request({ stepUpApprovalId: randomUUID(), clientRequestId }));
      expect(founder.code).toBe('identity.close_founder_forbidden');
      founderUserIds = [];

      await db.sql`INSERT INTO trading_restrictions (user_id, restricted, version) VALUES (${user.userId}, true, 1)`;
      const restricted = await refusal(caller.accountClosure.request({ stepUpApprovalId: randomUUID(), clientRequestId }));
      expect(restricted.code).toBe('identity.close_restricted');
      await db.sql`DELETE FROM trading_restrictions WHERE user_id = ${user.userId}`;

      const keyed = await callerOf(user, { kid: 'key-1' });
      const apiKey = await refusal(keyed.accountClosure.request({ stepUpApprovalId: randomUUID(), clientRequestId }));
      expect(apiKey.code).toBe('identity.close_delegated');
      expect(await stored(user.userId)).toBe(0);
    });

    it('refuses a blocker from each service and an unavailable check, and stores nothing', async () => {
      const user = await register();
      const secret = await enrolTotp(user.userId);
      const caller = await callerOf(user);
      bankResult = { ok: true, blockers: [{ code: 'balance_remaining', count: 1 }], balances: [{ assetId: 'USDT', amount: '1.50' }] };
      const bankId = randomUUID();
      const bank = await refusal(
        caller.accountClosure.request({ stepUpApprovalId: await mint(user, 'request', bankId, secret), clientRequestId: bankId }),
      );
      expect(bank.code).toBe('identity.close_blocked');
      expect(bank.blockers).toEqual([{ code: 'balance_remaining', count: 1 }]);
      expect(bank.balances).toEqual([{ assetId: 'USDT', amount: '1.50' }]);
      expect(bank.message).toBe('Something on this account is still open. Clear it, then try again.');

      bankResult = { ok: true, blockers: [], balances: [] };
      tradeResult = { ok: true, blockers: [{ code: 'open_order', count: 2 }], balances: [] };
      const tradeId = randomUUID();
      const trade = await refusal(
        caller.accountClosure.request({ stepUpApprovalId: await mint(user, 'request', tradeId, secret), clientRequestId: tradeId }),
      );
      expect(trade.blockers).toEqual([{ code: 'open_order', count: 2 }]);

      tradeResult = { ok: true, blockers: [], balances: [] };
      p2pResult = { ok: true, blockers: [{ code: 'open_trade', count: 1 }], balances: [] };
      const p2pId = randomUUID();
      const p2p = await refusal(
        caller.accountClosure.request({ stepUpApprovalId: await mint(user, 'request', p2pId, secret), clientRequestId: p2pId }),
      );
      expect(p2p.blockers).toEqual([{ code: 'open_trade', count: 1 }]);

      p2pResult = { ok: false };
      const downId = randomUUID();
      const down = await refusal(
        caller.accountClosure.request({ stepUpApprovalId: await mint(user, 'request', downId, secret), clientRequestId: downId }),
      );
      expect(down.code).toBe('identity.close_check_unavailable');
      expect(await stored(user.userId)).toBe(0);
    });

    it('stores a clean request at now plus the published days, replays it, and refuses a second open row', async () => {
      const user = await register();
      const secret = await enrolTotp(user.userId);
      const caller = await callerOf(user);
      const clientRequestId = randomUUID();
      const opened = await caller.accountClosure.request({
        stepUpApprovalId: await mint(user, 'request', clientRequestId, secret),
        clientRequestId,
      });
      expect(opened.status).toBe('requested');
      expect(opened.effectiveAt).toBe(new Date(now.getTime() + 7 * 86_400_000).toISOString());
      expect(opened.clientRequestId).toBe(clientRequestId);
      const replay = await caller.accountClosure.request({ stepUpApprovalId: randomUUID(), clientRequestId });
      expect(replay.id).toBe(opened.id);
      const otherId = randomUUID();
      const second = await caller.accountClosure.request({ stepUpApprovalId: randomUUID(), clientRequestId: otherId });
      expect(second.id).toBe(opened.id);
      expect(await stored(user.userId)).toBe(1);
    });

    it('cancels with a fresh step-up and then allows one new request', async () => {
      const user = await register();
      const secret = await enrolTotp(user.userId);
      const caller = await callerOf(user);
      const clientRequestId = randomUUID();
      const opened = await caller.accountClosure.request({
        stepUpApprovalId: await mint(user, 'request', clientRequestId, secret),
        clientRequestId,
      });
      const cancelled = await caller.accountClosure.cancel({ stepUpApprovalId: await mint(user, 'cancel', clientRequestId, secret) });
      expect(cancelled.id).toBe(opened.id);
      expect(cancelled.status).toBe('cancelled');
      const againId = randomUUID();
      const again = await caller.accountClosure.request({
        stepUpApprovalId: await mint(user, 'request', againId, secret),
        clientRequestId: againId,
      });
      expect(again.id).not.toBe(opened.id);
      expect(again.status).toBe('requested');
    });

    it('refuses a step-up for another door or another user', async () => {
      const user = await register();
      const other = await register();
      const secret = await enrolTotp(user.userId);
      const otherSecret = await enrolTotp(other.userId);
      const caller = await callerOf(user);
      const emailCaller = await callerOf(user);
      const begun = await emailCaller.stepUp.begin({
        scope: 'identity.step_up.email_change',
        purpose: 'account.email.change',
        target: 'next@example.com',
        fields: { newEmail: 'next@example.com' },
      });
      const email = await emailCaller.stepUp.complete({ challengeId: begun.challengeId, totpCode: nextCode(secret) });
      const wrongDoor = await refusal(
        caller.accountClosure.request({ stepUpApprovalId: email.stepUpApprovalId, clientRequestId: randomUUID() }),
      );
      expect(wrongDoor.code).toBe('identity.step_up_target');

      const foreignId = randomUUID();
      const foreign = await mint(other, 'request', foreignId, otherSecret);
      const notYours = await refusal(caller.accountClosure.request({ stepUpApprovalId: foreign, clientRequestId: foreignId }));
      expect(notYours.code).toBe('identity.step_up_not_yours');
      expect(await stored(user.userId)).toBe(0);
    });
  });

  describe('finalise', () => {
    async function openClean() {
      const user = await register();
      const secret = await enrolTotp(user.userId);
      const caller = await callerOf(user);
      const clientRequestId = randomUUID();
      await caller.accountClosure.request({ stepUpApprovalId: await mint(user, 'request', clientRequestId, secret), clientRequestId });
      const key = await auth.createApiKey({ userId: user.userId, name: 'maker', scopes: ['trade:write'], grantorScopes: SESSION_SCOPES });
      return { user, key };
    }

    it('does nothing before the date', async () => {
      const { user } = await openClean();
      expect(await closure.finalize(10)).toEqual({ closed: 0, blocked: 0 });
      const status = await db.sql<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${user.userId}`;
      expect(status[0]?.status).toBe('active');
      const refreshed = await auth.refresh(user.refreshToken);
      expect(refreshed.userId).toBe(user.userId);
    });

    it('blocks finalising when a balance appears or a service is down, and the account keeps working', async () => {
      const balance = await openClean();
      now = new Date('2026-10-25T00:00:00.000Z');
      bankResult = {
        ok: true,
        blockers: [{ code: 'balance_remaining', count: 1 }],
        balances: [{ assetId: 'USDT', amount: '0.000000000000000001' }],
      };
      expect(await closure.finalize(10)).toEqual({ closed: 0, blocked: 1 });
      const still = await db.sql<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${balance.user.userId}`;
      expect(still[0]?.status).toBe('active');
      const refreshed = await auth.refresh(balance.user.refreshToken);
      expect(refreshed.userId).toBe(balance.user.userId);

      now = new Date('2026-10-18T00:00:00.000Z');
      bankResult = { ok: true, blockers: [], balances: [] };
      const down = await openClean();
      now = new Date('2026-10-25T00:00:00.000Z');
      p2pResult = { ok: false };
      expect(await closure.finalize(10)).toEqual({ closed: 0, blocked: 1 });
      const alive = await db.sql<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${down.user.userId}`;
      expect(alive[0]?.status).toBe('active');
    });

    it('closes once after the date, refuses sign-in, refresh, and API keys, and keeps the user row', async () => {
      const { user, key } = await openClean();
      now = new Date('2026-10-25T00:00:00.000Z');
      const [first, second] = await Promise.all([closure.finalize(10), closure.finalize(10)]);
      expect(first.closed + second.closed).toBe(1);
      const row = await db.sql<Array<{ status: string; email: string; handle: string }>>`
        SELECT status, email::text AS email, handle::text AS handle FROM users WHERE id = ${user.userId}
      `;
      expect(row[0]).toMatchObject({ status: 'closed', email: user.email, handle: user.handle });
      await expect(auth.login({ identifier: user.email, password: PASSWORD })).rejects.toMatchObject({ code: 'auth.account_frozen' });
      await expect(auth.refresh(user.refreshToken)).rejects.toBeTruthy();
      expect(await auth.verifyApiKey(key.key)).toBeNull();
      await expect(
        auth.register({ handle: user.handle, email: `new-${user.handle}@example.com`, password: PASSWORD, region: 'DE' }),
      ).rejects.toMatchObject({
        code: 'auth.handle_taken',
      });
      await expect(
        auth.register({ handle: `new-${user.handle}`, email: user.email, password: PASSWORD, region: 'DE' }),
      ).rejects.toMatchObject({
        code: 'auth.email_taken',
      });
    });

    it('refuses a blank finalize limit', async () => {
      const raw = JSON.stringify({});
      const missing = await job.inject({
        method: 'POST',
        url: '/internal/jobs/finalize-account-closures',
        payload: raw,
        headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-identity', SECRET, raw) },
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toMatchObject({ code: 'identity.close_finalize_limit_unset' });
      const unsigned = await job.inject({
        method: 'POST',
        url: '/internal/jobs/finalize-account-closures',
        payload: JSON.stringify({ limit: 10 }),
        headers: { 'content-type': 'application/json' },
      });
      expect(unsigned.statusCode).toBe(401);
    });
  });

  describe('founder desk', () => {
    it('lists and pages closure requests for admin:compliance only, with no email', async () => {
      const a = await register();
      const b = await register();
      const c = await register();
      const times = ['2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z', '2026-10-03T00:00:00.000Z'];
      const people = [a, b, c];
      for (let i = 0; i < people.length; i += 1) {
        await db.sql`
          INSERT INTO account_closures (user_id, status, requested_at, effective_at, blockers, client_request_id)
          VALUES (
            ${people[i]!.userId},
            ${i === 0 ? 'cancelled' : 'requested'},
            ${new Date(times[i]!)},
            ${new Date(times[i]!)},
            ${db.sql.json([{ code: 'open_order', count: 1 }])},
            ${randomUUID()}
          )
        `;
      }
      const operatorToken = await issueAccessToken(
        { userId: randomUUID(), sessionId: randomUUID(), scopes: ['admin:compliance'], tier: 'none', mfa: true },
        tokenConfig,
      );
      const operator = api.createCaller({
        principal: await verifyAccessToken(operatorToken.token, tokenConfig),
        service: null,
        region: 'DE',
        requestId: 'desk',
      });
      const customer = await callerOf(a);
      const noScopeToken = await issueAccessToken(
        { userId: randomUUID(), sessionId: randomUUID(), scopes: ['identity:read'], tier: 'none', mfa: true },
        tokenConfig,
      );
      const noScope = api.createCaller({
        principal: await verifyAccessToken(noScopeToken.token, tokenConfig),
        service: null,
        region: 'DE',
        requestId: 'desk',
      });
      expect((await refusal(customer.accountClosures.list({ limit: 10 }))).trpc).toBe('FORBIDDEN');
      expect((await refusal(noScope.accountClosures.list({ limit: 10 }))).trpc).toBe('FORBIDDEN');
      expect((await refusal(operator.accountClosures.list({}))).code).toBe('identity.closure_list_limit_unset');

      const first = await operator.accountClosures.list({ limit: 2 });
      const second = await operator.accountClosures.list({ limit: 2, cursor: first.nextCursor ?? undefined });
      const ids = [...first.rows, ...second.rows].map((row) => row.userId);
      expect(ids).toEqual([c.userId, b.userId, a.userId]);
      expect(new Set(ids).size).toBe(3);
      expect(second.nextCursor).toBeNull();
      for (const row of first.rows) {
        expect(Object.keys(row).sort()).toEqual(['blockerCodes', 'effectiveAt', 'handle', 'requestedAt', 'status', 'userId']);
        expect(JSON.stringify(row)).not.toMatch(/email|balances|name/i);
      }
      const requested = await operator.accountClosures.list({ status: 'requested', limit: 10 });
      expect(requested.rows.map((row) => row.userId).sort()).toEqual([b.userId, c.userId].sort());
      const src = readFileSync(join(here, 'closure-ops-router.ts'), 'utf8');
      expect(src).not.toMatch(/\b(cancel|finalize|reopen)\s*:/);
    });
  });
}
