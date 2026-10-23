import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createFounderAuthority } from '../founder-authority.js';
import { assertOwnerPayScopeStillGranted, teamMerchantStatusesFromSql } from '../owner-pay-grant-recheck.js';
import type { OwnerPayScopeMerchant } from '../merchant-pay-grant-path.js';
import { createMerchantOpsRouter, type MerchantOpsDeps } from './router.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_team_write_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const id = () => randomUUID();
const LIMIT = { maxPerWindow: 2, windowMs: 60_000, ttlMs: 86_400_000 };
const identity = { identityUrl: 'https://identity.invalid', serviceSecret: 's'.repeat(32) };

const principalOf = (userId: string, over: Partial<Principal> = {}): Principal => ({
  userId,
  sub: userId,
  sid: id(),
  scopes: ['pay:read', 'pay:write'],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 600_000),
  ...over,
});
const ctxOf = (principal: Principal): Context => ({ principal, service: null, region: 'DE', requestId: id() });

async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    const err = e as { cause?: { code?: string } };
    return err.cause?.code ?? (e as Error).message;
  }
  throw new Error('expected a refusal');
}

const onboard = (over: Partial<Principal> = {}): Partial<Principal> => ({ scopes: ['pay:onboard'], ...over });

describe('a team member writes on pay:onboard; an owner still needs pay:write (J-merchant-01 #4)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  const founderFetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
  const founderAuthority = createFounderAuthority({ ...identity, fetcher: founderFetcher });
  const deps = (): MerchantOpsDeps => ({ sql, founderAuthority });
  const as = (userId: string, over: Partial<Principal> = {}) =>
    createMerchantOpsRouter(deps()).createCaller(ctxOf(principalOf(userId, over)));

  async function business(kyb: 'approved' | 'pending' | 'none', status = 'active') {
    const owner = id();
    const merchantId = (
      await sql<Array<{ id: string }>>`
        INSERT INTO pay.merchants (user_id, kyb_status, status) VALUES (${owner}, ${kyb}, ${status}) RETURNING id`
    )[0]!.id;
    return { owner, merchantId };
  }
  async function member(merchantId: string, role: string, status = 'active') {
    const userId = id();
    const memberId = (
      await sql<Array<{ id: string }>>`
        INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by)
        VALUES (${merchantId}, ${userId}, ${role}, ${status}, ${id()}) RETURNING id`
    )[0]!.id;
    return { userId, memberId };
  }
  /** The context production builds (index.ts): the live owner-and-team recheck installed. */
  const live = (userId: string, over: Partial<Principal> = {}) => {
    const lookup = async (u: string) =>
      (
        await sql<OwnerPayScopeMerchant[]>`
          SELECT id, user_id AS "userId", kyb_status AS "kybStatus", status, parent_merchant_id AS "parentMerchantId"
            FROM pay.merchants WHERE user_id = ${u} LIMIT 1`
      )[0] ?? null;
    const teamStatuses = teamMerchantStatusesFromSql(sql);
    const context: Context = {
      ...ctxOf(principalOf(userId, onboard(over))),
      ownerPayGrant: { assertStillGranted: (p, scope) => assertOwnerPayScopeStillGranted(p, scope, lookup, teamStatuses) },
    };
    return createMerchantOpsRouter(deps()).createCaller(context);
  };
  const markAll = (userId: string, over: Partial<Principal> = {}) =>
    refusal(() => as(userId, onboard(over)).merchantOps.notifications.markAllRead({}));

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  it('lets an active member of an approved business write what the role table gives the role, and nothing else', async () => {
    const { merchantId } = await business('approved');
    const finance = await member(merchantId, 'finance');
    await expect(as(finance.userId, onboard()).merchantOps.notifications.markAllRead({})).resolves.toBeDefined();
    // finance holds no team.manage: the role table refuses, not the scope.
    expect(await refusal(() => as(finance.userId, onboard()).merchantOps.team.invite({ userId: id(), role: 'viewer' }))).toBe(
      'pay.team_role_forbidden',
    );
    const admin = await member(merchantId, 'admin');
    await expect(as(admin.userId, onboard()).merchantOps.team.invite({ userId: id(), role: 'viewer' })).resolves.toMatchObject({
      status: 'invited',
    });
    // The owner-only security rule stays owner-only.
    expect(
      await refusal(() => as(admin.userId, onboard()).merchantOps.security.setRequireMfa({ requireMfa: true, expectedRevision: 0 })),
    ).toBe('pay.team_role_forbidden');
  });

  it('refuses a member while the business is not verified, or is suspended or closed, and a member not yet active', async () => {
    for (const [kyb, status] of [
      ['pending', 'active'],
      ['none', 'pending'],
      ['approved', 'suspended'],
      ['approved', 'closed'],
    ] as const) {
      const { merchantId } = await business(kyb, status);
      const finance = await member(merchantId, 'finance');
      expect(await markAll(finance.userId), `${kyb} ${status}`).toBe('Scope "pay:write" is required');
    }
    const { merchantId } = await business('approved');
    const invited = await member(merchantId, 'finance', 'invited');
    expect(await markAll(invited.userId)).toBe('Scope "pay:write" is required');
    expect(await markAll(id())).toBe('Scope "pay:write" is required');
  });

  it('keeps the owner on pay:write: an owner of an unverified business cannot write on pay:onboard', async () => {
    const { owner } = await business('pending');
    expect(await markAll(owner)).toBe('Scope "pay:write" is required');
    const approved = await business('approved');
    await expect(as(approved.owner).merchantOps.notifications.markAllRead({})).resolves.toBeDefined();
  });

  it('never takes pay:onboard without a second factor, or from an API key', async () => {
    const { merchantId } = await business('approved');
    const finance = await member(merchantId, 'finance');
    await expect(as(finance.userId, onboard({ mfa: false })).merchantOps.notifications.markAllRead({})).rejects.toThrow();
    await expect(as(finance.userId, onboard({ kid: 'k1' })).merchantOps.notifications.markAllRead({})).rejects.toThrow();
  });

  it('lets a person with no business answer an invitation and leave, on pay:onboard', async () => {
    const { merchantId } = await business('pending');
    const invited = await member(merchantId, 'finance', 'invited');
    const accepted = await as(invited.userId, onboard()).merchantOps.team.acceptInvite({ memberId: invited.memberId });
    expect(accepted).toMatchObject({ status: 'active', role: 'finance' });
    await expect(as(invited.userId, onboard()).merchantOps.team.leave({})).resolves.toEqual({ left: true });
    const other = await member(merchantId, 'viewer', 'invited');
    await expect(as(other.userId, onboard()).merchantOps.team.declineInvite({ memberId: other.memberId })).resolves.toEqual({
      declined: true,
    });
    // Someone else's invitation stays someone else's.
    const third = await member(merchantId, 'viewer', 'invited');
    expect(await refusal(() => as(id(), onboard()).merchantOps.team.acceptInvite({ memberId: third.memberId }))).toBe(
      'pay.team_invitation_not_found',
    );
  });

  it('with the live recheck installed, a member of a suspended business cannot write, but can still leave and decline', async () => {
    const { merchantId } = await business('approved');
    const finance = await member(merchantId, 'finance');
    await expect(live(finance.userId).merchantOps.notifications.markAllRead({})).resolves.toBeDefined();
    await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${merchantId}`;
    expect(await refusal(() => live(finance.userId).merchantOps.notifications.markAllRead({}))).toBe('pay.owner_grant_withdrawn');
    await expect(live(finance.userId).merchantOps.team.leave({})).resolves.toEqual({ left: true });

    const shut = await business('approved', 'closed');
    const stuck = await member(shut.merchantId, 'viewer');
    const invited = await member(shut.merchantId, 'viewer', 'invited');
    await expect(live(invited.userId).merchantOps.team.declineInvite({ memberId: invited.memberId })).resolves.toEqual({
      declined: true,
    });
    await expect(live(stuck.userId).merchantOps.team.leave({})).resolves.toEqual({ left: true });
    // Leaving still needs the scope and its second factor.
    await expect(live(stuck.userId, { scopes: [] }).merchantOps.team.leave({})).rejects.toThrow();
    await expect(live(stuck.userId, { mfa: false }).merchantOps.team.leave({})).rejects.toThrow();
  });

  it('refuses with the typed unavailable answer when the service has no database', async () => {
    const offline = createMerchantOpsRouter({ founderAuthority } as unknown as MerchantOpsDeps).createCaller(
      ctxOf(principalOf(id(), onboard())),
    );
    await expect(offline.merchantOps.notifications.markAllRead({})).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});
