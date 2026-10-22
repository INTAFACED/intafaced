import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createFounderAuthority } from '../founder-authority.js';
import { createMerchantOpsRouter } from './router.js';
import { merchantRiskPolicy } from './merchant-disp-bill-rep-risk-policy.js';

/** M-disp-05 merchantOps.risk.policy through the router, against a real Postgres. */

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
    .withDatabase('intafaced_risk_policy_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const id = () => randomUUID();
const founderAuthority = createFounderAuthority({
  identityUrl: 'https://identity.invalid',
  serviceSecret: 's'.repeat(32),
  fetcher: async () => new Response('{}', { status: 500 }),
});
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
const ctxOf = (principal: Principal): Context => ({
  principal,
  service: null,
  region: 'DE',
  requestId: id(),
  forwardedPrincipal: { raw: 'test-principal', signature: 'test-signature', region: 'DE' },
});

async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    const err = e as { code: string; message: string };
    return { code: err.code, message: err.message };
  }
  throw new Error('expected a refusal');
}

describe('M-disp-05 merchantOps.risk.policy (Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  const owner = id();
  const viewer = id();
  const stranger = id();

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    const merchantId = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${owner}) RETURNING id`)[0]!.id;
    await sql`INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by)
              VALUES (${merchantId}, ${viewer}, 'viewer', 'active', ${owner})`;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  const as = (userId: string, over: Partial<Principal> = {}) =>
    createMerchantOpsRouter({ sql, founderAuthority }).createCaller(ctxOf(principalOf(userId, over)));

  it('owner and a read-only viewer read the same policy, equal to the pure view', async () => {
    const fromOwner = await as(owner).merchantOps.risk.policy({});
    const fromViewer = await as(viewer, { scopes: ['pay:read'] }).merchantOps.risk.policy({});
    expect(fromOwner).toEqual(merchantRiskPolicy());
    expect(fromViewer).toEqual(fromOwner);
  });

  it('a principal who is not a member of any merchant is refused', async () => {
    expect(await refusal(() => as(stranger).merchantOps.risk.policy({}))).toEqual({
      code: 'FORBIDDEN',
      message: 'pay.merchant_ops_not_merchant',
    });
  });
});
