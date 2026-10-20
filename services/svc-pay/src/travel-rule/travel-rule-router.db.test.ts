import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MerchantControlError } from '../merchant-account-controls.js';
import { createPayNamespaces } from '../namespaces/index.js';
import { createMessageCipher } from './cipher.js';

/** `founderAdmin.travelRule.*` through the real namespaces, against a real Postgres. TEST figures only. */
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
    .withDatabase('intafaced_travel_rule_router_test')
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

describe('founderAdmin.travelRule (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let founderOk = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any;
  const t = () => api.founderAdmin.travelRule;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    const ns = createPayNamespaces({
      founderAuthority: async () => {
        if (!founderOk) throw new MerchantControlError('operator.denied');
        return FOUNDER;
      },
      travelRule: { sql: db.sql, cipher: createMessageCipher('k1', randomBytes(32)) },
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
    await db.sql`TRUNCATE pay.travel_rule_messages, pay.travel_rule_transitions, pay.travel_rule_transfers, pay.travel_rule_wait_limit_events, pay.travel_rule_rule_events, pay.withdrawals RESTART IDENTITY CASCADE`;
  }, 30_000);

  const rule = {
    region: 'DE',
    entity: 'individual',
    assetId: 'USDT',
    applies: true,
    threshold: '1000',
    fields: ['originator_name', 'beneficiary_name'],
    reason: 'TEST rule',
  };

  it('starts with no rules and no limits, and never invents either', async () => {
    expect(await t().rules.list({})).toEqual([]);
    expect(await t().waitLimits.get({})).toEqual({ pendingSeconds: null, repairSeconds: null, setBy: null, setAt: null });
    expect((await refused(t().rules.assess({ region: 'DE', entity: 'individual', assetId: 'USDT', amount: '5' }))).message).toContain(
      'wallet.travel_rule_undecided',
    );
  });

  it('runs a transfer from rule to repair to an operator refusal through the door', async () => {
    await t().rules.set(rule);
    await t().waitLimits.set({ pendingSeconds: 600, repairSeconds: 300 });
    const [w] = await db.sql<Array<{ id: string }>>`
      INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref)
      VALUES (${USER}, 'USDT', 5000, 'chain', ${db.sql.json({ kind: 'address', ref: 'TXaddr1' })}, 'w-1') RETURNING id`;
    const opened = await t().transfer.open({
      withdrawalId: w!.id,
      userId: USER,
      networkId: 'tron-test',
      region: 'DE',
      entity: 'individual',
    });
    expect(opened).toMatchObject({ status: 'started', amount: '5000' });
    const msg = await t().message.create({ transferId: opened.id, originator: { name: 'Ada' }, beneficiary: {}, transfer: {} });
    expect(msg).toMatchObject({ status: 'repair', missing: ['beneficiary_name'] });
    expect((await refused(t().transfer.mark({ transferId: opened.id, to: 'accepted', reason: 'TEST' }))).code).toBe('FORBIDDEN');
    expect((await refused(t().transfer.submit({ transferId: opened.id }))).message).toContain('travel_rule.fields_missing');
    expect(await t().transfer.mark({ transferId: opened.id, to: 'canceled', reason: 'customer withdrew' })).toMatchObject({
      status: 'canceled',
    });
    expect(await t().transfer.list({ limit: 10, status: 'canceled' })).toHaveLength(1);
    expect(await t().transfer.expireDue({})).toEqual({ expired: [] });
  });

  it('parses strictly: extra fields, a bad region, a threshold on a not-applies rule, a number amount, a bad field', async () => {
    expect((await refused(t().rules.set({ ...rule, extra: 1 }))).code).toBe('BAD_REQUEST');
    expect((await refused(t().rules.set({ ...rule, region: 'de' }))).code).toBe('BAD_REQUEST');
    expect((await refused(t().rules.set({ ...rule, applies: false }))).code).toBe('BAD_REQUEST');
    expect((await refused(t().rules.set({ ...rule, threshold: undefined }))).code).toBe('BAD_REQUEST');
    expect((await refused(t().rules.set({ ...rule, fields: [] }))).code).toBe('BAD_REQUEST');
    expect((await refused(t().rules.set({ ...rule, fields: ['shoe_size'] }))).code).toBe('BAD_REQUEST');
    expect((await refused(t().rules.assess({ region: '*', entity: 'individual', assetId: 'USDT', amount: '5' }))).code).toBe('BAD_REQUEST');
    expect((await refused(t().rules.assess({ region: 'DE', entity: 'individual', assetId: 'USDT', amount: 5 }))).code).toBe('BAD_REQUEST');
    expect((await refused(t().waitLimits.set({ pendingSeconds: 0, repairSeconds: 5 }))).code).toBe('BAD_REQUEST');
    expect((await refused(t().transfer.list({}))).code).toBe('BAD_REQUEST');
  });

  it('is founder-only: a caller who is not a founder is refused everywhere', async () => {
    founderOk = false;
    expect((await refused(t().rules.list({}))).code).toBe('FORBIDDEN');
    expect((await refused(t().rules.set(rule))).code).toBe('FORBIDDEN');
    expect((await refused(t().waitLimits.set({ pendingSeconds: 5, repairSeconds: 5 }))).code).toBe('FORBIDDEN');
    expect((await refused(t().transfer.list({ limit: 5 }))).code).toBe('FORBIDDEN');
    expect((await refused(t().transfer.mark({ transferId: randomUUID(), to: 'canceled', reason: 'x' }))).code).toBe('FORBIDDEN');
    expect((await refused(t().message.create({ transferId: randomUUID(), originator: {}, beneficiary: {}, transfer: {} }))).code).toBe(
      'FORBIDDEN',
    );
  });
});
