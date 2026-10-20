/**
 * D-instruments-01 operator funding desk, against real Postgres (TEST_DATABASE_URL).
 * Every figure is a TEST fixture.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestDatabase } from '@intafaced/db';
import { AuthError } from '@intafaced/auth';
import { MemoryApprovalBook, payloadHash } from './common.js';
import { FundingDesk } from './funding-desk.js';
import { tradeOpsAdminRouter } from './router.js';
import { TradeOpsAdmin } from './service.js';
import { principalFor } from '../spot/testing.js';
import { BLANK_FUNDING_PARAMS, type FundingParams } from '../futures/funding-params.js';
import { openFundingTestDb, truncateFundingTables } from '../futures/funding-engine.test-harness.js';

const MARKET = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const OP = '33333333-3333-4333-8333-333333333333';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const ALICE = '11111111-1111-4111-8111-111111111111';
const reader = () => principalFor(OP, ['admin:read']);
const writer = () => principalFor(OP, ['admin:read', 'admin:write']);
const customer = () => principalFor(ALICE, ['trade:read']);
const REASON = 'set the funding inputs';

/** TEST owner numbers. */
const PARAMS: FundingParams = {
  ...BLANK_FUNDING_PARAMS,
  baseComponent: '0.0001',
  cap: '0.05',
  cadenceSeconds: 60,
  trimRatioBps: 200,
  minSamples: 60,
};
const SOURCES = {
  sources: [
    { sourceId: 'src-a', weight: 1, enabled: true },
    { sourceId: 'src-b', weight: 2, enabled: false },
  ],
  params: { minSources: 1, outlierBandBps: 500, maxAgeSeconds: 30 },
};

describe('operator funding desk', () => {
  let db: TestDatabase;
  let book: MemoryApprovalBook;
  let desk: FundingDesk;

  beforeAll(async () => {
    db = await openFundingTestDb();
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 60_000);
  beforeEach(async () => {
    await truncateFundingTables(db);
    book = new MemoryApprovalBook();
    desk = new FundingDesk({ sql: db.sql, approvals: book });
  });

  function allow(approvalId: string, actionType: string, market: string, expectedVersion: string, change: unknown, reason = REASON): void {
    book.put({
      approvalId,
      actionType,
      targetService: 'svc-trade',
      targetId: market,
      expectedVersion,
      payloadHash: payloadHash({ actionType, market, change, expectedVersion, reason }),
      requesterId: OP,
      approverId: APPROVER,
    });
  }
  const setParams = (over: { approvalId?: string; expectedVersion?: string; clientRequestId?: string; params?: FundingParams } = {}) =>
    desk.paramsSet(writer(), {
      market: MARKET,
      params: over.params ?? PARAMS,
      expectedVersion: over.expectedVersion ?? '0',
      reason: REASON,
      approvalId: over.approvalId ?? 'ap-1',
      clientRequestId: over.clientRequestId ?? 'req-1',
    });

  it('reads blank by default: version 0, every number null, the blanks named', async () => {
    const view = await desk.paramsGet(reader(), MARKET);
    expect(view).toMatchObject({ marketId: MARKET, version: '0', params: BLANK_FUNDING_PARAMS });
    expect(view.missing).toEqual(['baseComponent', 'cap', 'cadenceSeconds', 'trimRatioBps', 'minSamples']);
    const sources = await desk.sourcesGet(reader(), MARKET);
    expect(sources).toMatchObject({ version: '0', config: { sources: [] } });
    expect(sources.missing).toEqual(['minSources', 'outlierBandBps', 'maxAgeSeconds']);
  });

  it('saves a version with approval, records operator and approver, audits it, and reads it back', async () => {
    allow('ap-1', 'trade.funding_params_set', MARKET, '0', PARAMS);
    const saved = await setParams();
    expect(saved).toMatchObject({ version: '1', params: PARAMS, operatorId: OP, approverId: APPROVER, approvalId: 'ap-1', reason: REASON });
    expect(saved.missing).toEqual([]);
    expect(saved.missingWindow).toEqual(['periodSeconds', 'periodAnchor']);
    expect(await desk.paramsGet(reader(), MARKET)).toMatchObject({ version: '1', params: PARAMS });
    const audit = await db.sql<Array<{ kind: string; approver_id: string | null }>>`
      SELECT kind, approver_id FROM trade.operator_audit WHERE kind LIKE 'funding_params.%' ORDER BY occurred_at, kind`;
    expect(audit.map((a) => a.kind).sort()).toEqual(['funding_params.get', 'funding_params.set']);
    expect(audit.find((a) => a.kind === 'funding_params.set')!.approver_id).toBe(APPROVER);
    // The other market is untouched.
    expect((await desk.paramsGet(reader(), OTHER)).version).toBe('0');
  });

  it('refuses a save without an approvalId, and keeps no version', async () => {
    await expect(setParams({ approvalId: '' })).rejects.toMatchObject({ code: 'approval_missing' });
    await expect(setParams({ approvalId: 'never-granted' })).rejects.toMatchObject({ code: 'approval_missing' });
    expect((await desk.paramsGet(reader(), MARKET)).version).toBe('0');
  });

  it('refuses an approval that is bound to different parameters, and one reused', async () => {
    allow('ap-other', 'trade.funding_params_set', MARKET, '0', { ...PARAMS, cap: '0.99' });
    await expect(setParams({ approvalId: 'ap-other' })).rejects.toMatchObject({ code: 'approval_mismatch' });
    allow('ap-1', 'trade.funding_params_set', MARKET, '0', PARAMS);
    await setParams();
    await expect(setParams({ approvalId: 'ap-1', clientRequestId: 'req-2', expectedVersion: '1' })).rejects.toMatchObject({
      code: 'approval_reused',
    });
  });

  it('refuses a stale expectedVersion and burns no approval', async () => {
    allow('ap-1', 'trade.funding_params_set', MARKET, '0', PARAMS);
    await setParams();
    allow('ap-stale', 'trade.funding_params_set', MARKET, '0', PARAMS);
    await expect(setParams({ approvalId: 'ap-stale', clientRequestId: 'req-stale', expectedVersion: '0' })).rejects.toMatchObject({
      code: 'funding_params_stale',
    });
    // The approval is still good at the right version.
    const next = { ...PARAMS, minSamples: 30 };
    allow('ap-2', 'trade.funding_params_set', MARKET, '1', next);
    expect(await setParams({ approvalId: 'ap-2', clientRequestId: 'req-3', expectedVersion: '1', params: next })).toMatchObject({
      version: '2',
      params: { minSamples: 30 },
    });
    const history = await db.sql<
      Array<{ version: string }>
    >`SELECT version::text FROM trade.funding_params WHERE market_id = ${MARKET} ORDER BY version`;
    expect(history.map((h) => h.version)).toEqual(['1', '2']);
  });

  it('two writers on the same version: one wins, the other is stale', async () => {
    allow('ap-a', 'trade.funding_params_set', MARKET, '0', PARAMS);
    const other = { ...PARAMS, cap: '0.04' };
    allow('ap-b', 'trade.funding_params_set', MARKET, '0', other);
    const results = await Promise.allSettled([
      setParams({ approvalId: 'ap-a', clientRequestId: 'req-a' }),
      setParams({ approvalId: 'ap-b', clientRequestId: 'req-b', params: other }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: 'funding_params_stale' });
    expect((await desk.paramsGet(reader(), MARKET)).version).toBe('1');
  });

  it('a repeated clientRequestId returns the first answer without a new version or a second approval', async () => {
    allow('ap-1', 'trade.funding_params_set', MARKET, '0', PARAMS);
    const first = await setParams();
    const replay = await setParams();
    expect(replay).toEqual(first);
    expect((await desk.paramsGet(reader(), MARKET)).version).toBe('1');
    // The same id for a different request is refused.
    await expect(setParams({ params: { ...PARAMS, cap: '0.04' } })).rejects.toMatchObject({ code: 'client_request_conflict' });
  });

  it('refuses a non-operator for every read and write', async () => {
    await expect(desk.paramsGet(customer(), MARKET)).rejects.toBeInstanceOf(AuthError);
    await expect(desk.sourcesGet(customer(), MARKET)).rejects.toBeInstanceOf(AuthError);
    await expect(desk.periods(customer(), { limit: 10, sampleLimit: 10 })).rejects.toBeInstanceOf(AuthError);
    allow('ap-1', 'trade.funding_params_set', MARKET, '0', PARAMS);
    await expect(
      desk.paramsSet(customer(), {
        market: MARKET,
        params: PARAMS,
        expectedVersion: '0',
        reason: REASON,
        approvalId: 'ap-1',
        clientRequestId: 'c1',
      }),
    ).rejects.toBeInstanceOf(AuthError);
    await expect(
      desk.sourcesSet(customer(), {
        market: MARKET,
        config: SOURCES,
        expectedVersion: '0',
        reason: REASON,
        approvalId: 'ap-1',
        clientRequestId: 'c2',
      }),
    ).rejects.toBeInstanceOf(AuthError);
    // A read-only operator can read but not write.
    await expect(
      desk.paramsSet(reader(), {
        market: MARKET,
        params: PARAMS,
        expectedVersion: '0',
        reason: REASON,
        approvalId: 'ap-1',
        clientRequestId: 'c3',
      }),
    ).rejects.toBeInstanceOf(AuthError);
    expect((await desk.paramsGet(reader(), MARKET)).version).toBe('0');
  });

  it('rejects values that are not exact, and a reason that is too short', async () => {
    await expect(setParams({ params: { ...PARAMS, cap: '1e-2' } })).rejects.toMatchObject({ code: 'funding_param_invalid' });
    await expect(setParams({ params: { ...PARAMS, trimRatioBps: 6000 } })).rejects.toMatchObject({ code: 'funding_param_invalid' });
    await expect(
      desk.paramsSet(writer(), {
        market: MARKET,
        params: PARAMS,
        expectedVersion: '0',
        reason: 'x',
        approvalId: 'ap-1',
        clientRequestId: 'r',
      }),
    ).rejects.toMatchObject({ code: 'reason_required' });
  });

  it('keeps a blank number blank when saved', async () => {
    const partial = { ...PARAMS, cap: null };
    allow('ap-1', 'trade.funding_params_set', MARKET, '0', partial);
    const saved = await setParams({ params: partial });
    expect(saved.params.cap).toBeNull();
    expect(saved.missing).toEqual(['cap']);
  });

  it('saves index sources with the same rules: approval, version, replay', async () => {
    await expect(
      desk.sourcesSet(writer(), {
        market: MARKET,
        config: SOURCES,
        expectedVersion: '0',
        reason: REASON,
        approvalId: '',
        clientRequestId: 'is-0',
      }),
    ).rejects.toMatchObject({ code: 'approval_missing' });
    allow('is-1', 'trade.index_sources_set', MARKET, '0', SOURCES);
    const input = {
      market: MARKET,
      config: SOURCES,
      expectedVersion: '0',
      reason: REASON,
      approvalId: 'is-1',
      clientRequestId: 'is-req-1',
    };
    const saved = await desk.sourcesSet(writer(), input);
    expect(saved).toMatchObject({ version: '1', config: SOURCES, operatorId: OP, approverId: APPROVER });
    expect(saved.missing).toEqual([]);
    expect(await desk.sourcesSet(writer(), input)).toEqual(saved);
    allow('is-2', 'trade.index_sources_set', MARKET, '0', SOURCES);
    await expect(desk.sourcesSet(writer(), { ...input, approvalId: 'is-2', clientRequestId: 'is-req-2' })).rejects.toMatchObject({
      code: 'index_sources_stale',
    });
    await expect(
      desk.sourcesSet(writer(), {
        ...input,
        expectedVersion: '1',
        clientRequestId: 'is-req-3',
        config: { ...SOURCES, sources: [SOURCES.sources[0]!, SOURCES.sources[0]!] },
      }),
    ).rejects.toMatchObject({ code: 'funding_param_invalid' });
  });

  it('reads recent computed and refused periods with their samples, newest first', async () => {
    const start = new Date('2026-10-20T00:00:00.000Z');
    await db.sql`INSERT INTO trade.funding_rate_samples (market_id, sampled_at, mark, index_price, gap_reason) VALUES
      (${MARKET}, ${start.toISOString()}, 101, 100, NULL),
      (${MARKET}, ${new Date(start.getTime() + 60_000).toISOString()}, NULL, 100, 'mark_unavailable'),
      (${MARKET}, ${new Date(start.getTime() + 120_000).toISOString()}, 99, 100, NULL)`;
    await db.sql`INSERT INTO trade.funding_rate_periods (period_id, market_id, period_start, period_end, status, code, message, rate, premium, inputs)
      VALUES (${`${MARKET}:${start.toISOString()}`}, ${MARKET}, ${start.toISOString()}, ${new Date(start.getTime() + 3_600_000).toISOString()},
              'refused', 'trade.funding_samples_insufficient', 'short', NULL, NULL, '{"validSamples":2}'::jsonb)`;
    const { periods } = await desk.periods(reader(), { market: MARKET, limit: 5, sampleLimit: 2 });
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ status: 'refused', code: 'trade.funding_samples_insufficient', rate: null, samplesTruncated: true });
    expect(periods[0]!.samples).toEqual([
      { sampledAt: '2026-10-20T00:00:00.000Z', mark: '101', index: '100', premium: '0.01', gapReason: null },
      // A gap has no premium: null, never zero.
      { sampledAt: '2026-10-20T00:01:00.000Z', mark: null, index: '100', premium: null, gapReason: 'mark_unavailable' },
    ]);
    await expect(desk.periods(reader(), { limit: 0, sampleLimit: 5 })).rejects.toMatchObject({ code: 'funding_periods_limit_unset' });
  });

  it('is reachable through the admin tRPC router as fundingParams, indexSources and fundingPeriods', async () => {
    const admin = new TradeOpsAdmin({
      sql: db.sql,
      approvals: book,
      ledger: null,
      reconcileOrder: async () => {
        throw new Error('unused');
      },
      cancelOrder: async () => {},
    });
    const caller = (principal: ReturnType<typeof writer>) => tradeOpsAdminRouter(admin).createCaller({ principal } as never);
    allow('ap-1', 'trade.funding_params_set', MARKET, '0', PARAMS);
    const saved = await caller(writer()).fundingParams.set({
      market: MARKET,
      params: PARAMS,
      expectedVersion: '0',
      reason: REASON,
      approvalId: 'ap-1',
      clientRequestId: 'trpc-1',
    });
    expect(saved.version).toBe('1');
    expect((await caller(writer()).fundingParams.get({ market: MARKET })).params).toEqual(PARAMS);
    expect((await caller(writer()).indexSources.get({ market: MARKET })).version).toBe('0');
    expect(await caller(writer()).fundingPeriods.recent({ market: MARKET, limit: 5, sampleLimit: 5 })).toEqual({ periods: [] });
    // Missing approvalId is refused by the wire contract itself.
    await expect(
      caller(writer()).fundingParams.set({
        market: MARKET,
        params: PARAMS,
        expectedVersion: '1',
        reason: REASON,
        approvalId: '',
        clientRequestId: 'trpc-2',
      }),
    ).rejects.toThrow();
    await expect(caller(writer()).fundingParams.get({ market: 'not-a-uuid' })).rejects.toThrow();
  });
});
