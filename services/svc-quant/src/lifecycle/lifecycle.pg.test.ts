import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresLifecycleRepository } from './postgres-repository.js';
import type { RecordPromotion } from './repository.js';

// AL-lifecycle-01 on Postgres: a decision and its stage row are one write; the same key reads the first answer back;
// two presses racing under different keys move the stage once; an operator's criterion keeps its audit row.
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, '../..');
const SCHEMA = `qlife_${process.pid}_${Date.now().toString(36)}`;
const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function testDatabaseUrl(): string {
  const fromEnv = process.env.TEST_DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;
  const file = readFileSync(join(homedir(), '.codex/context/work/runs/test-db.env'), 'utf8');
  const line = file.split('\n').find((row) => row.startsWith('TEST_DATABASE_URL='));
  const value = line?.slice('TEST_DATABASE_URL='.length).trim();
  if (!value) throw new Error('quant.database_url_unset — TEST_DATABASE_URL is unset');
  return value;
}

function promotion(key: string, approved: boolean): RecordPromotion {
  const at = '2026-11-12T00:00:00.000Z';
  const decision = {
    decision: approved ? ('approved' as const) : ('rejected' as const),
    at,
    runIds: ['run_1', 'run_2'],
    criteria: [{ name: 'paperMinutes' as const, value: '60' }],
  };
  const stage = approved ? { from: 'paper' as const, to: 'candidate' as const, at, runIds: ['run_1', 'run_2'] } : null;
  return {
    key,
    accountId: ACCOUNT,
    strategyId: 'str_1',
    strategyVersion: 1,
    actor: ACCOUNT,
    decision,
    stage,
    response: { decision, stage },
  };
}

describe('lifecycle store on Postgres (AL-lifecycle-01)', () => {
  const sql = postgres(testDatabaseUrl(), { max: 8, onnotice: () => undefined });
  const repo = createPostgresLifecycleRepository(sql, SCHEMA);

  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql.unsafe(`CREATE SCHEMA "${SCHEMA}"`);
    const migration = readFileSync(join(SERVICE, 'drizzle/20261112120000_quant_lifecycle.sql'), 'utf8').replaceAll(
      '"quant"',
      `"${SCHEMA}"`,
    );
    await sql.unsafe(migration);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql.end({ timeout: 5 });
  });

  it('keeps each criterion write with its actor and reason, replays a key, and stores blank as not set', async () => {
    const set = {
      name: 'gate.paperMinutes' as const,
      value: '60',
      toBoot: false,
      reason: 'LOCAL TEST',
      actor: ACCOUNT,
      idempotencyKey: 'c1',
    };
    expect(await repo.setCriterion(set)).toMatchObject({ name: 'gate.paperMinutes', value: '60' });
    expect(await repo.setCriterion({ ...set, value: '5' })).toMatchObject({ value: '60' });
    await repo.setCriterion({ ...set, value: null, idempotencyKey: 'c2' });
    expect(await repo.criteria()).toEqual([expect.objectContaining({ name: 'gate.paperMinutes', value: null })]);
    await repo.setCriterion({ ...set, value: '7', toBoot: true, idempotencyKey: 'c3' });
    expect(await repo.criteria()).toEqual([]);
    const audit = await sql.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM "${SCHEMA}".owner_criteria_audit`);
    expect(audit[0]?.n).toBe('3');
  });

  it('moves the stage once when two presses race, and reads the first answer back under its key', async () => {
    const raced = await Promise.all([repo.record(promotion('k:0', true)), repo.record(promotion('k:1', true))]);
    expect(raced.filter((r) => r !== null)).toHaveLength(1);
    expect(await repo.record(promotion('k:0', true))).toEqual(promotion('k:0', true).response);
    const stored = await repo.of({ accountId: ACCOUNT, strategyId: 'str_1', strategyVersion: 1 });
    expect(stored.stages).toHaveLength(1);
    expect(stored.decisions).toHaveLength(1);
    expect(await repo.replay(ACCOUNT, 'k:0')).toEqual(promotion('k:0', true).response);
    expect(await repo.replay('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'k:0')).toBeNull();
  });

  it('stores a rejection as a decision with no stage row', async () => {
    await repo.record({ ...promotion('r:0', false), strategyId: 'str_2' });
    const stored = await repo.of({ accountId: ACCOUNT, strategyId: 'str_2', strategyVersion: 1 });
    expect(stored.decisions.map((d) => d.decision)).toEqual(['rejected']);
    expect(stored.stages).toEqual([]);
  });
});
