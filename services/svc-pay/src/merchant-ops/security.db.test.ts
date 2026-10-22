import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Context } from '@intafaced/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createFounderAuthority } from '../founder-authority.js';
import { createMerchantOpsRouter } from './router.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const id = () => randomUUID();

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('pay_merchant_security')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const principalOf = (userId: string, over: Partial<Principal> = {}): Principal =>
  ({
    userId,
    sub: userId,
    sid: id(),
    scopes: ['pay:read', 'pay:write'],
    mfa: true,
    tier: 'full',
    expiresAt: new Date(Date.now() + 600_000),
    ...over,
  }) as Principal;

describe('merchantOps.security: team-wide require-MFA (M-plat-org-06, Postgres)', () => {
  let stop = async () => undefined as void;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  const owner = id();
  const admin = id();
  const viewer = id();
  const otherOwner = id();
  let merchant = '';

  const founderAuthority = createFounderAuthority({
    identityUrl: 'https://identity.invalid',
    serviceSecret: 's'.repeat(32),
    fetcher: (async () => new Response('{}', { status: 403 })) as typeof fetch,
  });
  const as = (userId: string, over: Partial<Principal> = {}) =>
    createMerchantOpsRouter({ sql, founderAuthority, exportKick: () => undefined }).createCaller({
      principal: principalOf(userId, over),
      service: null,
      region: 'DE',
      requestId: id(),
    } satisfies Context);

  async function refusal(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      const err = e as { code: string; message: string };
      return { code: err.code, message: err.message };
    }
    throw new Error('expected a refusal');
  }

  beforeAll(async () => {
    const a = await openAdmin();
    stop = a.stop;
    db = await createTestDatabase({ service: 'pay', url: a.url, migrations });
    sql = db.sql;
    merchant = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${owner}) RETURNING id`)[0]!.id;
    await sql`INSERT INTO pay.merchants (user_id) VALUES (${otherOwner})`;
    for (const [user, role] of [
      [admin, 'admin'],
      [viewer, 'viewer'],
    ] as const) {
      await sql`
        INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
        VALUES (${merchant}, ${user}, ${role}, 'active', ${owner}, now())`;
    }
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await stop();
  });

  it('starts off; owner may change it, a member reads it read-only', async () => {
    expect(await as(owner).merchantOps.security.get({})).toEqual({ requireMfa: false, canChange: true, changedAt: null });
    expect(await as(viewer).merchantOps.security.get({})).toMatchObject({ requireMfa: false, canChange: false });
  });

  it('refuses a member, and an owner session without MFA, from changing it', async () => {
    expect(await refusal(() => as(admin).merchantOps.security.setRequireMfa({ requireMfa: true }))).toEqual({
      code: 'FORBIDDEN',
      message: 'pay.team_role_forbidden',
    });
    expect(await refusal(() => as(owner, { mfa: false }).merchantOps.security.setRequireMfa({ requireMfa: true }))).toEqual({
      code: 'FORBIDDEN',
      message: 'pay.team_interactive_only',
    });
    expect(await refusal(() => as(owner, { kid: 'key-1' }).merchantOps.security.setRequireMfa({ requireMfa: true }))).toEqual({
      code: 'FORBIDDEN',
      message: 'pay.team_interactive_only',
    });
    expect((await as(owner).merchantOps.security.get({})).requireMfa).toBe(false);
  });

  it('while on, a member without a second step is refused on every call; with MFA they pass', async () => {
    const before = await as(viewer, { mfa: false }).merchantOps.team.me({});
    expect(before.role).toBe('viewer');

    const on = await as(owner).merchantOps.security.setRequireMfa({ requireMfa: true });
    expect(on).toMatchObject({ requireMfa: true, canChange: true });
    expect(on.changedAt).not.toBeNull();
    const row = (
      await sql<Array<{ require_mfa_changed_by: string }>>`SELECT require_mfa_changed_by FROM pay.merchants WHERE id = ${merchant}`
    )[0]!;
    expect(row.require_mfa_changed_by).toBe(owner);

    expect(await refusal(() => as(viewer, { mfa: false }).merchantOps.team.me({}))).toEqual({
      code: 'FORBIDDEN',
      message: 'pay.merchant_mfa_required',
    });
    expect(await refusal(() => as(viewer, { mfa: false }).merchantOps.security.get({}))).toEqual({
      code: 'FORBIDDEN',
      message: 'pay.merchant_mfa_required',
    });
    expect((await as(viewer).merchantOps.team.me({})).role).toBe('viewer');
    // API keys keep their own step-up; the rule reads interactive sessions only.
    expect((await as(viewer, { mfa: false, kid: 'key-2' }).merchantOps.team.me({})).role).toBe('viewer');
    // Another merchant's owner is untouched.
    expect((await as(otherOwner, { mfa: false }).merchantOps.team.me({})).role).toBe('owner');
  });

  it('setting the current value again keeps the first change time; turning it off lets members back in', async () => {
    const first = (await as(owner).merchantOps.security.get({})).changedAt;
    expect((await as(owner).merchantOps.security.setRequireMfa({ requireMfa: true })).changedAt).toBe(first);
    const off = await as(owner).merchantOps.security.setRequireMfa({ requireMfa: false });
    expect(off.requireMfa).toBe(false);
    expect((await as(viewer, { mfa: false }).merchantOps.team.me({})).role).toBe('viewer');
  });
});
