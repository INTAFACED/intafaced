import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MerchantControlError } from '../../merchant-account-controls.js';
import { createPayNamespaces } from '../../namespaces/index.js';

/** `founderAdmin.purchaseHolds.*` through the real namespaces, against a real Postgres. TEST figures only. */
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_purchase_holds_router_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const USER = '11111111-1111-4111-8111-111111111111';
const FOUNDER = 'founder-a';
type Err = { code: string; message?: string };
async function refused(p: Promise<unknown>): Promise<Err> {
  try {
    await p;
  } catch (e) {
    return e as Err;
  }
  throw new Error('expected the call to be refused');
}

describe('founderAdmin.purchaseHolds (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let founderOk = true;
  let nowMs = Date.parse('2026-10-20T10:00:00.000Z');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any;
  const h = () => api.founderAdmin.purchaseHolds;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    const ns = createPayNamespaces({
      founderAuthority: async () => {
        if (!founderOk) throw new MerchantControlError('operator.denied');
        return FOUNDER;
      },
      purchaseHolds: { sql: db.sql, now: () => new Date(nowMs) },
    });
    const userId = randomUUID();
    const principal: Principal = {
      userId,
      sub: userId,
      sid: randomUUID(),
      scopes: [...SESSION_SCOPES],
      mfa: true,
      tier: 'full',
      expiresAt: new Date(Date.now() + 3_600_000),
    };
    api = ns.createCaller({ principal, service: null, region: 'DE', requestId: 'r' });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    founderOk = true;
    nowMs = Date.parse('2026-10-20T10:00:00.000Z');
    await db.sql`TRUNCATE pay.purchase_holds, pay.purchase_hold_releases, pay.purchase_hold_policy_events RESTART IDENTITY CASCADE`;
  }, 30_000);

  const body = (holdRef: string) => ({
    holdRef,
    userId: USER,
    assetId: 'USDT',
    amount: '60',
    rail: 'card',
    purchasedAt: '2026-10-20T10:00:00.000Z',
  });

  it('starts with no period and no holds, and never invents either', async () => {
    expect(await h().policy({})).toEqual({ holdSeconds: null, setBy: null, setAt: null });
    expect(await h().list({ limit: 10 })).toEqual([]);
  });

  it('records, lists, sets the period and releases through the door', async () => {
    const rec = await h().record(body('card:pay-1'));
    expect(rec).toMatchObject({ state: 'held', recordedBy: FOUNDER, releaseAt: null });

    const policy = await h().setPolicy({ holdSeconds: 3600 });
    expect(policy).toMatchObject({ holdSeconds: 3600, setBy: FOUNDER });
    expect((await h().list({ limit: 10 }))[0]).toMatchObject({ releaseAt: '2026-10-20T11:00:00.000Z' });

    expect(await h().releaseDue({})).toEqual({ released: [] });
    nowMs += 3_600_000;
    expect(await h().releaseDue({})).toEqual({ released: [rec.id] });
    expect(await h().releaseDue({})).toEqual({ released: [] });
    expect((await h().list({ limit: 10, state: 'released' }))[0]).toMatchObject({ state: 'released', id: rec.id });
  });

  it('parses strictly: extra fields, number amounts, a bad rail, a zero or fractional period', async () => {
    expect((await refused(h().record({ ...body('card:a'), extra: 1 }))).code).toBe('BAD_REQUEST');
    expect((await refused(h().record({ ...body('card:a'), amount: 60 }))).code).toBe('BAD_REQUEST');
    expect((await refused(h().record({ ...body('card:a'), rail: 'wire' }))).code).toBe('BAD_REQUEST');
    expect((await refused(h().setPolicy({ holdSeconds: 0 }))).code).toBe('BAD_REQUEST');
    expect((await refused(h().setPolicy({ holdSeconds: 1.5 }))).code).toBe('BAD_REQUEST');
    expect((await refused(h().list({}))).code).toBe('BAD_REQUEST');
  });

  it('a different purchase under a recorded reference is a conflict', async () => {
    await h().record(body('card:pay-1'));
    expect((await refused(h().record({ ...body('card:pay-1'), amount: '61' }))).code).toBe('CONFLICT');
  });

  it('is founder-only: a caller who is not a founder is refused everywhere', async () => {
    founderOk = false;
    expect((await refused(h().list({ limit: 10 }))).code).toBe('FORBIDDEN');
    expect((await refused(h().record(body('card:pay-1')))).code).toBe('FORBIDDEN');
    expect((await refused(h().setPolicy({ holdSeconds: 60 }))).code).toBe('FORBIDDEN');
    expect((await refused(h().releaseDue({}))).code).toBe('FORBIDDEN');
    expect((await refused(h().policy({}))).code).toBe('FORBIDDEN');
  });
});
