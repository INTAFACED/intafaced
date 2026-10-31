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
import type { BacktestLake } from '../backtest/lake.js';
import { QUANT_BACKTEST_SURFACE_REFUSED, QUANT_RUN_NOT_FOUND, QUANT_RUN_UNFINISHED, QUANT_STUDIO_NOT_FOUND } from '../errors.js';
import { createQuantRouter } from '../router.js';
import { RUN_RESULT_MAX_BYTES } from '../runs/limit.js';
import { createPostgresRunRepository } from '../runs/postgres-repository.js';
import { createPostgresStrategyRepository } from '../studio/postgres-repository.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, '../..');
const SCHEMA = `qdepth_${process.pid}_${Date.now().toString(36)}`;
const SECRET = 'a-quant-depth-test-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const limits = { maxOps: 5_000, maxSource: 8_000 };

const walkForward = {
  inSampleFrom: '2026-01-01T00:00:00.000Z',
  inSampleTo: '2026-04-01T00:00:00.000Z',
  outOfSampleFrom: '2026-04-01T00:00:00.000Z',
  outOfSampleTo: '2026-07-01T00:00:00.000Z',
};
const costModel = {
  fees: { kind: 'venue-schedule' as const, source: 'connect:venue-a:fee-schedule:v7' },
  slippage: { kind: 'order-book-replay' as const, source: 'connect:data-lake:venue-a:depth:v3' },
  latency: { kind: 'measured-distribution' as const, source: 'connect:venue-a:round-trip:2026-q2' },
};
const lake: BacktestLake = {
  wired: true,
  fills: () => [
    { ts: '2026-02-01T00:00:00.000Z', symbol: 'BTC-USD', qty: '0.01', price: '50000' },
    { ts: '2026-05-01T00:00:00.000Z', symbol: 'BTC-USD', qty: '0.02', price: '51000' },
  ],
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

function signed(userId: string, scopes: string[] = ['trade:read']) {
  const principal = {
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'basic' as const,
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } satisfies Parameters<typeof encodePrincipal>[0];
  const raw = encodePrincipal(principal);
  return edgeContext({
    headers: {
      'x-intafaced-region': 'DE',
      [EDGE_PRINCIPAL_HEADER]: raw,
      [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, SECRET, 'DE'),
    },
    id: `req-${userId}-${scopes.join(',')}`,
  });
}

describe('quant run records, detail, clone, claim, and the operator list', () => {
  const url = testDatabaseUrl();
  const sql = postgres(url, { max: 2, onnotice: () => undefined });
  const app = createQuantRouter({
    wired: true,
    venueVaultSet: false,
    limits,
    lake,
    strategies: createPostgresStrategyRepository(sql, SCHEMA),
    runs: createPostgresRunRepository(sql, SCHEMA, RUN_RESULT_MAX_BYTES),
  });
  const a = app.createCaller(signed(ACCOUNT_A));
  const b = app.createCaller(signed(ACCOUNT_B));
  const admin = app.createCaller(signed(ACCOUNT_B, ['admin:read']));

  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    for (const file of [
      'drizzle/0000_quant_strategies.sql',
      'drizzle/0001_quant_runs.sql',
      'drizzle/0003_quant_signal_rules.sql',
      'drizzle/0005_quant_run_labels.sql',
      'drizzle/20261030134631_quant_strategy_heads.sql',
      'drizzle/20261030142944_quant_release_notes.sql',
      'drizzle/20261031045011_quant_quotas.sql',
    ]) {
      const migration = readFileSync(join(SERVICE, file), 'utf8').replaceAll('"quant"', `"${SCHEMA}"`).replaceAll("'quant'", `'${SCHEMA}'`);
      await sql.unsafe(migration);
    }
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql.end({ timeout: 5 });
  });

  it('keeps one row per run, the computed detail, a suffixed clone, an unforgeable claim, and operator counts', async () => {
    const saved = await a.studio.save({
      name: 'alpha',
      blocks: [{ side: 'buy', symbol: 'BTC-USD', qty: '0.01' }],
      risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
      cash: '10000',
      environment: 'paper',
      clientStrategyId: 'client-alpha',
      idempotencyKey: 'idem-save',
    });

    const ran = await a.backtest.run({
      strategyId: saved.id,
      symbol: 'BTC-USD',
      walkForward,
      outOfSampleStatus: 'passed',
      costModel,
      strategyVariantCount: 1,
      environment: 'backtest',
      idempotencyKey: 'idem-backtest',
    });
    expect(ran.strategyVersion).toBe(1);
    // The quick start ticks from the stored rows: the owner has a strategy and an ok backtest; the other account nothing.
    expect(await a.quickStart()).toEqual({ strategy: true, backtest: true, paperRun: false });
    expect(await b.quickStart()).toEqual({ strategy: false, backtest: false, paperRun: false });
    const listedForOwner = await admin.ops.runs({ userId: ACCOUNT_A, kind: 'backtest', limit: 10 });
    const success = listedForOwner.runs.find((row) => row.outcome === 'ok');
    expect(success).toBeTruthy();
    const owned = await a.backtest.get({ runId: success!.id });
    expect(owned.equityCurve).toEqual([
      { ts: '2026-02-01T00:00:00.000Z', equity: '9500' },
      { ts: '2026-05-01T00:00:00.000Z', equity: '8480' },
    ]);
    expect(owned.trades).toEqual([
      { ts: '2026-02-01T00:00:00.000Z', symbol: 'BTC-USD', qty: '0.01', price: '50000' },
      { ts: '2026-05-01T00:00:00.000Z', symbol: 'BTC-USD', qty: '0.02', price: '51000' },
    ]);
    expect(owned.costs).toEqual({
      fees: { kind: 'venue-schedule', source: 'connect:venue-a:fee-schedule:v7' },
      slippage: { kind: 'order-book-replay', source: 'connect:data-lake:venue-a:depth:v3' },
      latency: { kind: 'measured-distribution', source: 'connect:venue-a:round-trip:2026-q2' },
    });
    expect(owned.pnl).toBe('-1520');
    expect(JSON.stringify(owned.costs)).not.toContain(':0');
    await expect(b.backtest.get({ runId: success!.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining(QUANT_RUN_NOT_FOUND),
    });

    await expect(
      a.backtest.run({
        strategyId: saved.id,
        symbol: 'BTC-USD',
        walkForward,
        outOfSampleStatus: 'passed',
        strategyVariantCount: 1,
        environment: 'backtest',
        idempotencyKey: 'idem-no-cost',
      }),
    ).rejects.toThrow(/missing_fee_model/);
    const afterRefusal = await admin.ops.runs({ userId: ACCOUNT_A, kind: 'backtest', limit: 10 });
    const refusedCost = afterRefusal.runs.find((row) => row.outcome === QUANT_BACKTEST_SURFACE_REFUSED);
    expect(refusedCost).toBeTruthy();
    const noCost = await a.backtest.get({ runId: refusedCost!.id });
    expect(noCost.costs).toBeNull();
    expect(noCost.equityCurve).toEqual(owned.equityCurve);
    expect(JSON.stringify(noCost)).not.toMatch(/"fees"\s*:\s*0/);

    const missingId = 'studio_00000000-0000-4000-8000-000000000099';
    await expect(
      b.backtest.run({
        strategyId: missingId,
        symbol: 'BTC-USD',
        walkForward,
        outOfSampleStatus: 'passed',
        costModel,
        strategyVariantCount: 1,
        environment: 'backtest',
        idempotencyKey: 'idem-missing',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining(QUANT_STUDIO_NOT_FOUND) });
    const missingReplay = await admin.ops.runs({ userId: ACCOUNT_B, limit: 10 });
    expect(missingReplay.runs.filter((row) => row.outcome === QUANT_STUDIO_NOT_FOUND)).toHaveLength(1);
    await expect(
      b.backtest.run({
        strategyId: missingId,
        symbol: 'ETH-USD',
        walkForward,
        outOfSampleStatus: 'passed',
        costModel,
        strategyVariantCount: 1,
        environment: 'backtest',
        idempotencyKey: 'idem-missing',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const missingAgain = await admin.ops.runs({ userId: ACCOUNT_B, limit: 10 });
    expect(missingAgain.runs.filter((row) => row.outcome === QUANT_STUDIO_NOT_FOUND)).toHaveLength(1);

    await a.sandbox.run({
      language: 'javascript',
      source: 'oms.buy("BTC-USD", "0.01");',
      cash: '10000',
      environment: 'paper',
      idempotencyKey: 'idem-sandbox',
    });
    const sandboxRows = await admin.ops.runs({ userId: ACCOUNT_A, kind: 'sandbox', limit: 10 });
    expect(sandboxRows.runs).toHaveLength(1);
    expect(sandboxRows.runs[0]?.outcome).toBe('ok');

    await expect(sql.unsafe(`UPDATE "${SCHEMA}".runs SET outcome_code = 'hacked' WHERE id = '${success!.id}'`)).rejects.toThrow(
      /immutable/,
    );
    const still = await a.backtest.get({ runId: success!.id });
    expect(still.outcome).toBe('ok');
    expect(still.pnl).toBe('-1520');

    const cloned = await a.studio.clone({
      strategyId: saved.id,
      clientStrategyId: 'client-copy',
      idempotencyKey: 'idem-clone',
    });
    expect(cloned.name).toBe('alpha copy');
    expect(cloned.version).toBe(1);
    expect(cloned.cash).toBe('10000');
    expect(cloned.blocks).toEqual(saved.blocks);
    const clonedAgain = await a.studio.clone({
      strategyId: saved.id,
      clientStrategyId: 'client-copy',
      idempotencyKey: 'idem-clone-replay',
    });
    expect(clonedAgain.id).toBe(cloned.id);
    expect(clonedAgain.version).toBe(1);
    await a.studio.update({
      id: cloned.id,
      name: 'alpha copy edited',
      blocks: cloned.blocks,
      risk: cloned.risk,
      cash: cloned.cash,
      environment: 'paper',
      idempotencyKey: 'idem-edit-clone',
    });
    const original = await a.studio.get({ id: saved.id });
    expect(original.name).toBe('alpha');
    expect(original.versions.map((row) => row.name)).toEqual(['alpha']);
    const edited = await a.studio.get({ id: cloned.id });
    expect(edited.name).toBe('alpha copy edited');
    expect(edited.versions[0]?.name).toBe('alpha copy');
    await expect(
      b.studio.clone({ strategyId: saved.id, clientStrategyId: 'foreign-copy', idempotencyKey: 'idem-foreign-clone' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await a.studio.delete({ id: saved.id, idempotencyKey: 'idem-delete' });
    await expect(
      a.studio.clone({ strategyId: saved.id, clientStrategyId: 'deleted-copy', idempotencyKey: 'idem-deleted-clone' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const claim = await a.marketplace.claim({ runId: success!.id, idempotencyKey: 'idem-claim' });
    expect(claim.pnl).toBe('-1520');
    expect(claim.live).toBe(false);
    expect(claim.simulated).toBe(true);
    expect(claim.environment).toBe('backtest');
    expect(claim.kind).toBe('simulated');
    const claimAgain = await a.marketplace.claim({ runId: success!.id, idempotencyKey: 'idem-claim-2' });
    expect(claimAgain.runId).toBe(claim.runId);
    expect(claimAgain.pnl).toBe(claim.pnl);
    const claimRows = await sql<{ id: string }[]>`SELECT id FROM ${sql(SCHEMA)}.claims WHERE run_id = ${success!.id}`;
    expect(claimRows).toHaveLength(1);
    await expect(b.marketplace.claim({ runId: success!.id, idempotencyKey: 'idem-foreign-claim' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(a.marketplace.claim({ runId: success!.id, pnl: '999', idempotencyKey: 'idem-forged' } as never)).rejects.toThrow(
      /pnl|Unrecognized/i,
    );

    const open = await createPostgresRunRepository(sql, SCHEMA, RUN_RESULT_MAX_BYTES).begin({
      userId: ACCOUNT_A,
      idempotencyKey: 'idem-open',
      kind: 'sandbox',
      strategyId: null,
      strategyVersion: null,
    });
    await expect(a.marketplace.claim({ runId: open.id, idempotencyKey: 'idem-open-claim' })).rejects.toMatchObject({
      message: expect.stringContaining(QUANT_RUN_UNFINISHED),
    });

    const page1 = await admin.ops.runs({ userId: ACCOUNT_A, limit: 1 });
    expect(page1.runs).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const seen = [page1.runs[0]!.id];
    let cursor = page1.nextCursor;
    while (cursor) {
      const page = await admin.ops.runs({ userId: ACCOUNT_A, limit: 1, cursor });
      if (page.runs[0]) seen.push(page.runs[0].id);
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    const onlyB = await admin.ops.runs({ userId: ACCOUNT_B, limit: 10 });
    expect(onlyB.runs.every((row) => row.userId === ACCOUNT_B)).toBe(true);
    expect(onlyB.runs.some((row) => row.userId === ACCOUNT_A)).toBe(false);

    const counts = await admin.ops.runCounts({ from: '2020-01-01T00:00:00.000Z', to: '2030-01-01T00:00:00.000Z' });
    const total = counts.byKind.backtest + counts.byKind.sandbox;
    const outcomeTotal = counts.byOutcome.reduce((sum, row) => sum + row.count, 0);
    expect(outcomeTotal).toBe(total);
    expect(counts.byKind.sandbox).toBeGreaterThanOrEqual(2);
    expect(counts.byKind.backtest).toBeGreaterThanOrEqual(3);
    expect(counts.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const packed = JSON.stringify({ page1, onlyB, counts });
    expect(packed).not.toContain('equity');
    expect(packed).not.toContain('50000');
    expect(packed).not.toContain('trades');

    await expect(a.ops.runs({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(a.ops.runCounts({ from: '2020-01-01T00:00:00.000Z', to: '2030-01-01T00:00:00.000Z' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(admin.ops.runs({})).rejects.toMatchObject({ message: expect.stringContaining('quant.ops_runs_limit_unset') });
    await expect(admin.ops.runCounts({})).rejects.toMatchObject({ message: expect.stringContaining('quant.ops_runs_from_unset') });
    await expect(
      app.createCaller(edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'anon' })).ops.runs({ limit: 10 }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('lists own backtests newest first with labels kept beside the write-once run, and refuses another account', async () => {
    const repo = createPostgresRunRepository(sql, SCHEMA, RUN_RESULT_MAX_BYTES);
    const begin = (key: string) =>
      repo.begin({ userId: ACCOUNT_A, idempotencyKey: key, kind: 'backtest', strategyId: 'strategy-h', strategyVersion: 2 });
    const older = await begin('algo:bt:history:1');
    await repo.finish({ id: older.id, userId: ACCOUNT_A, outcome: 'ok', stored: { detail: null, response: { n: 1 } } });
    // Runs are stamped to the millisecond: wait one, so the order is decided by time, not by a tie.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await begin('algo:bt:history:2');
    // A fills-language backtest (kind 'backtest' under a key the caller chose) has no bar result: it is not listed.
    const fills = await begin('backtest.run:history');
    const page = await repo.history({ userId: ACCOUNT_A, kind: 'backtest', keyPrefix: 'algo:bt:', limit: 50, cursor: null });
    const ids = page.runs.map((row) => row.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
    expect(ids).not.toContain(fills.id);
    // One strategy's runs only: a run of another strategy is left out.
    const other = await repo.begin({
      userId: ACCOUNT_A,
      idempotencyKey: 'algo:bt:history:other',
      kind: 'backtest',
      strategyId: 'strategy-other',
      strategyVersion: 1,
    });
    const page2 = await repo.history({
      userId: ACCOUNT_A,
      kind: 'backtest',
      keyPrefix: 'algo:bt:',
      limit: 50,
      cursor: null,
      strategyId: 'strategy-h',
    });
    expect(page2.runs.map((row) => row.id)).toEqual([newer.id, older.id]);
    expect(
      (
        await repo.history({
          userId: ACCOUNT_A,
          kind: 'backtest',
          keyPrefix: 'algo:bt:',
          limit: 50,
          cursor: null,
          strategyId: 'strategy-other',
        })
      ).runs.map((row) => row.id),
    ).toEqual([other.id]);

    expect(await repo.setLabel({ userId: ACCOUNT_A, runId: older.id, label: 'first' })).toEqual({ label: 'first' });
    expect(await repo.setLabel({ userId: ACCOUNT_A, runId: older.id, label: 'renamed' })).toEqual({ label: 'renamed' });
    const listed = (await repo.history({ userId: ACCOUNT_A, kind: 'backtest', keyPrefix: 'algo:bt:', limit: 50, cursor: null })).runs.find(
      (row) => row.id === older.id,
    );
    expect(listed).toMatchObject({ label: 'renamed', strategyVersion: 2, outcome: 'ok' });
    // The run itself is as stored: the label lives in its own table.
    expect((await repo.get({ userId: ACCOUNT_A, id: older.id }))?.response).toEqual({ n: 1 });

    await expect(repo.setLabel({ userId: ACCOUNT_B, runId: older.id, label: 'theirs' })).rejects.toThrow(/quant\.run_not_found/);
    expect(
      (await repo.history({ userId: ACCOUNT_B, kind: 'backtest', keyPrefix: 'algo:bt:', limit: 50, cursor: null })).runs.map(
        (row) => row.id,
      ),
    ).not.toContain(older.id);
    await expect(sql.unsafe(`INSERT INTO "${SCHEMA}"."run_labels" VALUES ($1, $2, '', now())`, [newer.id, ACCOUNT_A])).rejects.toThrow();
  });

  it('counts finished bar backtests of one strategy on one symbol and bar size as variants', async () => {
    const repo = createPostgresRunRepository(sql, SCHEMA, RUN_RESULT_MAX_BYTES);
    const done = async (key: string, response: unknown, outcome = 'ok') => {
      const row = await repo.begin({
        userId: ACCOUNT_A,
        idempotencyKey: key,
        kind: 'backtest',
        strategyId: 'strategy-v',
        strategyVersion: 1,
      });
      await repo.finish({ id: row.id, userId: ACCOUNT_A, outcome, stored: { detail: null, response } });
    };
    const bar = (symbol: string, barSize: string) => ({ symbol, coverage: { barSize } });
    await done('algo:bt:variant:1', bar('BTC/USDT', '1h'));
    await done('algo:bt:variant:2', bar('BTC/USDT', '1h'));
    await done('algo:bt:variant:3', bar('BTC/USDT', '5m'));
    await done('algo:bt:variant:4', bar('ETH/USDT', '1h'));
    await done('algo:bt:variant:5', bar('BTC/USDT', '1h'), 'quant.backtest_fills_missing');
    await done('backtest.run:variant', bar('BTC/USDT', '1h'));
    const count = (userId: string) =>
      repo.variantCount({ userId, strategyId: 'strategy-v', symbol: 'BTC/USDT', barSize: '1h', keyPrefix: 'algo:bt:' });
    expect(await count(ACCOUNT_A)).toBe(2);
    expect(await count(ACCOUNT_B)).toBe(0);
  });
});
