/**
 * Sub-account delete against Postgres: revoke-only, refused while the money services show assets or open orders,
 * refused when they cannot be read, one step-up per delete.
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
import type { ClosureCheckResult } from '../closure/closure-client.js';
import { SubAccountDeleteService } from './sub-account-delete.js';

void _unused;

function identityTestUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const parsed = new URL(raw);
  if (!parsed.pathname.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

const DATABASE_URL = identityTestUrl();
const PASSWORD = 'correct horse battery staple';
const SCOPE = 'identity.step_up.sub_account_delete' as const;
const tokenConfig = {
  secret: 'an-identity-sub-account-delete-test-secret-long-enough',
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
  describe.skip('sub-account delete (Postgres unavailable)', () => {
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
  let bankResult: ClosureCheckResult = { ok: true, blockers: [], balances: [] };
  let tradeResult: ClosureCheckResult = { ok: true, blockers: [], balances: [] };
  const asked: Array<{ userId: string; subAccountIds: readonly string[]; scope?: string }> = [];
  const subAccountDelete = new SubAccountDeleteService({
    sql: db.sql,
    approvals,
    bank: {
      check: async (input) => {
        asked.push(input);
        return bankResult;
      },
    },
    trade: { check: async () => tradeResult },
  });
  const api = mergeRouters(createIdentityRouter(auth, rank, { registrationOpen: true, subAccountDelete }), createStepUpRouter(stepUps));

  let n = 0;
  const unique = () => `sd${process.pid}x${++n}`;

  beforeEach(async () => {
    await db.truncateAll();
    await rank.seedTiers();
    bankResult = { ok: true, blockers: [], balances: [] };
    tradeResult = { ok: true, blockers: [], balances: [] };
    asked.length = 0;
  });
  afterAll(async () => {
    await db.drop();
  });

  async function ctxOf(tokens: SessionTokens, extra: Record<string, unknown> = {}): Promise<Context> {
    const principal = await verifyAccessToken(tokens.accessToken, tokenConfig);
    return { principal: { ...principal, ...extra }, service: null, region: 'DE', requestId: 'req-subdelete' };
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
  async function mint(tokens: SessionTokens, subAccountId: string, clientRequestId: string, secret: string) {
    await db.sql`UPDATE users SET totp_last_step = NULL WHERE id = ${tokens.userId}`;
    const caller = await callerOf(tokens);
    const begun = await caller.stepUp.begin({
      scope: SCOPE,
      purpose: 'account.subAccount.delete',
      target: subAccountId,
      fields: { subAccountId, clientRequestId },
    });
    const done = await caller.stepUp.complete({ challengeId: begun.challengeId, totpCode: totp(secret) });
    return done.stepUpApprovalId;
  }
  async function refusal(run: Promise<unknown>) {
    try {
      await run;
    } catch (err) {
      const wrapped = err as TRPCError & { cause?: { code?: string; blockers?: unknown } };
      return { trpc: wrapped.code, code: wrapped.cause?.code, blockers: wrapped.cause?.blockers };
    }
    throw new Error('expected a refusal');
  }
  const revokedOf = async (id: string) =>
    (await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM sub_accounts WHERE id = ${id}`)[0]?.revoked;

  it('deletes an empty sub-account once, asks the money services about that sub-account only, and is idempotent', async () => {
    const user = await register();
    const secret = await enrolTotp(user.userId);
    const caller = await callerOf(user);
    const { id } = await auth.createSubAccount(user.userId, 'desk', undefined);
    expect(await caller.subAccounts.deleteCheck({ subAccountId: id })).toEqual({ blockers: [], balances: [] });
    const clientRequestId = randomUUID();
    const approval = await mint(user, id, clientRequestId, secret);
    expect(await caller.subAccounts.delete({ subAccountId: id, stepUpApprovalId: approval, clientRequestId })).toEqual({
      deleted: true,
      changed: true,
    });
    expect(await revokedOf(id)).toBe(true);
    expect(asked.every((a) => a.scope === 'sub_accounts' && a.subAccountIds.length === 1 && a.subAccountIds[0] === id)).toBe(true);
    // Again: same answer, nothing new spent.
    expect(await caller.subAccounts.delete({ subAccountId: id, stepUpApprovalId: approval, clientRequestId })).toEqual({
      deleted: true,
      changed: false,
    });
  });

  it('refuses while the sub-account has assets or open orders, and when a service cannot be read', async () => {
    const user = await register();
    const secret = await enrolTotp(user.userId);
    const caller = await callerOf(user);
    const { id } = await auth.createSubAccount(user.userId, 'desk', undefined);

    bankResult = { ok: true, blockers: [{ code: 'balance_remaining', count: 1 }], balances: [{ assetId: 'USDT', amount: '1.50' }] };
    expect(await caller.subAccounts.deleteCheck({ subAccountId: id })).toEqual({
      blockers: [{ code: 'balance_remaining', count: 1 }],
      balances: [{ assetId: 'USDT', amount: '1.50' }],
    });
    const a = randomUUID();
    const withAssets = await refusal(
      caller.subAccounts.delete({ subAccountId: id, stepUpApprovalId: await mint(user, id, a, secret), clientRequestId: a }),
    );
    expect(withAssets).toMatchObject({ code: 'identity.sub_account_delete_blocked', blockers: [{ code: 'balance_remaining', count: 1 }] });

    bankResult = { ok: true, blockers: [], balances: [] };
    tradeResult = { ok: true, blockers: [{ code: 'open_order', count: 2 }], balances: [] };
    const b = randomUUID();
    const withOrders = await refusal(
      caller.subAccounts.delete({ subAccountId: id, stepUpApprovalId: await mint(user, id, b, secret), clientRequestId: b }),
    );
    expect(withOrders).toMatchObject({ code: 'identity.sub_account_delete_blocked', blockers: [{ code: 'open_order', count: 2 }] });

    tradeResult = { ok: false };
    const c = randomUUID();
    const down = await refusal(
      caller.subAccounts.delete({ subAccountId: id, stepUpApprovalId: await mint(user, id, c, secret), clientRequestId: c }),
    );
    expect(down.code).toBe('identity.sub_account_check_unavailable');
    expect((await refusal(caller.subAccounts.deleteCheck({ subAccountId: id }))).code).toBe('identity.sub_account_check_unavailable');
    expect(await revokedOf(id)).toBe(false);
  });

  it('refuses a stranger, an unknown id, an API key, a sub-account principal and a missing or wrong step-up', async () => {
    const user = await register();
    const other = await register();
    const secret = await enrolTotp(user.userId);
    const caller = await callerOf(user);
    const { id } = await auth.createSubAccount(user.userId, 'desk', undefined);
    const otherSub = await auth.createSubAccount(other.userId, 'theirs', undefined);
    const rid = randomUUID();
    const approval = await mint(user, id, rid, secret);

    expect(
      (await refusal(caller.subAccounts.delete({ subAccountId: otherSub.id, stepUpApprovalId: approval, clientRequestId: rid }))).code,
    ).toBe('identity.sub_account_not_found');
    expect((await refusal(caller.subAccounts.deleteCheck({ subAccountId: randomUUID() }))).code).toBe('identity.sub_account_not_found');
    const keyed = await callerOf(user, { kid: 'key-1' });
    expect((await refusal(keyed.subAccounts.delete({ subAccountId: id, stepUpApprovalId: approval, clientRequestId: rid }))).code).toBe(
      'identity.sub_account_delete_delegated',
    );
    const subPrincipal = await callerOf(user, { sub_account: id });
    expect((await refusal(subPrincipal.subAccounts.deleteCheck({ subAccountId: id }))).code).toBe('identity.sub_account_delete_delegated');
    // A step-up minted for another sub-account does not open this one.
    const wrong = await refusal(caller.subAccounts.delete({ subAccountId: id, stepUpApprovalId: randomUUID(), clientRequestId: rid }));
    expect(wrong.trpc).toBe('PRECONDITION_FAILED');
    const second = await auth.createSubAccount(user.userId, 'other desk', undefined);
    const forFirst = await mint(user, id, rid, secret);
    const mismatch = await refusal(
      caller.subAccounts.delete({ subAccountId: second.id, stepUpApprovalId: forFirst, clientRequestId: rid }),
    );
    expect(mismatch.code).toBe('identity.step_up_target');
    expect(await revokedOf(second.id)).toBe(false);
    expect(await revokedOf(id)).toBe(false);
  });
}
