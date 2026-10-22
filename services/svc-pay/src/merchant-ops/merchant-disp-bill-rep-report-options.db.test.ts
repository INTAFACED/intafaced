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
import { reportOptions } from './merchant-disp-bill-rep-report-options.js';

/** M-rep-01 exports.options and zoned periods through the router, against a real Postgres. */

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
    .withDatabase('intafaced_report_options_test')
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

describe('M-rep-01 merchantOps.exports options and period (Postgres)', () => {
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
    createMerchantOpsRouter({ sql, founderAuthority, exportKick: () => undefined }).createCaller(ctxOf(principalOf(userId, over)));

  it('options answer per the caller role', async () => {
    const o = await as(viewer, { scopes: ['pay:read'] }).merchantOps.exports.options({});
    expect(o).toEqual(reportOptions({ merchantId: '', userId: viewer, role: 'viewer', viaApiKey: false, interactive: true }));
  });

  it('a zoned period is stored as UTC boundaries computed on the server; the same request id returns the first job', async () => {
    const requestId = id();
    const input = {
      requestId,
      kind: 'payments' as const,
      period: { fromDay: '2026-10-02', toDay: '2026-10-02', timeZone: 'Asia/Makassar' },
    };
    const job = await as(owner).merchantOps.exports.create(input);
    expect(job.filters).toMatchObject({ from: '2026-10-01T16:00:00.000Z', to: '2026-10-02T16:00:00.000Z' });
    const again = await as(owner).merchantOps.exports.create(input);
    expect(again.jobId).toBe(job.jobId);
  });

  it('an unknown zone and a future period are refused before any job exists', async () => {
    expect(
      await refusal(() =>
        as(owner).merchantOps.exports.create({
          requestId: id(),
          kind: 'payments',
          period: { fromDay: '2026-10-01', toDay: '2026-10-01', timeZone: 'Nowhere/Land' },
        }),
      ),
    ).toEqual({ code: 'BAD_REQUEST', message: 'pay.export_time_zone_unknown' });
    expect(
      await refusal(() =>
        as(owner).merchantOps.exports.create({
          requestId: id(),
          kind: 'payments',
          period: { fromDay: '2999-01-01', toDay: '2999-01-01', timeZone: 'UTC' },
        }),
      ),
    ).toEqual({ code: 'BAD_REQUEST', message: 'pay.export_period_future' });
  });

  it('a non-member is refused', async () => {
    expect(await refusal(() => as(stranger).merchantOps.exports.options({}))).toEqual({
      code: 'FORBIDDEN',
      message: 'pay.merchant_ops_not_merchant',
    });
  });
});
