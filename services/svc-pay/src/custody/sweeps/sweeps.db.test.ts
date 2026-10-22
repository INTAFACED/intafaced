import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { stubApprovalConsumer } from '../../action-approval-consume.js';
import { MerchantControlError } from '../../merchant-account-controls.js';
import { createPayNamespaces } from '../../namespaces/index.js';
import type { SweepBroadcaster, SweepBroadcastResult } from './service.js';

/**
 * Sweeps to treasury (W-custody-ops-05) through the real founderAdmin router against a real Postgres. Addresses, amounts
 * and figures are TEST values; a fake broadcaster stands in for the chain.
 */
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
    .withDatabase('intafaced_custody_sweeps_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

type Err = { code: string; message?: string };
async function refused(p: Promise<unknown>): Promise<Err> {
  try {
    await p;
  } catch (e) {
    return e as Err;
  }
  throw new Error('expected the call to be refused');
}

const TREASURY = '0xTEST000000000000000000000000000000treasury';

describe('custody sweeps to treasury (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let founderOk = true;
  let next: () => Promise<SweepBroadcastResult> = async () => ({ state: 'broadcast', txHash: '0xTESTTX' });
  const sent: Array<{ idempotencyKey: string; amount: string; toAddress: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any;
  let apiNoRail: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let apiSelfApproved: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const sweeps = () => api.founderAdmin.custody.sweeps;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    const founderAuthority = async () => {
      if (!founderOk) throw new MerchantControlError('operator.denied');
      return 'founder-a';
    };
    const broadcaster: SweepBroadcaster = {
      send: async (input) => {
        sent.push(input);
        return next();
      },
    };
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
    const ctx = { principal, service: null, region: 'DE', requestId: 'r' };
    // TEST identity stand-ins: a second founder approves; or the proposer approves their own change.
    const approvals = stubApprovalConsumer('founder-b');
    api = createPayNamespaces({ founderAuthority, custody: { sql: db.sql, sweepBroadcaster: broadcaster, approvals } }).createCaller(ctx);
    apiNoRail = createPayNamespaces({ founderAuthority, custody: { sql: db.sql } }).createCaller(ctx);
    apiSelfApproved = createPayNamespaces({
      founderAuthority,
      custody: { sql: db.sql, approvals: stubApprovalConsumer('founder-a') },
    }).createCaller(ctx);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    founderOk = true;
    sent.length = 0;
    next = async () => ({ state: 'broadcast', txHash: '0xTESTTX' });
    await db.sql.unsafe(`TRUNCATE pay.custody_sweeps, pay.custody_sweep_policy_events, pay.custody_deposits RESTART IDENTITY CASCADE`);
  }, 30_000);

  /** A TEST deposit row as W-deposit-05 leaves it. */
  async function deposit(status: 'credited' | 'confirming', amount = '2', n = randomUUID().slice(0, 8)): Promise<string> {
    const credited = status === 'credited';
    const [row] = await db.sql<Array<{ id: string }>>`
      INSERT INTO pay.custody_deposits (user_id, asset_id, network_id, address, tx_hash, output_index, amount, status, ledger_tx_id, credited_at)
      VALUES ('user-test', 'USDT', 'testnet-evm', ${`0xTESTdeposit${n}`}, ${`0xTESThash${n}`}, 0, ${amount}, ${status},
              ${credited ? 'ledger-tx-test' : null}, ${credited ? new Date() : null})
      RETURNING id`;
    return row!.id;
  }
  const policyBody = (o: Record<string, unknown> = {}) => ({
    networkId: 'testnet-evm',
    assetId: 'USDT',
    trigger: 'immediate',
    thresholdAmount: null,
    thresholdCount: null,
    scheduleMinutes: null,
    treasuryAddress: TREASURY,
    reason: 'TEST policy',
    approvalId: 'appr-test',
    operationId: 'op-test',
    ...o,
  });
  const pair = { networkId: 'testnet-evm', assetId: 'USDT' };

  it('no policy: get, due and create refuse policy_unset', async () => {
    const id = await deposit('credited');
    expect((await refused(sweeps().policy.get(pair))).message).toMatch(/custody_sweep\.policy_unset/);
    expect((await refused(sweeps().due(pair))).message).toMatch(/custody_sweep\.policy_unset/);
    expect((await refused(sweeps().create({ depositId: id }))).message).toMatch(/custody_sweep\.policy_unset/);
    expect(await sweeps().list({})).toEqual([]);
  });

  it('a blank or mismatched figure refuses; the latest policy is the one in force', async () => {
    for (const bad of [
      { trigger: 'amount' },
      { trigger: 'amount', thresholdAmount: '0' },
      { trigger: 'amount', thresholdAmount: 'abc' },
      { trigger: 'count', thresholdCount: 0 },
      { trigger: 'schedule' },
      { trigger: 'immediate', thresholdCount: 3 },
      { treasuryAddress: '  ' },
    ]) {
      expect((await refused(sweeps().policy.set(policyBody(bad)))).message).toMatch(/custody_sweep\.policy_invalid/);
    }
    await sweeps().policy.set(policyBody());
    await sweeps().policy.set(policyBody({ trigger: 'amount', thresholdAmount: '5.50' }));
    expect(await sweeps().policy.get(pair)).toMatchObject({
      trigger: 'amount',
      thresholdAmount: '5.5',
      setBy: 'founder-a',
      approvedBy: 'founder-b',
    });
  });

  it('a policy (and so the treasury address) needs a second founder through identity action approval', async () => {
    const { approvalId: _a, operationId: _o, ...plain } = policyBody();
    const preview = await sweeps().policy.preview(plain);
    expect(preview.actionType).toBe('pay.custody_sweep_policy_set');
    expect(preview.payloadHash).toMatch(/^sha256:/);
    expect((await sweeps().policy.preview({ ...plain, treasuryAddress: '0xTESTother' })).payloadHash).not.toBe(preview.payloadHash);
    expect((await refused(apiNoRail.founderAdmin.custody.sweeps.policy.set(policyBody()))).message).toMatch(/IDENTITY_URL/);
    expect((await refused(apiSelfApproved.founderAdmin.custody.sweeps.policy.set(policyBody()))).message).toMatch(
      /distinct/,
    );
    expect((await refused(sweeps().policy.set(policyBody({ approvalId: null, operationId: null })))).code).toBe('PRECONDITION_FAILED');
    expect(await db.sql`SELECT 1 FROM pay.custody_sweep_policy_events`).toHaveLength(0);
  });

  it('due follows each trigger over credited deposits with no sweep yet', async () => {
    await deposit('credited', '2');
    await deposit('credited', '3');
    await deposit('confirming', '100');
    await sweeps().policy.set(policyBody({ trigger: 'amount', thresholdAmount: '5' }));
    expect(await sweeps().due(pair)).toMatchObject({ due: true, unsweptCount: 2, unsweptAmount: '5', lastSweepAt: null });
    await sweeps().policy.set(policyBody({ trigger: 'amount', thresholdAmount: '5.000000000000000001' }));
    expect((await sweeps().due(pair)).due).toBe(false);
    await sweeps().policy.set(policyBody({ trigger: 'count', thresholdCount: 3 }));
    expect((await sweeps().due(pair)).due).toBe(false);
    await sweeps().policy.set(policyBody({ trigger: 'count', thresholdCount: 2 }));
    expect((await sweeps().due(pair)).due).toBe(true);
    await sweeps().policy.set(policyBody({ trigger: 'schedule', scheduleMinutes: 60 }));
    expect((await sweeps().due(pair)).due).toBe(true);
  });

  it('only a credited deposit is swept; create is idempotent on sweep:<depositId>:treasury', async () => {
    await sweeps().policy.set(policyBody());
    const pending = await deposit('confirming');
    expect((await refused(sweeps().create({ depositId: pending }))).message).toMatch(/deposit_not_credited/);
    expect((await refused(sweeps().create({ depositId: randomUUID() }))).message).toMatch(/deposit_not_found/);
    const id = await deposit('credited', '2');
    const first = await sweeps().create({ depositId: id });
    expect(first).toMatchObject({
      idempotencyKey: `sweep:${id}:treasury`,
      status: 'pending',
      amount: '2',
      toAddress: TREASURY,
      attempts: 0,
    });
    expect(await sweeps().create({ depositId: id })).toEqual(first);
    expect(await sweeps().list({})).toHaveLength(1);
    expect((await sweeps().due(pair)).unsweptCount).toBe(0);
  });

  it('no broadcaster: execute refuses rail.crypto and the intent row stays pending', async () => {
    await sweeps().policy.set(policyBody());
    const s = await sweeps().create({ depositId: await deposit('credited') });
    const err = await refused(apiNoRail.founderAdmin.custody.sweeps.execute({ sweepId: s.id }));
    expect(err.message).toMatch(/rail\.crypto: Sweeping to treasury needs rail\.crypto\. It is switched off in this build\./);
    expect((await sweeps().list({}))[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('a failed send leaves balances alone and the retry reuses the same key; broadcast is final', async () => {
    await sweeps().policy.set(policyBody());
    const depositId = await deposit('credited');
    const before = await db.sql`SELECT * FROM pay.custody_deposits ORDER BY id`;
    const s = await sweeps().create({ depositId });
    next = async () => ({ state: 'failed', error: 'TEST insufficient gas' });
    expect(await sweeps().execute({ sweepId: s.id })).toMatchObject({
      status: 'failed',
      lastError: 'TEST insufficient gas',
      attempts: 1,
      lastExecutedBy: 'founder-a',
    });
    next = async () => ({ state: 'broadcast', txHash: '0xTESTTX' });
    expect(await sweeps().execute({ sweepId: s.id })).toMatchObject({
      status: 'broadcast',
      txHash: '0xTESTTX',
      attempts: 2,
      lastError: null,
    });
    expect(await sweeps().execute({ sweepId: s.id })).toMatchObject({ status: 'broadcast', attempts: 2 });
    expect(sent.map((x) => x.idempotencyKey)).toEqual([`sweep:${depositId}:treasury`, `sweep:${depositId}:treasury`]);
    // ENGINE D-5: a sweep never touches the customer's deposit record (and posts nothing to the ledger).
    expect(await db.sql`SELECT * FROM pay.custody_deposits ORDER BY id`).toEqual(before);
  });

  it('an unknown outcome keeps the intent row and the retry asks again with the original key', async () => {
    await sweeps().policy.set(policyBody());
    const depositId = await deposit('credited');
    const s = await sweeps().create({ depositId });
    next = async () => {
      throw new Error('TEST rpc timeout');
    };
    expect(await sweeps().execute({ sweepId: s.id })).toMatchObject({ status: 'unknown', lastError: 'unknown: TEST rpc timeout' });
    next = async () => ({ state: 'broadcast', txHash: '0xTESTFIRST' });
    expect(await sweeps().execute({ sweepId: s.id })).toMatchObject({ status: 'broadcast', txHash: '0xTESTFIRST' });
    expect(new Set(sent.map((x) => x.idempotencyKey))).toEqual(new Set([`sweep:${depositId}:treasury`]));
    expect((await refused(sweeps().execute({ sweepId: randomUUID() }))).message).toMatch(/sweep_not_found/);
  });

  it('refuses a caller who is not a founder', async () => {
    founderOk = false;
    expect((await refused(sweeps().list({}))).code).toBe('FORBIDDEN');
  });
});
