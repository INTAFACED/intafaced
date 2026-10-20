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
import { RETURN_BLOCKER } from './schemas.js';

/** `founderAdmin.withdrawalReturns.*` through the real namespaces, against a real Postgres. TEST figures only. */
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
    .withDatabase('intafaced_withdrawal_returns_router_test')
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

describe('founderAdmin.withdrawalReturns (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let founderOk = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any;
  const r = () => api.founderAdmin.withdrawalReturns;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    const ns = createPayNamespaces({
      founderAuthority: async () => {
        if (!founderOk) throw new MerchantControlError('operator.denied');
        return FOUNDER;
      },
      withdrawalReturns: { sql: db.sql },
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
    await db.sql`TRUNCATE pay.withdrawals RESTART IDENTITY CASCADE`;
  }, 30_000);

  async function sentWithdrawal(): Promise<string> {
    const [row] = await db.sql<Array<{ id: string }>>`
      INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, rail_ref, status)
      VALUES (${USER}, 'USDT', 40, 'card-sandbox', ${db.sql.json({ kind: 'bank', ref: 'DE89370400440532013000' })}, ${`r-${randomUUID()}`}, 'rail-1', 'sent')
      RETURNING id`;
    return row!.id;
  }
  const body = (withdrawalId: string) => ({
    withdrawalId,
    returnRef: `ret-${withdrawalId}`,
    amount: '40',
    reason: 'Bank returned the transfer',
  });

  it('starts empty and never invents a row', async () => {
    expect(await r().list({ limit: 10 })).toEqual([]);
    expect((await refused(r().get({ withdrawalId: randomUUID() }))).message).toContain('withdrawal_return.not_found');
  });

  it('records, reads and lists a return, parked with the blocker named', async () => {
    const id = await sentWithdrawal();
    const recorded = await r().record(body(id));
    expect(recorded).toMatchObject({ withdrawalId: id, state: 'parked', blocker: RETURN_BLOCKER, recordedBy: FOUNDER });
    expect(await r().get({ withdrawalId: id })).toEqual(recorded);
    expect((await r().list({ limit: 10 })).map((x: { withdrawalId: string }) => x.withdrawalId)).toEqual([id]);
  });

  it('refuses re-credit with the blocker named, and an extra field or a missing page size is a parse error', async () => {
    const id = await sentWithdrawal();
    await r().record(body(id));
    const out = await refused(r().recredit({ withdrawalId: id, reason: 'Customer asked' }));
    expect(out.code).toBe('PRECONDITION_FAILED');
    expect(out.message).toContain(RETURN_BLOCKER);
    expect((await refused(r().record({ ...body(id), extra: 1 }))).code).toBe('BAD_REQUEST');
    expect((await refused(r().list({}))).code).toBe('BAD_REQUEST');
    expect((await refused(r().record({ ...body(id), amount: 40 }))).code).toBe('BAD_REQUEST');
  });

  it('is founder-only: a caller who is not a founder is refused everywhere', async () => {
    founderOk = false;
    const id = await sentWithdrawal();
    expect((await refused(r().list({ limit: 10 }))).code).toBe('FORBIDDEN');
    expect((await refused(r().record(body(id)))).code).toBe('FORBIDDEN');
    expect((await refused(r().recredit({ withdrawalId: id, reason: 'x' }))).code).toBe('FORBIDDEN');
  });
});
