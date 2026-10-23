import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QuantSignalRules } from '@intafaced/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresTemplateRepository } from './postgres-repository.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, '../..');
const SCHEMA = `qtpl_${process.pid}_${Date.now().toString(36)}`;
const OPERATOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RULES: QuantSignalRules = {
  symbol: 'BTC/USDT',
  barSize: '1h',
  signal: { kind: 'ma_cross', average: 'sma', fast: '', slow: '' },
  sizing: { kind: 'quantity', value: '' },
  exit: { stopLossPercent: '', takeProfitPercent: '' },
};
const publish = {
  id: 'ma-cross',
  name: 'TEST moving-average cross',
  description: 'Buys when a fast average crosses above a slow one.',
  rules: RULES,
  releaseNote: 'First version.',
  reason: 'LOCAL TEST template',
  publishedBy: OPERATOR,
  idempotencyKey: 'template.publish:ma-cross:v1',
};

function testDatabaseUrl(): string {
  const fromEnv = process.env.TEST_DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;
  const file = readFileSync(join(homedir(), '.codex/context/work/runs/test-db.env'), 'utf8');
  const line = file.split('\n').find((row) => row.startsWith('TEST_DATABASE_URL='));
  const value = line?.slice('TEST_DATABASE_URL='.length).trim();
  if (!value) throw new Error('quant.database_url_unset — TEST_DATABASE_URL is unset');
  return value;
}

describe('starter templates on Postgres', () => {
  const sql = postgres(testDatabaseUrl(), { max: 6, onnotice: () => undefined });
  const repo = createPostgresTemplateRepository(sql, SCHEMA);

  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql.unsafe(`CREATE SCHEMA "${SCHEMA}"`);
    const migration = readFileSync(join(SERVICE, 'drizzle/0004_quant_templates.sql'), 'utf8')
      .replaceAll('"quant"', `"${SCHEMA}"`)
      .replaceAll("'quant'", `'${SCHEMA}'`);
    await sql.unsafe(migration);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql.end({ timeout: 0 });
  });

  it('versions per template, replays a key, refuses rewrites and any set number', async () => {
    const [first, again] = await Promise.all([repo.publish(publish), repo.publish(publish)]);
    expect(again).toEqual(first);
    expect(first.version).toBe(1);
    const second = await repo.publish({ ...publish, releaseNote: 'Second.', idempotencyKey: 'template.publish:ma-cross:v2' });
    expect(second.version).toBe(2);
    await repo.publish({ ...publish, id: 'breakout', idempotencyKey: 'template.publish:breakout:v1' });
    await expect(repo.publish({ ...publish, name: 'Other' })).rejects.toThrow(/quant\.idempotency_conflict/);

    expect((await repo.get('ma-cross'))?.map((row) => row.version)).toEqual([2, 1]);
    expect(await repo.get('missing')).toBeNull();
    const page = await repo.list({ limit: 1 });
    expect(page.templates.map((row) => [row.id, row.version])).toEqual([['breakout', 1]]);
    const next = await repo.list({ limit: 1, cursor: page.nextCursor });
    expect(next).toMatchObject({ nextCursor: null });
    expect(next.templates.map((row) => [row.id, row.version])).toEqual([['ma-cross', 2]]);

    await expect(sql.unsafe(`UPDATE "${SCHEMA}".templates SET name = 'x'`)).rejects.toThrow(/quant\.template_immutable/);
    await expect(
      repo.publish({ ...publish, rules: { ...RULES, signal: { ...RULES.signal, fast: '5' } }, idempotencyKey: 'raw-number' }),
    ).rejects.toThrow(/templates_numbers_blank_ck/);
    await expect(
      sql.unsafe(
        `INSERT INTO "${SCHEMA}".templates (template_id, version, name, description, rules, release_note, reason, published_by, idempotency_key, published_at)
         VALUES ('raw', 1, 'n', 'd', '{}'::jsonb, 'r', 'r', $1, 'raw-empty', now())`,
        [OPERATOR],
      ),
    ).rejects.toThrow(/templates_numbers_blank_ck/);
  });
});
