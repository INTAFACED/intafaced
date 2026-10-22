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
import { customerStepUpPayloadHash, mergeRouters, type Context, type TRPCError } from '@intafaced/contracts';
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
  const bare = mergeRouters(createIdentityRouter(auth, rank, { registrationOpen: true }), createStepUpRouter(stepUps));

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
      SELECT old_label, new_label, old_purpose, new_purpose FROM sub_account_label_audit WHERE sub_account_id = ${id} ORDER BY at, id`;
  async function setup() {
    const user = await register();
    const secret = await enrolTotp(user.userId);
    const caller = await callerOf(user);
    const { id } = await auth.createSubAccount(user.userId, 'Desk 1', 'scalping');
    return { user, secret, caller, id };
  }

  it('changes the label and purpose, keeps the same id, audits old and new text, and a repeat answers changed:false', async () => {
    const { user, secret, caller, id } = await setup();
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
        stepUpApprovalId: randomUUID(),
        clientRequestId,
      }),
    ).toEqual({ id, changed: false });
    expect(await auditOf(id)).toHaveLength(1);
  });

  it('edits only the label, keeping the purpose sent as it is', async () => {
    const { user, secret, caller, id } = await setup();
    const c = randomUUID();
    const approval = await mint(user, id, 'Desk 9', 'scalping', c, secret);
    expect(
      await caller.subAccounts.update({
        subAccountId: id,
        label: 'Desk 9',
        purpose: 'scalping',
        stepUpApprovalId: approval,
        clientRequestId: c,
      }),
    ).toEqual({ id, changed: true });
    expect(await rowOf(id)).toEqual({ id, label: 'Desk 9', purpose: 'scalping' });
  });

  it('edits only the purpose, and an empty purpose clears it', async () => {
    const { user, secret, caller, id } = await setup();
    const c = randomUUID();
    const approval = await mint(user, id, 'Desk 1', 'arbitrage', c, secret);
    expect(
      await caller.subAccounts.update({
        subAccountId: id,
        label: 'Desk 1',
        purpose: 'arbitrage',
        stepUpApprovalId: approval,
        clientRequestId: c,
      }),
    ).toEqual({ id, changed: true });
    expect(await rowOf(id)).toEqual({ id, label: 'Desk 1', purpose: 'arbitrage' });
    const d = randomUUID();
    const cleared = await mint(user, id, 'Desk 1', '', d, secret);
    expect(
      await caller.subAccounts.update({ subAccountId: id, label: 'Desk 1', purpose: '', stepUpApprovalId: cleared, clientRequestId: d }),
    ).toEqual({ id, changed: true });
    expect((await rowOf(id))?.purpose).toBeNull();
    expect(await auditOf(id)).toHaveLength(2);
  });

  it('concurrent edits run one after the other: both audited, last writer wins', async () => {
    const { user, secret, caller, id } = await setup();
    const a = randomUUID();
    const b = randomUUID();
    const first = await mint(user, id, 'Desk A', 'scalping', a, secret);
    const second = await mint(user, id, 'Desk B', 'scalping', b, secret);
    const results = await Promise.all([
      caller.subAccounts.update({ subAccountId: id, label: 'Desk A', purpose: 'scalping', stepUpApprovalId: first, clientRequestId: a }),
      caller.subAccounts.update({ subAccountId: id, label: 'Desk B', purpose: 'scalping', stepUpApprovalId: second, clientRequestId: b }),
    ]);
    expect(results.every((r) => r.id === id && r.changed)).toBe(true);
    const audit = await auditOf(id);
    expect(audit).toHaveLength(2);
    expect(audit[1]?.old_label).toBe(audit[0]?.new_label);
    expect((await rowOf(id))?.label).toBe(audit[1]?.new_label);
  });

  it("refuses a step-up bound to other values, a missing one, an expired one, a used one and someone else's", async () => {
    const { user, secret, caller, id } = await setup();
    const c = randomUUID();
    const approval = await mint(user, id, 'Desk 2', 'scalping', c, secret);
    const other = await refusal(
      caller.subAccounts.update({ subAccountId: id, label: 'Desk 3', purpose: 'scalping', stepUpApprovalId: approval, clientRequestId: c }),
    );
    expect(other.code).toBe('identity.step_up_target');
    const missing = await refusal(
      caller.subAccounts.update({
        subAccountId: id,
        label: 'Desk 3',
        purpose: 'scalping',
        stepUpApprovalId: randomUUID(),
        clientRequestId: c,
      }),
    );
    expect(missing.code).toBe('identity.step_up_required');

    const e = randomUUID();
    const expiring = await mint(user, id, 'Desk 4', 'scalping', e, secret);
    await db.sql`UPDATE action_approvals SET expires_at = now() - interval '1 minute' WHERE approval_id = ${expiring}`;
    const expired = await refusal(
      caller.subAccounts.update({ subAccountId: id, label: 'Desk 4', purpose: 'scalping', stepUpApprovalId: expiring, clientRequestId: e }),
    );
    expect(expired.code).toBe('identity.step_up_expired');

    // Used: spend it on Desk 2, move back to Desk 1, then try Desk 2 again with the spent approval.
    await caller.subAccounts.update({
      subAccountId: id,
      label: 'Desk 2',
      purpose: 'scalping',
      stepUpApprovalId: approval,
      clientRequestId: c,
    });
    const back = randomUUID();
    await caller.subAccounts.update({
      subAccountId: id,
      label: 'Desk 1',
      purpose: 'scalping',
      stepUpApprovalId: await mint(user, id, 'Desk 1', 'scalping', back, secret),
      clientRequestId: back,
    });
    const used = await refusal(
      caller.subAccounts.update({ subAccountId: id, label: 'Desk 2', purpose: 'scalping', stepUpApprovalId: approval, clientRequestId: c }),
    );
    expect(used.code).toBe('identity.step_up_used');

    const stranger = await register();
    const strangerSecret = await enrolTotp(stranger.userId);
    const s = randomUUID();
    const theirs = await mint(stranger, id, 'Desk 5', 'scalping', s, strangerSecret);
    // Give the stranger's approval this caller's exact payload, so only the requester check can refuse it.
    const mine = customerStepUpPayloadHash(SCOPE, {
      actor: user.userId,
      subAccountId: id,
      label: 'Desk 5',
      purpose: 'scalping',
      clientRequestId: s,
    });
    await db.sql`UPDATE action_approvals SET payload_hash = ${mine} WHERE approval_id = ${theirs}`;
    const notYours = await refusal(
      caller.subAccounts.update({ subAccountId: id, label: 'Desk 5', purpose: 'scalping', stepUpApprovalId: theirs, clientRequestId: s }),
    );
    expect(notYours.code).toBe('identity.step_up_not_yours');
    expect((await rowOf(id))?.label).toBe('Desk 1');
    expect(await auditOf(id)).toHaveLength(2);
  });

  it("refuses a sub-account principal, an API key, another user's sub-account and a revoked one", async () => {
    const user = await register();
    const stranger = await register();
    const { id } = await auth.createSubAccount(user.userId, 'Desk 1', undefined);
    const input = { subAccountId: id, label: 'Desk 2', purpose: null, stepUpApprovalId: randomUUID(), clientRequestId: randomUUID() };

    const asSub = await refusal((await callerOf(user, { sub_account: id })).subAccounts.update(input));
    expect(asSub).toMatchObject({ trpc: 'FORBIDDEN', code: 'identity.sub_account_edit_delegated' });
    const asKey = await refusal((await callerOf(user, { kid: 'key-1', scopes: ['identity:write'] })).subAccounts.update(input));
    expect(asKey.code).toBe('identity.sub_account_edit_delegated');
    const notYours = await refusal((await callerOf(stranger)).subAccounts.update(input));
    expect(notYours).toMatchObject({ trpc: 'NOT_FOUND', code: 'auth.not_found' });

    await db.sql`UPDATE sub_accounts SET revoked = true WHERE id = ${id}`;
    const revoked = await refusal((await callerOf(user)).subAccounts.update(input));
    expect(revoked.code).toBe('identity.sub_account_revoked');
    expect((await rowOf(id))?.label).toBe('Desk 1');
  });

  it('refuses bad text and a malformed request id with typed codes', async () => {
    const user = await register();
    const caller = await callerOf(user);
    const { id } = await auth.createSubAccount(user.userId, 'Desk 1', undefined);
    const input = { subAccountId: id, label: 'Desk 2', purpose: null, stepUpApprovalId: randomUUID(), clientRequestId: randomUUID() };
    for (const bad of [
      { label: 'x'.repeat(65) },
      { label: '' },
      { label: '   ' },
      { label: 'Desk\u00072' },
      { purpose: 'y'.repeat(201) },
      { purpose: 'line\nbreak' },
    ]) {
      expect(await refusal(caller.subAccounts.update({ ...input, ...bad }))).toMatchObject({
        trpc: 'BAD_REQUEST',
        code: 'identity.sub_account_label_invalid',
      });
    }
    expect(await refusal(caller.subAccounts.update({ ...input, clientRequestId: '-bad id' }))).toMatchObject({
      trpc: 'BAD_REQUEST',
      code: 'identity.client_request_id_invalid',
    });
    expect((await rowOf(id))?.label).toBe('Desk 1');
  });

  it('refuses identity.sub_account_edit_unavailable when the service is not wired', async () => {
    const user = await register();
    const { id } = await auth.createSubAccount(user.userId, 'Desk 1', undefined);
    const caller = bare.createCaller(await ctxOf(user));
    const off = await refusal(
      caller.subAccounts.update({
        subAccountId: id,
        label: 'Desk 2',
        purpose: null,
        stepUpApprovalId: randomUUID(),
        clientRequestId: randomUUID(),
      }),
    );
    expect(off).toMatchObject({ trpc: 'PRECONDITION_FAILED', code: 'identity.sub_account_edit_unavailable' });
  });
}
