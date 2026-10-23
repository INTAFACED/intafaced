import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPayNamespaces } from '../namespaces/index.js';
import type { PolicyRule } from './policy/schemas.js';
import { SWEEP_POLICY_KIND } from './sweeps/service.js';

/**
 * The `policy` config applier that createCustodyRouter wires (merge of W-custody-ops-07 with W-custody-ops-05): a task
 * with no `payload.kind` publishes the transaction policy draft; a named kind routes by `payload.kind`. Driven through
 * the real founderAdmin router against a real Postgres. All figures and addresses are TEST values.
 */
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
    .withDatabase('intafaced_custody_policy_scope_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const TREASURY = '0xTEST000000000000000000000000000000treasury';
const allowAll: PolicyRule = { id: 'allow-all', action: 'allow', match: {} };

describe('custody policy scope routing (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let founder = 'founder-a';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any;
  const custody = () => api.founderAdmin.custody;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
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
    api = createPayNamespaces({ founderAuthority: async () => founder, custody: { sql: db.sql } }).createCaller({
      principal,
      service: null,
      region: 'DE',
      requestId: 'r',
    });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    await db.sql.unsafe(`ALTER TABLE pay.custody_policy_versions DISABLE TRIGGER custody_policy_immutable_trg`);
    await db.sql.unsafe(`DELETE FROM pay.custody_policy_versions`);
    await db.sql.unsafe(`ALTER TABLE pay.custody_policy_versions ENABLE TRIGGER custody_policy_immutable_trg`);
    await db.sql.unsafe(`TRUNCATE pay.custody_sweep_policy_events RESTART IDENTITY CASCADE`);
    await db.sql.unsafe(`TRUNCATE pay.custody_task_quorum_events, pay.custody_approver_events RESTART IDENTITY CASCADE`);
    founder = 'owner';
    await custody().approvalSettings.setQuorum({ kind: 'config', requiredApprovals: 1, expirySeconds: 600 });
    await custody().approvers.register({ userId: 'founder-b', label: 'TEST approver', role: 'founder' });
    founder = 'founder-a';
  }, 30_000);

  /** founder-a proposes a `policy` task, founder-b approves it (which runs the applier); returns the task id and the outcome. */
  async function run(payload: Record<string, unknown>) {
    founder = 'founder-a';
    const task = await custody().config.propose({ scope: 'policy', title: 'TEST', payload, clientRef: `scope-${randomUUID()}` });
    founder = 'founder-b';
    const out = await custody()
      .config.approve({ taskId: task.id, payloadHash: task.payloadHash })
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    founder = 'founder-a';
    const [row] = await db.sql<Array<{ status: string; failure_code: string | null }>>`
      SELECT status, failure_code FROM pay.custody_tasks WHERE id = ${task.id}`;
    return { taskId: task.id as string, error: out, row: row! };
  }

  it('a kind-less { version, rulesHash } task publishes the transaction policy draft', async () => {
    const draft = await custody().policy.draft({ rules: [allowAll], note: 'TEST', expectedDraftVersion: null });
    const { taskId, error } = await run({ version: draft.version, rulesHash: draft.rulesHash });
    expect(error).toBeNull();
    expect(await custody().policy.current()).toMatchObject({ version: draft.version, status: 'published', approvalTaskId: taskId });
    expect(await db.sql`SELECT 1 FROM pay.custody_sweep_policy_events`).toHaveLength(0);
  });

  it('kind = SWEEP_POLICY_KIND reaches the sweep applier and leaves the transaction policy alone', async () => {
    const payload = await custody().sweeps.policy.validate({
      networkId: 'testnet-evm',
      assetId: 'USDT',
      trigger: 'immediate',
      thresholdAmount: null,
      thresholdCount: null,
      scheduleMinutes: null,
      treasuryAddress: TREASURY,
      reason: 'TEST policy',
    });
    expect(payload.kind).toBe(SWEEP_POLICY_KIND);
    const { taskId, error } = await run(payload);
    expect(error).toBeNull();
    expect(await custody().sweeps.policy.get({ networkId: 'testnet-evm', assetId: 'USDT' })).toMatchObject({
      approvalTaskId: taskId,
      treasuryAddress: TREASURY,
    });
    expect(await custody().policy.list({})).toEqual([]);
  });

  it('an unknown kind fails the task with custody_policy.kind_unknown and publishes nothing', async () => {
    const draft = await custody().policy.draft({ rules: [allowAll], note: 'TEST', expectedDraftVersion: null });
    const { error, row } = await run({ kind: 'nope', version: draft.version, rulesHash: draft.rulesHash });
    expect(error?.message).toMatch(/no applier for policy kind/);
    expect(row).toMatchObject({ status: 'failed', failure_code: 'custody_policy.kind_unknown' });
    expect((await custody().policy.list({}))[0].status).toBe('draft');
    expect(await db.sql`SELECT 1 FROM pay.custody_sweep_policy_events`).toHaveLength(0);
  });

  it('a kind-less task without a version fails with custody_policy.task_payload_invalid', async () => {
    const draft = await custody().policy.draft({ rules: [allowAll], note: 'TEST', expectedDraftVersion: null });
    const { error, row } = await run({ rulesHash: draft.rulesHash });
    expect(error).not.toBeNull();
    expect(row).toMatchObject({ status: 'failed', failure_code: 'custody_policy.task_payload_invalid' });
    expect((await custody().policy.list({}))[0].status).toBe('draft');
  });
});
