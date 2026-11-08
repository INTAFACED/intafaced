import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodePrincipal,
  signPrincipalHeader,
} from '@intafaced/contracts';
import { createQuantRouter } from '../router.js';
import { RUN_RESULT_MAX_BYTES } from '../runs/limit.js';
import { createPostgresRunRepository } from '../runs/postgres-repository.js';
import { createPostgresStrategyRepository } from '../studio/postgres-repository.js';
import { createPostgresQuota } from './postgres.js';

// AL-limits-01 on Postgres: the count and the write are one transaction, so two writes racing at the limit can't both
// pass; usage is counted from the stored rows; the TEST seed never overwrites an operator's row.
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, '../..');
const SCHEMA = `qquota_${process.pid}_${Date.now().toString(36)}`;
const SECRET = 'a-quant-quota-pg-test-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPERATOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function testDatabaseUrl(): string {
  const fromEnv = process.env.TEST_DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;
  const file = readFileSync(join(homedir(), '.codex/context/work/runs/test-db.env'), 'utf8');
  const line = file.split('\n').find((row) => row.startsWith('TEST_DATABASE_URL='));
  const value = line?.slice('TEST_DATABASE_URL='.length).trim();
  if (!value) throw new Error('quant.database_url_unset — TEST_DATABASE_URL is unset');
  return value;
}

function signed(userId: string, scopes: string[] = ['trade:read']) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'basic' as const,
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return edgeContext({
    headers: {
      'x-intafaced-region': 'DE',
      [EDGE_PRINCIPAL_HEADER]: raw,
      [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, SECRET, 'DE'),
    },
    id: `req-${userId}-${scopes.join(',')}`,
  });
}

const strategy = (n: number) => ({
  name: `TEST strategy ${n}`,
  blocks: [{ side: 'buy' as const, symbol: 'BTC-USD', qty: '0.01' }],
  risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
  cash: '10000',
  environment: 'paper',
  clientStrategyId: `client-${n}`,
  idempotencyKey: `save-${n}`,
});

describe('quotas on Postgres (AL-limits-01)', () => {
  const url = testDatabaseUrl();
  const sql = postgres(url, { max: 8, onnotice: () => undefined });
  const quota = createPostgresQuota(sql, {
    schema: SCHEMA,
    defaultProfile: 'TEST seeded',
    seed: { profile: 'TEST seeded', limits: { strategies: '2', versions: '5', concurrent_runs: '5', runs: '2', storage: '10000000' } },
  });
  const app = createQuantRouter({
    wired: true,
    venueVaultSet: false,
    limits: { maxOps: 5_000, maxSource: 8_000 },
    strategies: createPostgresStrategyRepository(sql, SCHEMA, quota.gate),
    runs: createPostgresRunRepository(sql, SCHEMA, RUN_RESULT_MAX_BYTES, quota.gate),
    quota: quota.repository,
  });
  const a = app.createCaller(signed(ACCOUNT_A));
  const b = app.createCaller(signed(ACCOUNT_B));
  const writer = app.createCaller(signed(OPERATOR, ['admin:write']));
  const reader = app.createCaller(signed(OPERATOR, ['admin:read']));

  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    for (const file of [
      'drizzle/0000_quant_strategies.sql',
      'drizzle/0001_quant_runs.sql',
      'drizzle/0003_quant_signal_rules.sql',
      'drizzle/0005_quant_run_labels.sql',
      'drizzle/20261030134631_quant_strategy_heads.sql',
      'drizzle/20261030142944_quant_release_notes.sql',
      'drizzle/20261107080000_quant_quotas.sql',
    ]) {
      const migration = readFileSync(join(SERVICE, file), 'utf8').replaceAll('"quant"', `"${SCHEMA}"`).replaceAll("'quant'", `'${SCHEMA}'`);
      await sql.unsafe(migration);
    }
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql.end({ timeout: 5 });
  });

  it('lets exactly one of two saves racing at the limit through, and counts usage from the stored rows', async () => {
    await a.studio.save(strategy(1));
    const raced = await Promise.allSettled([a.studio.save(strategy(2)), a.studio.save(strategy(3))]);
    expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = raced.find((r) => r.status === 'rejected');
    expect(String((refused as PromiseRejectedResult).reason?.message)).toBe('quant.quota_exceeded — strategies: 2 used of 2 allowed');
    expect((await a.studio.list({ limit: 10 })).strategies).toHaveLength(2);

    const usage = await a.quota.get();
    expect(usage.profile).toBe('TEST seeded');
    const row = (resource: string) => usage.resources.find((r) => r.resource === resource);
    expect(row('strategies')).toEqual({ resource: 'strategies', used: '2', limit: '2' });
    expect(row('versions')).toEqual({ resource: 'versions', used: '1', limit: '5' });
    expect(row('runs')).toEqual({ resource: 'runs', used: '0', limit: '2' });
    expect(row('collaborators')).toEqual({ resource: 'collaborators', used: '0', limit: null });
    const stored = await sql.unsafe<{ n: string }[]>(
      `SELECT SUM(octet_length(v.source))::text AS n FROM "${SCHEMA}".strategy_versions v JOIN "${SCHEMA}".strategies s ON s.id = v.strategy_id WHERE s.account_id = $1`,
      [ACCOUNT_A],
    );
    expect(row('storage')?.used).toBe(stored[0]?.n);
    // The other account counts from zero.
    expect((await b.quota.get()).resources.find((r) => r.resource === 'strategies')?.used).toBe('0');
  });

  it('lets exactly one of two runs racing at the stored-run limit through, and a replay is never counted', async () => {
    const saved = (await a.studio.list({ limit: 10 })).strategies[0];
    if (!saved) throw new Error('no strategy');
    await a.studio.run({ id: saved.id, environment: 'paper', idempotencyKey: 'run-1' });
    const raced = await Promise.allSettled([
      a.studio.run({ id: saved.id, environment: 'paper', idempotencyKey: 'run-2' }),
      a.studio.run({ id: saved.id, environment: 'paper', idempotencyKey: 'run-3' }),
    ]);
    expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const count = await sql.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM "${SCHEMA}".runs WHERE user_id = $1`, [ACCOUNT_A]);
    expect(count[0]?.n).toBe('2');
    await expect(a.studio.run({ id: saved.id, environment: 'paper', idempotencyKey: 'run-1' })).resolves.toMatchObject({ ok: true });
    expect((await a.quota.get()).resources.find((r) => r.resource === 'runs')).toEqual({ resource: 'runs', used: '2', limit: '2' });
  });

  it('keeps an operator row over the TEST seed, and keeps every write with its actor and reason', async () => {
    await writer.ops.quota.set({
      profile: 'TEST seeded',
      resource: 'strategies',
      limit: '3',
      reason: 'LOCAL TEST raise',
      idempotencyKey: 'raise-1',
    });
    // A second process seeding the same profile inserts nothing over it.
    const again = createPostgresQuota(sql, {
      schema: SCHEMA,
      defaultProfile: 'TEST seeded',
      seed: { profile: 'TEST seeded', limits: { strategies: '2' } },
    });
    const limits = await again.repository.limits('TEST seeded');
    expect(limits.find((row) => row.resource === 'strategies')?.limit).toBe(3n);
    expect((await reader.ops.quota.profile({ profile: 'TEST seeded' })).limits.find((row) => row.resource === 'strategies')?.limit).toBe(
      '3',
    );
    const audit = await sql.unsafe<{ actor: string; reason: string }[]>(
      `SELECT actor, reason FROM "${SCHEMA}".quota_audit WHERE idempotency_key = 'raise-1'`,
    );
    expect(audit).toEqual([{ actor: OPERATOR, reason: 'LOCAL TEST raise' }]);
    await expect(
      writer.ops.quota.set({ profile: 'TEST seeded', resource: 'strategies', limit: '9', reason: '', idempotencyKey: 'raise-2' }),
    ).rejects.toThrow(/^quant\.quota_reason_unset/);
    expect((await quota.repository.limits('TEST seeded')).find((row) => row.resource === 'strategies')?.limit).toBe(3n);
  });
});
