/**
 * Sub-account label and purpose edit against Postgres (RC-identity-14, TRD-0707): parent only, step-up, the id never
 * changes, every change audited with the old and new text, a repeat with the same values answers changed:false.
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
import { SubAccountEditService } from './sub-account-edit.js';

void _unused;

function identityTestUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const parsed = new URL(raw);
  if (!parsed.pathname.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

const DATABASE_URL = identityTestUrl();
const PASSWORD = 'correct horse battery staple';
const SCOPE = 'identity.step_up.sub_account_edit' as const;
const tokenConfig = {
  secret: 'an-identity-sub-account-edit-test-secret-x-long-enough',
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
  describe.skip('sub-account edit (Postgres unavailable)', () => {
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
  const subAccountEdit = new SubAccountEditService({ sql: db.sql, approvals });
  const api = mergeRouters(createIdentityRouter(auth, rank, { registrationOpen: true, subAccountEdit }), createStepUpRouter(stepUps));

  let n = 0;
  const unique = () => `se${process.pid}x${++n}`;

  beforeEach(async () => {
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    await db.drop();
  });

  async function ctxOf(tokens: SessionTokens, extra: Record<string, unknown> = {}): Promise<Context> {
    const principal = await verifyAccessToken(tokens.accessToken, tokenConfig);
    return { principal: { ...principal, ...extra }, service: null, region: 'DE', requestId: 'req-subedit' };
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
  async function mint(
    tokens: SessionTokens,
    subAccountId: string,
    label: string,
    purpose: string,
    clientRequestId: string,
    secret: string,
  ) {
    await db.sql`UPDATE users SET totp_last_step = NULL WHERE id = ${tokens.userId}`;
    const caller = await callerOf(tokens);
    const begun = await caller.stepUp.begin({
      scope: SCOPE,
      purpose: 'account.subAccount.edit',
      target: subAccountId,
      fields: { subAccountId, label, purpose, clientRequestId },
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
    (
      await db.sql<
        Array<{ id: string; label: string; purpose: string | null }>
      >`SELECT id, label, purpose FROM sub_accounts WHERE id = ${id}`
    )[0];
  const auditOf = async (id: string) =>
    db.sql<Array<{ old_label: string; new_label: string; old_purpose: string | null; new_purpose: string | null }>>`
      SELECT old_label, new_label, old_purpose, new_purpose FROM sub_account_label_audit WHERE sub_account_id = ${id} ORDER BY at`;

  it('changes the label and purpose, keeps the same id, audits old and new text, and a repeat answers changed:false', async () => {
    const user = await register();
    const secret = await enrolTotp(user.userId);
    const caller = await callerOf(user);
    const { id } = await auth.createSubAccount(user.userId, 'Desk 1', 'scalping');
    const clientRequestId = randomUUID();
    const approval = await mint(user, id, 'Desk 2', 'hedging', clientRequestId, secret);
    expect(
      await caller.subAccounts.update({
        subAccountId: id,
        label: 'Desk 2',
        purpose: 'hedging',
        stepUpApprovalId: approval,
        clientRequestId,
      }),
    ).toEqual({ id, changed: true });
    const listed = await caller.subAccounts.list({ limit: 10 });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id, label: 'Desk 2', purpose: 'hedging' });
    expect(await auditOf(id)).toEqual([{ old_label: 'Desk 1', new_label: 'Desk 2', old_purpose: 'scalping', new_purpose: 'hedging' }]);
    // Same values again: same id, nothing changed, no second audit row, no step-up spent.
    expect(
      await caller.subAccounts.update({
        subAccountId: id,
        label: 'Desk 2',
        purpose: 'hedging',
        stepUpApprovalId: approval,
        clientRequestId,
      }),
    ).toEqual({ id, changed: false });
    expect(await auditOf(id)).toHaveLength(1);
  });

  it('refuses without a step-up bound to these exact values', async () => {
    const user = await register();
    const secret = await enrolTotp(user.userId);
    const caller = await callerOf(user);
    const { id } = await auth.createSubAccount(user.userId, 'Desk 1', undefined);
    const clientRequestId = randomUUID();
    const approval = await mint(user, id, 'Desk 2', '', clientRequestId, secret);
    const other = await refusal(
      caller.subAccounts.update({ subAccountId: id, label: 'Desk 3', stepUpApprovalId: approval, clientRequestId }),
    );
    expect(other.code).toBe('identity.step_up_target');
    const missing = await refusal(
      caller.subAccounts.update({ subAccountId: id, label: 'Desk 3', stepUpApprovalId: randomUUID(), clientRequestId }),
    );
    expect(missing.code).toBe('identity.step_up_required');
    expect((await rowOf(id))?.label).toBe('Desk 1');
    expect(await auditOf(id)).toHaveLength(0);
  });

  it("refuses a sub-account principal, an API key, another user's sub-account, a revoked one and a 65-character label", async () => {
    const user = await register();
    const stranger = await register();
    const { id } = await auth.createSubAccount(user.userId, 'Desk 1', undefined);
    const input = { subAccountId: id, label: 'Desk 2', stepUpApprovalId: randomUUID(), clientRequestId: randomUUID() };

    const asSub = await refusal((await callerOf(user, { sub_account: id })).subAccounts.update(input));
    expect(asSub).toMatchObject({ trpc: 'FORBIDDEN', code: 'identity.sub_account_edit_delegated' });
    const asKey = await refusal((await callerOf(user, { kid: 'key-1', scopes: ['identity:write'] })).subAccounts.update(input));
    expect(asKey.code).toBe('identity.sub_account_edit_delegated');
    const notYours = await refusal((await callerOf(stranger)).subAccounts.update(input));
    expect(notYours).toMatchObject({ trpc: 'NOT_FOUND', code: 'auth.not_found' });

    const caller = await callerOf(user);
    const tooLong = await refusal(caller.subAccounts.update({ ...input, label: 'x'.repeat(65) }));
    expect(tooLong.trpc).toBe('BAD_REQUEST');
    const control = await refusal(caller.subAccounts.update({ ...input, label: 'Desk\u00072' }));
    expect(control).toMatchObject({ trpc: 'BAD_REQUEST', code: 'identity.sub_account_label_invalid' });

    await db.sql`UPDATE sub_accounts SET revoked = true WHERE id = ${id}`;
    const revoked = await refusal(caller.subAccounts.update(input));
    expect(revoked.code).toBe('identity.sub_account_revoked');
    expect((await rowOf(id))?.label).toBe('Desk 1');
  });
}
