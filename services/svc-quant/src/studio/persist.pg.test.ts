import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import type { QuantSignalRules } from '@intafaced/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileSignalRules } from './modules.js';
import { createPostgresStrategyRepository } from './postgres-repository.js';
import type { StrategyRepository } from './repository.js';
import type { StrategyDraft } from './repository.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, '../..');
const SCHEMA = `qbe_${process.pid}_${Date.now().toString(36)}`;

const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function testDatabaseUrl(): string {
  const fromEnv = process.env.TEST_DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;
  const file = readFileSync(join(homedir(), '.codex/context/work/runs/test-db.env'), 'utf8');
  const line = file.split('\n').find((row) => row.startsWith('TEST_DATABASE_URL='));
  const value = line?.slice('TEST_DATABASE_URL='.length).trim();
  if (!value) throw new Error('quant.database_url_unset — TEST_DATABASE_URL is unset');
  return value;
}

const SIGNAL_RULES: QuantSignalRules = {
  symbol: 'BTC/USDT',
  barSize: '1h',
  signal: { kind: 'ma_cross', average: 'sma', fast: '3', slow: '5' },
  sizing: { kind: 'quantity', value: '0.01' },
  exit: { stopLossPercent: '', takeProfitPercent: '' },
};

const draft = (name: string): StrategyDraft => ({
  name,
  language: 'javascript',
  source: 'oms.buy("BTC-USD", "0.01");',
  cash: '10000',
  blocks: [{ side: 'buy', symbol: 'BTC-USD', qty: '0.01' }],
  modules: null,
  risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
  environment: 'paper',
  kind: 'paper',
  claimLabel: 'Paper — not live performance',
  live: false,
  simulated: true,
});

interface EsbuildResolveArgs {
  path: string;
  resolveDir: string;
}

interface EsbuildPluginBuild {
  onResolve(options: { filter: RegExp }, callback: (args: EsbuildResolveArgs) => { path: string } | undefined): void;
}

/**
 * One bundle for the whole file. `tsx` on every test paid ~200–400ms of cold
 * start before any SQL (measured 2026-10-18, five samples: tsx cli 368–409ms,
 * `node --import tsx` 173–234ms, this bundle 102–146ms). CI's 5s test budget
 * is the same window a loaded runner spends booting tsx, so the compile happens
 * here, once, and the test spawns plain node.
 */
async function bundleReopenProbe(outfile: string): Promise<void> {
  const tsxPackage = createRequire(join(SERVICE, 'package.json')).resolve('tsx/package.json');
  const esbuildPath = createRequire(tsxPackage).resolve('esbuild');
  const { build } = (await import(esbuildPath)) as {
    build: (options: {
      entryPoints: string[];
      bundle: true;
      platform: 'node';
      format: 'esm';
      outfile: string;
      plugins: Array<{ name: string; setup: (build: EsbuildPluginBuild) => void }>;
    }) => Promise<unknown>;
  };
  await build({
    entryPoints: [join(HERE, 'reopen-probe.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    plugins: [
      {
        name: 'js-to-ts',
        setup(esbuild) {
          esbuild.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, (args) => {
            if (!args.resolveDir.startsWith(SERVICE)) return undefined;
            const target = join(args.resolveDir, args.path.replace(/\.js$/, '.ts'));
            if (!existsSync(target)) return undefined;
            return { path: target };
          });
        },
      },
    ],
  });
}

describe('paper strategies survive a new connection to the same database', () => {
  const url = testDatabaseUrl();
  const sql = postgres(url, { max: 2, onnotice: () => undefined });
  let repo: StrategyRepository;
  let probeProgram = '';
  let probeDir = '';

  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    for (const file of [
      'drizzle/0000_quant_strategies.sql',
      'drizzle/0003_quant_signal_rules.sql',
      'drizzle/20261030134631_quant_strategy_heads.sql',
    ]) {
      const migration = readFileSync(join(SERVICE, file), 'utf8').replaceAll('"quant"', `"${SCHEMA}"`).replaceAll("'quant'", `'${SCHEMA}'`);
      await sql.unsafe(migration);
    }
    repo = createPostgresStrategyRepository(sql, SCHEMA);
    probeDir = mkdtempSync(join(tmpdir(), 'quant-reopen-'));
    probeProgram = join(probeDir, 'reopen-probe.mjs');
    await bundleReopenProbe(probeProgram);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql.end({ timeout: 0 });
    if (probeDir) rmSync(probeDir, { recursive: true, force: true });
  });

  it('keeps every version for the owner, hides a delete, and refuses another account', async () => {
    const created = await repo.create({
      accountId: ACCOUNT_A,
      clientStrategyId: 'client-alpha',
      idempotencyKey: 'idem-create',
      draft: draft('alpha'),
    });
    const replayKey = await repo.create({
      accountId: ACCOUNT_A,
      clientStrategyId: 'client-other',
      idempotencyKey: 'idem-create',
      draft: draft('should-not-apply'),
    });
    expect(replayKey.id).toBe(created.id);
    expect(replayKey.name).toBe('alpha');
    expect(replayKey.versions).toHaveLength(1);

    const replayClient = await repo.create({
      accountId: ACCOUNT_A,
      clientStrategyId: 'client-alpha',
      idempotencyKey: 'idem-create-2',
      draft: draft('still-alpha'),
    });
    expect(replayClient.id).toBe(created.id);
    expect(replayClient.versions).toHaveLength(1);

    const revised = await repo.revise({
      accountId: ACCOUNT_A,
      id: created.id,
      idempotencyKey: 'idem-revise',
      draft: draft('beta'),
    });
    expect(revised.version).toBe(2);
    expect(revised.versions[0]?.name).toBe('alpha');
    expect(revised.versions[0]?.version).toBe(1);
    expect(revised.versions[1]?.name).toBe('beta');

    const reviseReplay = await repo.revise({
      accountId: ACCOUNT_A,
      id: created.id,
      idempotencyKey: 'idem-revise',
      draft: draft('gamma'),
    });
    expect(reviseReplay.name).toBe('beta');
    expect(reviseReplay.versions).toHaveLength(2);

    const reopened = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      const again = createPostgresStrategyRepository(reopened, SCHEMA);
      const loaded = await again.get({ accountId: ACCOUNT_A, id: created.id });
      expect(loaded?.versions.map((row) => row.name)).toEqual(['alpha', 'beta']);
      expect(loaded?.cash).toBe('10000');
      expect(typeof loaded?.cash).toBe('string');
    } finally {
      await reopened.end({ timeout: 0 });
    }

    // A second OS process on the bundle from beforeAll. tsx in this budget is
    // what timed the test out at 5000ms on a loaded CI runner.
    const probe = spawnSync(process.execPath, [probeProgram], {
      cwd: SERVICE,
      encoding: 'utf8',
      env: {
        ...process.env,
        QUANT_REOPEN_URL: url,
        QUANT_REOPEN_SCHEMA: SCHEMA,
        QUANT_REOPEN_ACCOUNT: ACCOUNT_A,
        QUANT_REOPEN_ID: created.id,
      },
    });
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual({
      versions: [
        { version: 1, name: 'alpha' },
        { version: 2, name: 'beta' },
      ],
    });

    const second = await repo.create({
      accountId: ACCOUNT_A,
      clientStrategyId: 'client-second',
      idempotencyKey: 'idem-second',
      draft: draft('second'),
    });
    const third = await repo.create({
      accountId: ACCOUNT_A,
      clientStrategyId: 'client-third',
      idempotencyKey: 'idem-third',
      draft: draft('third'),
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 4; i += 1) {
      const page = await repo.list({ accountId: ACCOUNT_A, limit: 1, cursor });
      if (page.strategies[0]) seen.push(page.strategies[0].id);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([created.id, second.id, third.id]);
    await repo.softDelete({ accountId: ACCOUNT_A, id: second.id, idempotencyKey: 'idem-delete-second' });
    await repo.softDelete({ accountId: ACCOUNT_A, id: third.id, idempotencyKey: 'idem-delete-third' });

    expect(await repo.list({ accountId: ACCOUNT_B, limit: 50 })).toEqual({ strategies: [], nextCursor: null });
    expect(await repo.get({ accountId: ACCOUNT_B, id: created.id })).toBeNull();
    await expect(repo.softDelete({ accountId: ACCOUNT_B, id: created.id, idempotencyKey: 'idem-foreign-delete' })).rejects.toThrow(
      /strategy not found/,
    );
    expect(await repo.versions({ accountId: ACCOUNT_B, id: created.id })).toBeNull();

    await expect(sql.unsafe(`UPDATE "${SCHEMA}".strategy_versions SET name = 'hacked' WHERE version = 1`)).rejects.toThrow(/immutable/);
    const versionOne = await sql<{ name: string }[]>`
      SELECT name FROM ${sql(SCHEMA)}.strategy_versions WHERE strategy_id = ${created.id} AND version = 1
    `;
    expect(versionOne[0]?.name).toBe('alpha');

    await repo.softDelete({ accountId: ACCOUNT_A, id: created.id, idempotencyKey: 'idem-delete' });
    expect(await repo.list({ accountId: ACCOUNT_A, limit: 50 })).toEqual({ strategies: [], nextCursor: null });
    expect(await repo.get({ accountId: ACCOUNT_A, id: created.id })).toBeNull();
    const kept = await repo.versions({ accountId: ACCOUNT_A, id: created.id });
    expect(kept?.map((row) => ({ version: row.version, name: row.name }))).toEqual([
      { version: 1, name: 'alpha' },
      { version: 2, name: 'beta' },
    ]);
    const counted = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(SCHEMA)}.strategy_versions WHERE strategy_id = ${created.id}
    `;
    expect(Number(counted[0]?.n)).toBe(2);
  });

  it('keeps signal rules on a version and refuses a row with both blocks and rules, or neither', async () => {
    const compiled = compileSignalRules(SIGNAL_RULES);
    const saved = await repo.create({
      accountId: ACCOUNT_A,
      clientStrategyId: 'client-signal',
      idempotencyKey: 'idem-signal',
      draft: { ...draft('signal'), blocks: [], modules: compiled.rules, source: compiled.source },
    });
    expect(saved.modules).toEqual(compiled.rules);
    expect(saved.blocks).toEqual([]);
    expect((await repo.get({ accountId: ACCOUNT_A, id: saved.id }))?.versions[0]?.modules).toEqual(compiled.rules);

    await expect(
      repo.create({
        accountId: ACCOUNT_A,
        clientStrategyId: 'client-both',
        idempotencyKey: 'idem-both',
        draft: { ...draft('both'), modules: compiled.rules },
      }),
    ).rejects.toThrow(/strategy_versions_rules_ck/);
    await expect(
      repo.create({
        accountId: ACCOUNT_A,
        clientStrategyId: 'client-neither',
        idempotencyKey: 'idem-neither',
        draft: { ...draft('neither'), blocks: [] },
      }),
    ).rejects.toThrow(/strategy_versions_rules_ck/);
    // The database refuses rules the service would refuse, even when a key is missing entirely.
    for (const modules of ['{}', JSON.stringify({ ...compiled.rules, sizing: { kind: 'quantity', value: '0' } })]) {
      await expect(
        sql.unsafe(
          `INSERT INTO "${SCHEMA}".strategy_versions (strategy_id, version, name, language, source, cash, blocks, risk,
             environment, kind, claim_label, live, simulated, created_at, modules)
           SELECT strategy_id, 99, name, language, source, cash, '[]'::jsonb, risk, environment, kind, claim_label, live,
             simulated, created_at, $1::jsonb
           FROM "${SCHEMA}".strategy_versions WHERE strategy_id = $2 AND version = 1`,
          [modules, saved.id],
        ),
      ).rejects.toThrow(/strategy_versions_rules_ck/);
    }
    // The reversal refuses while a version holds signal rules, rather than drop them.
    const down = readFileSync(join(SERVICE, 'drizzle/0003_quant_signal_rules.down.sql'), 'utf8')
      .replaceAll('"quant"', `"${SCHEMA}"`)
      .replaceAll("'quant'", `'${SCHEMA}'`);
    await expect(sql.unsafe(down)).rejects.toThrow(/quant\.signal_rules_present/);
    await repo.softDelete({ accountId: ACCOUNT_A, id: saved.id, idempotencyKey: 'idem-delete-signal' });
  });
  it('renames and moves the head without a version, and restores a deleted strategy with its versions (AL-editor-01)', async () => {
    const created = await repo.create({
      accountId: ACCOUNT_A,
      clientStrategyId: 'client-heads',
      idempotencyKey: 'idem-heads-create',
      draft: draft('heads'),
    });
    await repo.revise({ accountId: ACCOUNT_A, id: created.id, idempotencyKey: 'idem-heads-v2', draft: draft('heads') });
    const head = { name: 'Trend', folder: 'Momentum', description: 'Two averages' };
    const moved = await repo.organise({ accountId: ACCOUNT_A, id: created.id, idempotencyKey: 'idem-heads-organise', head });
    expect(moved).toMatchObject({ ...head, organised: 1, version: 2 });
    const replay = await repo.organise({
      accountId: ACCOUNT_A,
      id: created.id,
      idempotencyKey: 'idem-heads-organise',
      head: { name: 'Other', folder: '', description: '' },
    });
    expect(replay).toMatchObject({ ...head, organised: 1 });
    const counted = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(SCHEMA)}.strategy_versions WHERE strategy_id = ${created.id}
    `;
    expect(counted[0]?.n).toBe(2);
    // The database refuses a nested folder even when the service is bypassed.
    await expect(sql.unsafe(`UPDATE "${SCHEMA}".strategies SET folder = 'a/b' WHERE id = $1`, [created.id])).rejects.toThrow(
      /strategies_head_ck/,
    );
    await expect(repo.organise({ accountId: ACCOUNT_B, id: created.id, idempotencyKey: 'idem-heads-foreign', head })).rejects.toThrow(
      /strategy not found/,
    );

    await repo.softDelete({ accountId: ACCOUNT_A, id: created.id, idempotencyKey: 'idem-heads-delete' });
    const bin = await repo.listDeleted({ accountId: ACCOUNT_A, limit: 50 });
    expect(bin.strategies.find((row) => row.id === created.id)).toMatchObject({ name: 'Trend', version: 2 });
    expect((await repo.list({ accountId: ACCOUNT_A, limit: 50 })).strategies.some((row) => row.id === created.id)).toBe(false);
    expect((await repo.listDeleted({ accountId: ACCOUNT_B, limit: 50 })).strategies).toEqual([]);
    const restored = await repo.restore({ accountId: ACCOUNT_A, id: created.id, idempotencyKey: 'idem-heads-restore' });
    expect(restored).toMatchObject({ deletedAt: null, restores: 1, folder: 'Momentum' });
    expect(restored.versions.map((row) => row.version)).toEqual([1, 2]);
    expect(await repo.restore({ accountId: ACCOUNT_A, id: created.id, idempotencyKey: 'idem-heads-restore' })).toMatchObject({
      restores: 1,
    });
    await expect(repo.restore({ accountId: ACCOUNT_B, id: created.id, idempotencyKey: 'idem-heads-restore-b' })).rejects.toThrow(
      /strategy not found/,
    );
    // The reversal drops the head fields and keeps every version; applying it again restores the columns.
    const read = (file: string) => readFileSync(join(SERVICE, 'drizzle', file), 'utf8').replaceAll('"quant"', `"${SCHEMA}"`);
    await sql.unsafe(read('20261030134631_quant_strategy_heads.down.sql'));
    const after = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(SCHEMA)}.strategy_versions WHERE strategy_id = ${created.id}
    `;
    expect(after[0]?.n).toBe(2);
    await sql.unsafe(read('20261030134631_quant_strategy_heads.sql'));
  });
});
