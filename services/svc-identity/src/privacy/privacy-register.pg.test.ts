/**
 * Privacy register (RC-identity-11): customer read, four-eyes publish, blank retention refusal, versions.
 * to `intafaced_test` when TEST_DATABASE_URL names a database that does not end in `_test`.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { privacyPublishPayloadHash, type PrivacySection } from './privacy-register.js';
import { createPrivacyRegisterRouter } from './privacy-router.js';

const ADA = '11111111-1111-4111-8111-111111111111';
const SID = '44444444-4444-4444-8444-444444444444';

const tokenConfig = {
  secret: 'paysend-identity-signing-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset');
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const OPS_A = '66666666-6666-4666-8666-666666666666';
const OPS_B = '77777777-7777-4777-8777-777777777777';

describe('privacy register (Postgres)', () => {
  let db: TestDatabase;
  let router: ReturnType<typeof createPrivacyRegisterRouter>;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'identity', url: adminUrl(), migrations });
    router = createPrivacyRegisterRouter(db.sql);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE identity.privacy_register, action_approvals CASCADE`;
  });

  async function caller(userId: string, scopes: Array<'identity:read' | 'admin:write'>) {
    const { token } = await issueAccessToken({ userId, sessionId: SID, scopes, tier: 'none', mfa: true }, tokenConfig);
    const ctx: Context = {
      principal: await verifyAccessToken(token, tokenConfig),
      service: null,
      region: 'DE',
      requestId: `req-${randomUUID()}`,
    };
    return router.createCaller(ctx);
  }

  async function approval(
    p: { section: PrivacySection; version: number; bodyRef: string; retentionPeriod?: string | null },
    approverId: string = OPS_B,
    status = 'APPROVED',
  ): Promise<string> {
    const approvalId = `apr-${randomUUID()}`;
    const pending = status === 'PENDING';
    const hash = privacyPublishPayloadHash({
      section: p.section,
      version: p.version,
      bodyRef: p.bodyRef,
      retentionPeriod: p.retentionPeriod ?? null,
    });
    await db.sql`
      INSERT INTO action_approvals (
        approval_id, action_type, target_service, target_id, expected_version, payload_hash,
        requester_id, approver_id, policy_version, operation_id, status, created_at, expires_at, approved_at
      ) VALUES (
        ${approvalId}, 'identity.privacy_publish', 'svc-identity', ${p.section}, ${String(p.version)}, ${hash},
        ${OPS_A}, ${pending ? null : approverId}, '1', ${randomUUID()}, ${status}, now(), now() + interval '1 hour',
        ${pending ? null : new Date()}
      )`;
    return approvalId;
  }

  async function publish(p: { section: PrivacySection; version: number; bodyRef: string; retentionPeriod?: string | null }) {
    const ops = await caller(OPS_A, ['admin:write']);
    return ops.privacy.register.publish({ ...p, approvalId: await approval(p) });
  }

  async function rows(): Promise<number> {
    const [{ n } = { n: -1 }] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM identity.privacy_register`;
    return n;
  }

  it('shows the one published section and not_set for the other seven', async () => {
    await publish({ section: 'collection', version: 1, bodyRef: 'docs/privacy/collection-v1.md' });
    const customer = await caller(ADA, ['identity:read']);
    const register = await customer.privacy.register.get();
    expect(register).toHaveLength(8);
    expect(register[0]).toMatchObject({ section: 'collection', state: 'published', version: 1, bodyRef: 'docs/privacy/collection-v1.md' });
    expect(register.slice(1)).toEqual(
      ['residency', 'access', 'minimisation', 'retention', 'export', 'deletion', 'breach_response'].map((section) => ({
        section,
        state: 'not_set',
      })),
    );
  });

  it('refuses publish without a second approver (pending, wrong payload, or missing; self-approval is refused by action_approvals_distinct_ck) and writes nothing', async () => {
    const ops = await caller(OPS_A, ['admin:write']);
    const p = { section: 'export' as const, version: 1, bodyRef: 'docs/privacy/export-v1.md' };
    for (const approvalId of [await approval(p, OPS_B, 'PENDING'), await approval({ ...p, bodyRef: 'other' }), 'apr-missing']) {
      await expect(ops.privacy.register.publish({ ...p, approvalId })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'identity.privacy_approval_required',
      });
    }
    expect(await rows()).toBe(0);
  });

  it('refuses a blank retention period with identity.privacy_retention_unset, and a blank body, writing nothing', async () => {
    const ops = await caller(OPS_A, ['admin:write']);
    for (const retentionPeriod of [undefined, null, '   ']) {
      await expect(
        ops.privacy.register.publish({ section: 'retention', version: 1, bodyRef: 'r-v1', retentionPeriod, approvalId: 'apr-x' }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'identity.privacy_retention_unset' });
    }
    await expect(
      ops.privacy.register.publish({ section: 'deletion', version: 1, bodyRef: '  ', approvalId: 'apr-x' }),
    ).rejects.toMatchObject({
      message: 'identity.privacy_body_unset',
    });
    expect(await rows()).toBe(0);
  });

  it('a new version supersedes the old one, which stays readable', async () => {
    for (const version of [1, 2]) {
      await publish({ section: 'retention', version, bodyRef: `r-v${version}`, retentionPeriod: `owner value ${version}` });
    }
    const customer = await caller(ADA, ['identity:read']);
    expect((await customer.privacy.register.get()).find((e) => e.section === 'retention')).toMatchObject({ version: 2, bodyRef: 'r-v2' });
    expect(await customer.privacy.register.get({ section: 'retention', version: 1 })).toEqual([
      expect.objectContaining({ version: 1, bodyRef: 'r-v1', retentionPeriod: 'owner value 1' }),
    ]);
  });

  it('a repeat with the same approval adopts; a consumed approval, a changed body or a skipped version conflicts', async () => {
    const ops = await caller(OPS_A, ['admin:write']);
    const p = { section: 'residency' as const, version: 1, bodyRef: 'res-v1' };
    const approvalId = await approval(p);
    const first = await ops.privacy.register.publish({ ...p, approvalId });
    expect(await ops.privacy.register.publish({ ...p, approvalId })).toEqual(first);
    await expect(ops.privacy.register.publish({ ...p, bodyRef: 'other', approvalId })).rejects.toMatchObject({ code: 'CONFLICT' });
    const skip = { section: 'residency' as const, version: 3, bodyRef: 'res-v3' };
    await expect(ops.privacy.register.publish({ ...skip, approvalId: await approval(skip) })).rejects.toMatchObject({ code: 'CONFLICT' });
    const v2 = { section: 'residency' as const, version: 2, bodyRef: 'res-v2' };
    await expect(ops.privacy.register.publish({ ...v2, approvalId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [consumed] = await db.sql<{ status: string }[]>`SELECT status FROM action_approvals WHERE approval_id = ${approvalId}`;
    expect(consumed?.status).toBe('CONSUMED');
    expect(await rows()).toBe(1);
  });

  it('refuses a customer token on publish and a version read without a section', async () => {
    const customer = await caller(ADA, ['identity:read']);
    await expect(
      customer.privacy.register.publish({ section: 'deletion', version: 1, bodyRef: 'x', approvalId: 'apr-x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(customer.privacy.register.get({ version: 1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
