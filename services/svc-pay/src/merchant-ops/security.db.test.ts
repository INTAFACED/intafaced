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
import { MerchantSecurity, mfaRuleForUser } from './security.js';
import { MerchantOpsError } from './errors.js';

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

describe('merchantOps.security: the owner require-MFA rule (M-plat-org-06, Postgres)', () => {
  let stop = async () => undefined as void;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  const owner = id();
  const admin = id();
  const viewer = id();
  const invited = id();
  const otherOwner = id();
  const nobody = id();
  let merchant = '';
  let otherMerchant = '';

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
    otherMerchant = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${otherOwner}) RETURNING id`)[0]!.id;
    for (const [user, role] of [
      [admin, 'admin'],
      [viewer, 'viewer'],
    ] as const) {
      await sql`
        INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
        VALUES (${merchant}, ${user}, ${role}, 'active', ${owner}, now())`;
    }
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by)
      VALUES (${merchant}, ${invited}, 'viewer', 'invited', ${owner})`;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await stop();
  });

  it('has no default: a new merchant has no rule, reads refuse typed, the internal read says unset', async () => {
    const row = (
      await sql<Array<{ require_mfa: boolean | null; require_mfa_revision: number }>>`
      SELECT require_mfa, require_mfa_revision FROM pay.merchants WHERE id = ${merchant}`
    )[0]!;
    expect(row).toEqual({ require_mfa: null, require_mfa_revision: 0 });
    for (const user of [owner, viewer]) {
      expect(await refusal(() => as(user).merchantOps.security.get({}))).toEqual({
        code: 'PRECONDITION_FAILED',
        message: 'pay.merchant_mfa_rule_unset',
      });
    }
    expect(await mfaRuleForUser(sql, owner)).toBe('unset');
    expect(await mfaRuleForUser(sql, viewer)).toBe('unset');
  });

  it('refuses a member, an owner session without MFA, and an owner API key from setting it; nothing changes', async () => {
    expect(await refusal(() => as(admin).merchantOps.security.setRequireMfa({ requireMfa: true, expectedRevision: 0 }))).toEqual({
      code: 'FORBIDDEN',
      message: 'pay.team_role_forbidden',
    });
    expect(
      await refusal(() => as(owner, { mfa: false }).merchantOps.security.setRequireMfa({ requireMfa: true, expectedRevision: 0 })),
    ).toEqual({ code: 'FORBIDDEN', message: 'pay.team_interactive_only' });
    expect(
      await refusal(() => as(owner, { kid: 'key-1' }).merchantOps.security.setRequireMfa({ requireMfa: true, expectedRevision: 0 })),
    ).toEqual({ code: 'FORBIDDEN', message: 'pay.team_interactive_only' });
    const row = (
      await sql<Array<{ require_mfa: boolean | null; require_mfa_revision: number }>>`
      SELECT require_mfa, require_mfa_revision FROM pay.merchants WHERE id = ${merchant}`
    )[0]!;
    expect(row).toEqual({ require_mfa: null, require_mfa_revision: 0 });
  });

  it('owner sets it at the current revision; a stale revision is refused and changes nothing', async () => {
    const on = await as(owner).merchantOps.security.setRequireMfa({ requireMfa: true, expectedRevision: 0 });
    expect(on).toMatchObject({ requireMfa: true, revision: 1, canChange: true });
    const by = (
      await sql<Array<{ require_mfa_changed_by: string }>>`SELECT require_mfa_changed_by FROM pay.merchants WHERE id = ${merchant}`
    )[0]!;
    expect(by.require_mfa_changed_by).toBe(owner);
    expect(await refusal(() => as(owner).merchantOps.security.setRequireMfa({ requireMfa: false, expectedRevision: 0 }))).toEqual({
      code: 'CONFLICT',
      message: 'pay.merchant_mfa_rule_stale',
    });
    expect(await as(viewer).merchantOps.security.get({})).toEqual({ ...on, canChange: false });
  });

  it('the internal read: required for owner and active members, not for an invited seat, another merchant, or nobody', async () => {
    expect(await mfaRuleForUser(sql, owner)).toBe('required');
    expect(await mfaRuleForUser(sql, admin)).toBe('required');
    expect(await mfaRuleForUser(sql, viewer)).toBe('required');
    expect(await mfaRuleForUser(sql, invited)).toBe('none');
    expect(await mfaRuleForUser(sql, otherOwner)).toBe('unset');
    expect(await mfaRuleForUser(sql, nobody)).toBe('none');
    await as(otherOwner).merchantOps.security.setRequireMfa({ requireMfa: false, expectedRevision: 0 });
    expect(await mfaRuleForUser(sql, otherOwner)).toBe('not_required');
    // An active member of a merchant that chose not to require it.
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
      VALUES (${otherMerchant}, ${nobody}, 'viewer', 'active', ${otherOwner}, now())`;
    expect(await mfaRuleForUser(sql, nobody)).toBe('not_required');
  });

  it('turning it off bumps the revision and the internal read follows', async () => {
    const cur = await as(owner).merchantOps.security.get({});
    const off = await as(owner).merchantOps.security.setRequireMfa({ requireMfa: false, expectedRevision: cur.revision });
    expect(off).toMatchObject({ requireMfa: false, revision: cur.revision + 1 });
    expect(await mfaRuleForUser(sql, viewer)).toBe('not_required');
  });

  it('a caller whose merchant row is gone is refused unset, never another merchant', async () => {
    const ghost = new MerchantSecurity(sql);
    const caller = { merchantId: id(), userId: owner, role: 'owner' as const, viaApiKey: false, interactive: true };
    await expect(ghost.get(caller)).rejects.toEqual(new MerchantOpsError('pay.merchant_mfa_rule_unset', 'precondition'));
    await expect(ghost.setRequireMfa(caller, { requireMfa: true, expectedRevision: 0 })).rejects.toEqual(
      new MerchantOpsError('pay.merchant_mfa_rule_stale', 'conflict'),
    );
  });
});
