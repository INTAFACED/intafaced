/**
 * Organisation security policy against Postgres (I-account-lifecycle-06): owner-only set with step-up and history,
 * the idle maximum, member reads, and the org-call gate (second factor with the enrol link, idle sign-out).
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
import { createStepUpRouter } from '../step-up-router.js';
import { createOrgRouter, enforceOrgSecurityPolicyOn } from '../org-router.js';
import { createOrgSecurityPolicyRouter } from '../org-security-policy-router.js';
import { ActionApprovalService } from '../auth/action-approval-service.js';
import { SqlActionApprovalStore } from '../auth/action-approval-store.js';
import { AuthService, type SessionTokens } from '../auth/auth-service.js';
import { CustomerStepUpService } from '../auth/customer-step-up.js';
import { SqlCustomerStepUpStore } from '../auth/customer-step-up-store.js';
import { totp } from '../auth/totp.js';
import { createOrg } from './org-service.js';
import { OrgSecurityPolicyService } from './org-security-policy.js';

function identityTestUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const parsed = new URL(raw);
  if (!parsed.pathname.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

const DATABASE_URL = identityTestUrl();
const PASSWORD = 'correct horse battery staple';
const SCOPE = 'identity.step_up.org_security_policy' as const;
const tokenConfig = {
  secret: 'an-identity-org-security-policy-test-secret-long-enough',
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

if (!(await postgresAvailable(DATABASE_URL))) {
  describe.skip('org security policy (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_org_policy',
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
  let idleMax: number | undefined;
  const service = new OrgSecurityPolicyService({ sql: db.sql, approvals, idleMaxSeconds: () => idleMax });
  enforceOrgSecurityPolicyOn(db.sql);
  const api = mergeRouters(createOrgRouter(db.sql), createOrgSecurityPolicyRouter(service), createStepUpRouter(stepUps));

  let n = 0;
  const unique = () => `op${process.pid}x${++n}`;

  beforeEach(async () => {
    await db.truncateAll();
    await rank.seedTiers();
    idleMax = 3600;
  });
  afterAll(async () => {
    await db.drop();
  });

  const callerOf = async (tokens: SessionTokens, extra: Record<string, unknown> = {}) => {
    const principal = await verifyAccessToken(tokens.accessToken, tokenConfig);
    return api.createCaller({ principal: { ...principal, ...extra }, service: null, region: 'DE', requestId: 'req-orgpol' } as Context);
  };
  const register = async () => {
    const handle = unique();
    return auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD, region: 'DE' });
  };
  const enrolTotp = async (userId: string) => {
    const started = await auth.startTotpEnrolment(userId, { mfa: false, privileged: false });
    await auth.confirmTotpEnrolment(userId, { mfa: false, privileged: false }, started.secret, totp(started.secret));
    return started.secret;
  };
  const addPasskey = (userId: string) =>
    db.sql`UPDATE users SET webauthn_creds = ${db.sql.json([{ id: `cred-${userId}`, publicKey: 'x', counter: 0 }])} WHERE id = ${userId}`;
  const addMember = (orgId: string, userId: string, role = 'trader') =>
    db.sql`INSERT INTO organization_members (org_id, user_id, role) VALUES (${orgId}, ${userId}, ${role})`;
  async function mint(
    tokens: SessionTokens,
    secret: string,
    f: { orgId: string; memberSecondFactor: string; idle: number | null; c: string },
  ) {
    await db.sql`UPDATE users SET totp_last_step = NULL WHERE id = ${tokens.userId}`;
    const caller = await callerOf(tokens);
    const begun = await caller.stepUp.begin({
      scope: SCOPE,
      purpose: 'org.securityPolicy.set',
      target: f.orgId,
      fields: {
        orgId: f.orgId,
        memberSecondFactor: f.memberSecondFactor,
        idleSignOutSeconds: f.idle === null ? '' : String(f.idle),
        clientRequestId: f.c,
      },
    });
    return (await caller.stepUp.complete({ challengeId: begun.challengeId, totpCode: totp(secret) })).stepUpApprovalId;
  }
  async function setPolicy(
    tokens: SessionTokens,
    secret: string,
    orgId: string,
    memberSecondFactor: 'any' | 'passkey_only' | 'totp_or_passkey',
    idle: number | null,
  ) {
    const c = randomUUID();
    const stepUpApprovalId = await mint(tokens, secret, { orgId, memberSecondFactor, idle, c });
    return (await callerOf(tokens)).orgSecurityPolicy.set({
      orgId,
      memberSecondFactor,
      idleSignOutSeconds: idle,
      stepUpApprovalId,
      clientRequestId: c,
    });
  }
  async function refusal(run: Promise<unknown>) {
    try {
      await run;
    } catch (err) {
      const wrapped = err as TRPCError & { cause?: { code?: string; enrolLink?: string } };
      return { trpc: wrapped.code, code: wrapped.cause?.code, enrolLink: wrapped.cause?.enrolLink };
    }
    throw new Error('expected a refusal');
  }
  async function ownerOrg() {
    const owner = await register();
    const secret = await enrolTotp(owner.userId);
    const org = await createOrg(db.sql, owner.userId, `org-${unique()}`);
    return { owner, secret, orgId: org.id };
  }

  it('no policy: nothing is required, members read not_set, and org calls pass without a second factor', async () => {
    const { orgId } = await ownerOrg();
    const member = await register();
    await addMember(orgId, member.userId);
    const caller = await callerOf(member);
    expect(await caller.orgSecurityPolicy.get({ orgId })).toEqual({ orgId, state: 'not_set' });
    await expect(caller.assertOrgActor({ orgId })).resolves.toMatchObject({ orgId, userId: member.userId });
    expect(await db.sql`SELECT 1 FROM org_session_activity`).toHaveLength(0);
  });

  it('the owner sets the policy with a step-up; history appends; the same values spend nothing', async () => {
    const { owner, secret, orgId } = await ownerOrg();
    expect(await setPolicy(owner, secret, orgId, 'totp_or_passkey', null)).toMatchObject({
      state: 'set',
      memberSecondFactor: 'totp_or_passkey',
      idleSignOutSeconds: null,
      version: 1,
      changed: true,
    });
    expect(await setPolicy(owner, secret, orgId, 'passkey_only', 600)).toMatchObject({
      memberSecondFactor: 'passkey_only',
      idleSignOutSeconds: 600,
      version: 2,
      changed: true,
    });
    const same = await (
      await callerOf(owner)
    ).orgSecurityPolicy.set({
      orgId,
      memberSecondFactor: 'passkey_only',
      idleSignOutSeconds: 600,
      stepUpApprovalId: randomUUID(),
      clientRequestId: 'same-1',
    });
    expect(same).toMatchObject({ version: 2, changed: false });
    expect(
      await db.sql`SELECT version, member_second_factor, idle_sign_out_seconds, changed_by FROM org_security_policy_history ORDER BY version`,
    ).toEqual([
      { version: 1, member_second_factor: 'totp_or_passkey', idle_sign_out_seconds: null, changed_by: owner.userId },
      { version: 2, member_second_factor: 'passkey_only', idle_sign_out_seconds: 600, changed_by: owner.userId },
    ]);
  });

  it('refuses a non-owner (even an org admin), a delegated caller, a missing or wrong step-up, and a bad request id', async () => {
    const { owner, secret, orgId } = await ownerOrg();
    const admin = await register();
    const adminSecret = await enrolTotp(admin.userId);
    await addMember(orgId, admin.userId, 'admin');
    const c = randomUUID();
    const forAdmin = await mint(admin, adminSecret, { orgId, memberSecondFactor: 'passkey_only', idle: null, c });
    expect(
      await refusal(
        (await callerOf(admin)).orgSecurityPolicy.set({
          orgId,
          memberSecondFactor: 'passkey_only',
          idleSignOutSeconds: null,
          stepUpApprovalId: forAdmin,
          clientRequestId: c,
        }),
      ),
    ).toMatchObject({
      trpc: 'FORBIDDEN',
      code: 'identity.org_policy_owner_only',
    });
    const input = {
      orgId,
      memberSecondFactor: 'passkey_only' as const,
      idleSignOutSeconds: null,
      stepUpApprovalId: randomUUID(),
      clientRequestId: 'r-1',
    };
    expect((await refusal((await callerOf(owner, { kid: 'key-1', scopes: ['identity:write'] })).orgSecurityPolicy.set(input))).code).toBe(
      'identity.org_policy_delegated',
    );
    expect((await refusal((await callerOf(owner)).orgSecurityPolicy.set(input))).code).toBe('identity.step_up_required');
    const forOther = await mint(owner, secret, { orgId, memberSecondFactor: 'any', idle: null, c: 'r-2' });
    expect(
      (await refusal((await callerOf(owner)).orgSecurityPolicy.set({ ...input, stepUpApprovalId: forOther, clientRequestId: 'r-2' }))).code,
    ).toBe('identity.step_up_target');
    expect(await refusal((await callerOf(owner)).orgSecurityPolicy.set({ ...input, clientRequestId: '-bad' }))).toMatchObject({
      trpc: 'BAD_REQUEST',
      code: 'identity.client_request_id_invalid',
    });
    expect(await db.sql`SELECT 1 FROM org_security_policies`).toHaveLength(0);
  });

  it('caps the idle time at the owner maximum and refuses any idle value while that maximum is unset', async () => {
    const { owner, secret, orgId } = await ownerOrg();
    idleMax = 600;
    expect((await refusal(setPolicy(owner, secret, orgId, 'any', 601))).code).toBe('identity.org_policy_idle_out_of_range');
    idleMax = undefined;
    expect((await refusal(setPolicy(owner, secret, orgId, 'any', 60))).code).toBe('identity.org_policy_idle_unset');
    // Without an idle value the policy is still settable.
    await expect(setPolicy(owner, secret, orgId, 'totp_or_passkey', null)).resolves.toMatchObject({ changed: true });
  });

  it('passkey_only: a TOTP-only member is refused org actions with the enrol link and keeps the personal account; a passkey member passes', async () => {
    const { owner, secret, orgId } = await ownerOrg();
    const totpMember = await register();
    await enrolTotp(totpMember.userId);
    const keyMember = await register();
    await addPasskey(keyMember.userId);
    await addMember(orgId, totpMember.userId);
    await addMember(orgId, keyMember.userId);
    await setPolicy(owner, secret, orgId, 'passkey_only', null);
    const t = await callerOf(totpMember);
    for (const call of [t.assertOrgActor({ orgId }), t.assertOrgPlace({ orgId }), t.renameOrg({ orgId, name: 'x' })]) {
      expect(await refusal(call)).toMatchObject({ trpc: 'FORBIDDEN', code: 'identity.org_policy_2fa', enrolLink: '/uc/safe' });
    }
    // Personal account and reading the policy still work.
    expect(await t.orgSecurityPolicy.get({ orgId })).toMatchObject({ state: 'set', memberSecondFactor: 'passkey_only' });
    expect((await t.listOrgs()).orgs).toHaveLength(1);
    await expect((await callerOf(keyMember)).assertOrgActor({ orgId })).resolves.toMatchObject({ userId: keyMember.userId });
  });

  it('totp_or_passkey: a member with neither is refused; enrolling TOTP lets the next call through', async () => {
    const { owner, secret, orgId } = await ownerOrg();
    const member = await register();
    await addMember(orgId, member.userId);
    await setPolicy(owner, secret, orgId, 'totp_or_passkey', null);
    expect((await refusal((await callerOf(member)).assertOrgActor({ orgId }))).code).toBe('identity.org_policy_2fa');
    await enrolTotp(member.userId);
    await expect((await callerOf(member)).assertOrgActor({ orgId })).resolves.toMatchObject({ userId: member.userId });
  });

  it('idle: an org call after more than the idle time ends the org context for that session only', async () => {
    const { owner, secret, orgId } = await ownerOrg();
    const member = await register();
    await addMember(orgId, member.userId);
    await setPolicy(owner, secret, orgId, 'any', 60);
    const caller = await callerOf(member);
    await caller.assertOrgActor({ orgId });
    await caller.assertOrgActor({ orgId });
    await db.sql`UPDATE org_session_activity SET last_at = now() - interval '61 seconds'`;
    expect(await refusal(caller.assertOrgActor({ orgId }))).toMatchObject({ trpc: 'FORBIDDEN', code: 'identity.org_session_idle' });
    // Ended stays ended for that session, even right away.
    expect((await refusal(caller.assertOrgActor({ orgId }))).code).toBe('identity.org_session_idle');
    // The personal account and non-org reads are untouched; another session of the same member is not ended.
    expect((await caller.listOrgs()).orgs).toHaveLength(1);
    await expect((await callerOf(member, { sid: randomUUID() })).assertOrgActor({ orgId })).resolves.toMatchObject({
      userId: member.userId,
    });
  });

  it('a non-member gets the org action refusal, never a policy answer, and cannot read the policy', async () => {
    const { owner, secret, orgId } = await ownerOrg();
    await setPolicy(owner, secret, orgId, 'passkey_only', null);
    const stranger = await callerOf(await register());
    const refused = await refusal(stranger.assertOrgActor({ orgId }));
    expect(refused.code).not.toBe('identity.org_policy_2fa');
    expect((await refusal(stranger.orgSecurityPolicy.get({ orgId }))).code).toBe('org.membership_denied');
  });

  it('the service mount turns the policy gate on: index.ts enables it on its sql before building appRouter', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8');
    const enable = src.indexOf('enforceOrgSecurityPolicyOn(sql);');
    expect(enable).toBeGreaterThan(-1);
    expect(enable).toBeLessThan(src.indexOf('export const appRouter = mergeRouters('));
    expect(src).toMatch(/createOrgRouter\(sql,\s*dmaHierarchyLaw\)/);
  });
}
