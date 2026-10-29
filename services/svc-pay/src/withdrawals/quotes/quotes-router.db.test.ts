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
import { WithdrawalQuoteService } from './service.js';

/** `founderAdmin.withdrawalQuotes.*` through the real namespaces, against a real Postgres. TEST figures only. */
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
    .withDatabase('intafaced_withdrawal_quotes_router_test')
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

describe('founderAdmin.withdrawalQuotes (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let founderOk = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any;
  const q = () => api.founderAdmin.withdrawalQuotes;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    const ns = createPayNamespaces({
      founderAuthority: async () => {
        if (!founderOk) throw new MerchantControlError('operator.denied');
        return FOUNDER;
      },
      withdrawalQuotes: { sql: db.sql },
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
    await db.sql`TRUNCATE pay.withdrawal_quotes, pay.withdrawal_quote_acceptances, pay.withdrawal_quote_policy_events RESTART IDENTITY CASCADE`;
  }, 30_000);

  it('starts with no policy and no quotes, and never invents either', async () => {
    expect(await q().policy({})).toEqual({ feeMode: null, ttlSeconds: null, setBy: null, setAt: null });
    expect(await q().list({ limit: 10 })).toEqual([]);
  });

  it('sets the policy and reads the quotes customers asked for', async () => {
    expect(await q().setPolicy({ feeMode: 'deducted', ttlSeconds: 90 })).toMatchObject({
      feeMode: 'deducted',
      ttlSeconds: 90,
      setBy: FOUNDER,
    });
    await db.sql`INSERT INTO pay.network_registry (network_id, display_name, asset_codes, enabled, fee_estimate_source, fee_estimate_amount, updated_by)
      VALUES ('tron-test', 'tron-test', ${db.sql.json(['USDT'])}, true, 'fixed', '1', ${FOUNDER})
      ON CONFLICT (network_id) DO NOTHING`;
    await db.sql`INSERT INTO pay.withdrawal_network_rules (asset_id, network_id, minimum, maximum, step, tag, set_by)
      VALUES ('USDT', 'tron-test', '1', '100', '1', 'none', ${FOUNDER}) ON CONFLICT DO NOTHING`;
    await new WithdrawalQuoteService({ sql: db.sql }).quote(USER, {
      quoteRef: 'q-1',
      assetId: 'USDT',
      networkId: 'tron-test',
      amount: '10',
    });
    expect(await q().list({ limit: 10, userId: USER })).toMatchObject([{ quoteRef: 'q-1', userId: USER, netAmount: '9' }]);
  });

  it('parses strictly: extra fields, a bad mode, a zero or fractional lifetime, a missing limit', async () => {
    expect((await refused(q().setPolicy({ feeMode: 'deducted', ttlSeconds: 60, extra: 1 }))).code).toBe('BAD_REQUEST');
    expect((await refused(q().setPolicy({ feeMode: 'free', ttlSeconds: 60 }))).code).toBe('BAD_REQUEST');
    expect((await refused(q().setPolicy({ feeMode: 'on_top', ttlSeconds: 0 }))).code).toBe('BAD_REQUEST');
    expect((await refused(q().setPolicy({ feeMode: 'on_top', ttlSeconds: 1.5 }))).code).toBe('BAD_REQUEST');
    expect((await refused(q().list({}))).code).toBe('BAD_REQUEST');
  });

  it('is founder-only: a caller who is not a founder is refused everywhere', async () => {
    founderOk = false;
    expect((await refused(q().policy({}))).code).toBe('FORBIDDEN');
    expect((await refused(q().setPolicy({ feeMode: 'on_top', ttlSeconds: 60 }))).code).toBe('FORBIDDEN');
    expect((await refused(q().list({ limit: 10 }))).code).toBe('FORBIDDEN');
  });
});
