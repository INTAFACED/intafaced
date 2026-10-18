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
import { createMerchantOpsRouter, type MerchantOpsDeps } from './router.js';
import { claimEmailTeamInvites } from './team-email-claim.js';
import { MerchantOpsError } from './errors.js';

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
    .withDatabase('intafaced_team_email_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const id = () => randomUUID();
const LIMIT = { maxPerWindow: 2, windowMs: 60_000, ttlMs: 86_400_000 };
const identity = { identityUrl: 'https://identity.invalid', serviceSecret: 's'.repeat(32), principalSecret: 'p'.repeat(32) };

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

describe('merchant email team invites', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  const owner = id();
  let merchant = '';

  const founderFetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
  const founderAuthority = createFounderAuthority({ ...identity, fetcher: founderFetcher });
  const deps = (): MerchantOpsDeps => ({ sql, founderAuthority, teamEmailInvite: LIMIT });
  const as = (userId: string, over: Partial<Principal> = {}, routerDeps: MerchantOpsDeps = deps()) =>
    createMerchantOpsRouter(routerDeps).createCaller(ctxOf(principalOf(userId, over)));

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    merchant = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${owner}) RETURNING id`)[0]!.id;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  it('returns the same shape for any mailbox and does not store an account id', async () => {
    const first = await as(owner).merchantOps.team.invite({ email: '  Ada@Example.COM ', role: 'viewer', label: 'Ada' });
    const second = await as(owner).merchantOps.team.invite({ email: 'nobody-not-a-user@example.com', role: 'finance' });
    expect(Object.keys(first).sort()).toEqual(Object.keys(second).sort());
    expect(first).toMatchObject({ status: 'invited', role: 'viewer', userId: 'email:ada@example.com', label: 'Ada' });
    expect(second).toMatchObject({ status: 'invited', role: 'finance', userId: 'email:nobody-not-a-user@example.com' });
    expect(first.userId).not.toMatch(/^[0-9a-f]{8}-/);
    expect(second.userId).not.toMatch(/^[0-9a-f]{8}-/);
    const again = await as(owner).merchantOps.team.invite({ email: 'ada@example.com', role: 'developer' });
    expect(again).toMatchObject({ memberId: first.memberId, userId: 'email:ada@example.com', role: 'developer', status: 'invited' });
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.merchant_team_members WHERE merchant_id = ${merchant} AND user_id LIKE 'email:%'`;
    expect(rows[0]?.n).toBe(2);
  });

  it('refuses an unset window, a reserved account id, a bad mailbox, and both targets', async () => {
    const off = await refusal(() =>
      as(owner, {}, { sql, founderAuthority }).merchantOps.team.invite({ email: 'ada@example.com', role: 'viewer' }),
    );
    expect(off).toBe('pay.team_email_invite_unconfigured');
    expect(await refusal(() => as(owner).merchantOps.team.invite({ userId: 'email:ada@example.com', role: 'viewer' }))).toBe(
      'pay.team_user_id_reserved',
    );
    expect(await refusal(() => as(owner).merchantOps.team.invite({ email: 'not-an-email', role: 'viewer' }))).toBe(
      'pay.team_email_invalid',
    );
    expect(await refusal(() => as(owner).merchantOps.team.invite({ userId: id(), email: 'ada@example.com', role: 'viewer' }))).toBe(
      'pay.team_invite_target_invalid',
    );
    expect(await refusal(() => as(owner).merchantOps.team.invite({ role: 'viewer' }))).toBe('pay.team_invite_target_invalid');
  });

  it('keeps the role checks: a viewer cannot invite, an admin cannot grant admin, a key cannot', async () => {
    const viewer = id();
    const invited = await as(owner).merchantOps.team.invite({ userId: viewer, role: 'viewer' });
    await as(viewer).merchantOps.team.acceptInvite({ memberId: invited.memberId! });
    expect(await refusal(() => as(viewer).merchantOps.team.invite({ email: 'new@example.com', role: 'viewer' }))).toBe(
      'pay.team_role_forbidden',
    );
    const admin = id();
    const adminInvite = await as(owner).merchantOps.team.invite({ userId: admin, role: 'admin' });
    await as(admin).merchantOps.team.acceptInvite({ memberId: adminInvite.memberId! });
    expect(await refusal(() => as(admin).merchantOps.team.invite({ email: 'boss@example.com', role: 'admin' }))).toBe(
      'pay.team_role_forbidden',
    );
    expect(
      await refusal(() => as(owner, { kid: 'ifc_live_key' }).merchantOps.team.invite({ email: 'key@example.com', role: 'viewer' })),
    ).toBe('pay.team_interactive_only');
  });

  it('rate-limits new email invites per merchant and does not count an account-id invite', async () => {
    const tight = id();
    const merchantId = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${tight}) RETURNING id`)[0]!.id;
    const caller = as(tight);
    await caller.merchantOps.team.invite({ userId: id(), role: 'viewer' });
    await caller.merchantOps.team.invite({ email: 'one@example.com', role: 'viewer' });
    await caller.merchantOps.team.invite({ email: 'two@example.com', role: 'viewer' });
    expect(await refusal(() => caller.merchantOps.team.invite({ email: 'three@example.com', role: 'viewer' }))).toBe(
      'pay.team_email_invite_rate_limited',
    );
    const stored = await sql<Array<{ user_id: string }>>`
      SELECT user_id FROM pay.merchant_team_members WHERE merchant_id = ${merchantId} AND user_id LIKE 'email:%' ORDER BY user_id`;
    expect(stored.map((row) => row.user_id)).toEqual(['email:one@example.com', 'email:two@example.com']);
  });

  it('accepts a pending email invite when that mailbox signs in, and not when they already belong somewhere', async () => {
    const host = id();
    await sql`INSERT INTO pay.merchants (user_id) VALUES (${host})`;
    const invited = await as(host).merchantOps.team.invite({ email: 'join@example.com', role: 'developer' });
    expect(invited.userId).toBe('email:join@example.com');
    const person = id();
    const first = await claimEmailTeamInvites(sql, { userId: person, email: 'Join@Example.com' }, LIMIT.ttlMs);
    expect(first).toEqual({ claimed: 1, accepted: 1 });
    const row = await sql<Array<{ user_id: string; status: string; role: string }>>`
      SELECT user_id, status, role FROM pay.merchant_team_members WHERE id = ${invited.memberId}`;
    expect(row[0]).toMatchObject({ user_id: person, status: 'active', role: 'developer' });
    expect(await claimEmailTeamInvites(sql, { userId: person, email: 'join@example.com' }, LIMIT.ttlMs)).toEqual({
      claimed: 0,
      accepted: 0,
    });

    const other = id();
    await sql`INSERT INTO pay.merchants (user_id) VALUES (${other})`;
    await as(other).merchantOps.team.invite({ email: 'join@example.com', role: 'viewer' });
    const second = await claimEmailTeamInvites(sql, { userId: person, email: 'join@example.com' }, LIMIT.ttlMs);
    expect(second).toEqual({ claimed: 1, accepted: 0 });
    const pending = await sql<Array<{ user_id: string; status: string }>>`
      SELECT user_id, status FROM pay.merchant_team_members WHERE merchant_id = (SELECT id FROM pay.merchants WHERE user_id = ${other})`;
    expect(pending[0]).toMatchObject({ user_id: person, status: 'invited' });

    const own = await as(host).merchantOps.team.invite({ email: 'host@example.com', role: 'viewer' });
    const ownerClaim = await claimEmailTeamInvites(sql, { userId: host, email: 'host@example.com' }, LIMIT.ttlMs);
    expect(ownerClaim).toEqual({ claimed: 1, accepted: 0 });
    const ownerRow = await sql<Array<{ user_id: string; status: string }>>`
      SELECT user_id, status FROM pay.merchant_team_members WHERE id = ${own.memberId}`;
    expect(ownerRow[0]).toMatchObject({ user_id: host, status: 'invited' });
  });

  it('refuses a claim that is not a real account id and does not write', async () => {
    await expect(
      claimEmailTeamInvites(sql, { userId: 'email:ada@example.com', email: 'ada@example.com' }, LIMIT.ttlMs),
    ).rejects.toBeInstanceOf(MerchantOpsError);
  });

  it('does not bind when the lifetime is unset or the invite is older than it', async () => {
    const host = id();
    await sql`INSERT INTO pay.merchants (user_id) VALUES (${host})`;
    const fresh = await as(host).merchantOps.team.invite({ email: 'later@example.com', role: 'viewer' });
    const person = id();
    expect(await claimEmailTeamInvites(sql, { userId: person, email: 'later@example.com' }, undefined)).toEqual({
      claimed: 0,
      accepted: 0,
    });
    const still = await sql<Array<{ user_id: string; status: string }>>`
      SELECT user_id, status FROM pay.merchant_team_members WHERE id = ${fresh.memberId}`;
    expect(still[0]).toMatchObject({ user_id: 'email:later@example.com', status: 'invited' });

    await sql`UPDATE pay.merchant_team_members SET updated_at = now() - interval '2 hours' WHERE id = ${fresh.memberId}`;
    expect(await claimEmailTeamInvites(sql, { userId: person, email: 'later@example.com' }, 60_000)).toEqual({
      claimed: 0,
      accepted: 0,
    });
    const aged = await sql<Array<{ user_id: string; status: string }>>`
      SELECT user_id, status FROM pay.merchant_team_members WHERE id = ${fresh.memberId}`;
    expect(aged[0]).toMatchObject({ user_id: 'email:later@example.com', status: 'invited' });

    await as(host).merchantOps.team.invite({ email: 'later@example.com', role: 'developer' });
    const renewed = await claimEmailTeamInvites(sql, { userId: person, email: 'later@example.com' }, 60_000);
    expect(renewed).toEqual({ claimed: 1, accepted: 1 });
  });
});
