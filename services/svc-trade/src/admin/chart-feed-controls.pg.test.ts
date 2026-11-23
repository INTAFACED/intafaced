/**
 * J-charts-desk-19 #2 #3 #4 backend: each market's chart feed control, its journal and its export. Real Postgres via
 * TEST_DATABASE_URL. Every value here is a TEST value: the fallback list `test-backup` and the row limits.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import { TradeService } from '../controls/test-admission.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from '../spot/testing.js';
import { MemoryApprovalBook } from './common.js';
import {
  CHART_FEED_CONTROL_ACTION,
  CHART_FEED_DISABLED,
  CHART_FEED_EXPORT_LIMIT_UNSET,
  CHART_FEED_EXPORT_OVER_LIMIT,
  CHART_FEED_FALLBACK_UNSET,
  CHART_FEED_NOT_WRITTEN,
  ChartFeedControlsAdmin,
  chartFeedCandleGate,
  chartFeedPayloadHash,
  type ChartFeedAction,
  type ChartFeedOwnerValues,
} from './chart-feed-controls.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
if (!rawUrl) throw new Error('TEST_DATABASE_URL is unset; this suite does not start Docker');
const url = (() => {
  const parsed = new URL(rawUrl);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (name.endsWith('_test')) return rawUrl;
  parsed.pathname = '/intafaced_test';
  return parsed.toString();
})();

const PROPOSER = '33333333-3333-4333-8333-333333333333';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const writer = (id = PROPOSER) => principalFor(id, ['admin:read', 'admin:write']);
const reader = () => principalFor(PROPOSER, ['admin:read']);
const BTC = 'BTC/USDT';
const REASON = 'TEST: primary tape gap, switch the chart to the backup';
const TEST_OWNER: ChartFeedOwnerValues = { fallbackSources: ['test-backup'], exportRowLimit: 10 };

async function refusalCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('chart feed source and symbol control (C-ops-03 (b)(c))', () => {
  let db: TestDatabase;
  let book: MemoryApprovalBook;
  let now: Date;
  const desk = (owner: ChartFeedOwnerValues = TEST_OWNER) =>
    new ChartFeedControlsAdmin({ sql: db.sql, approvals: book, owner, now: () => now });

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url, migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE trade.operator_audit, trade.operator_requests, trade.chart_feed_controls, trade.chart_feed_state,
      trade.fills, trade.orders, trade.positions, trade.markets RESTART IDENTITY CASCADE`;
    const trade = new TradeService(db.sql, new MemoryLedger(), new StubMatching(), new StubPerks(), new MemoryEventBus('svc-trade'), {
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 150,
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
    });
    for (const symbol of [BTC, 'ETH/USDT']) {
      const [base, quote] = symbol.split('/') as [string, string];
      await trade.listMarket({
        symbol,
        baseAsset: base,
        quoteAsset: quote,
        tickSize: amt('0.01'),
        lotSize: amt('0.0001'),
        minQty: amt('0.0001'),
        maxQty: null,
        minNotional: amt('1'),
        makerBps: 10,
        takerBps: 20,
      });
    }
    book = new MemoryApprovalBook();
    now = new Date('2026-11-19T02:00:00.000Z');
  });

  afterEach(async () => {
    await db.sql`DROP TRIGGER IF EXISTS test_boom_audit ON trade.operator_audit`;
  });

  /** A second operator approved exactly this change (requester and approver given), bound to its hash. */
  function approve(
    approvalId: string,
    action: ChartFeedAction,
    expectedVersion: string,
    who = { requester: PROPOSER, approver: APPROVER },
  ) {
    book.put({
      approvalId,
      actionType: CHART_FEED_CONTROL_ACTION,
      targetService: 'svc-trade',
      targetId: BTC,
      expectedVersion,
      payloadHash: chartFeedPayloadHash({ symbol: BTC, action, expectedVersion, reason: REASON }),
      requesterId: who.requester,
      approverId: who.approver,
      operationId: `op-${approvalId}`,
    });
  }
  const apply = (approvalId: string, action: ChartFeedAction, expectedVersion: string, owner?: ChartFeedOwnerValues) =>
    desk(owner).apply(writer(), { symbol: BTC, action, expectedVersion, reason: REASON, approvalId, operationId: `op-${approvalId}` });
  const count = async (table: 'chart_feed_controls' | 'chart_feed_state') =>
    Number((await db.sql.unsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM trade.${table}`))[0]!.n);

  it('lists every market on its primary source, on, at version 0, with the owner values', async () => {
    const view = await desk().list(reader());
    expect(view.canWrite).toBe(false);
    expect(view.fallbackSources).toEqual(['test-backup']);
    expect(view.markets.map((m) => [m.symbol, m.source, m.state, m.version])).toEqual([
      [BTC, 'primary', 'on', '0'],
      ['ETH/USDT', 'primary', 'on', '0'],
    ]);
    expect(view.journal).toEqual([]);
  });

  it('prepare answers the hash a second operator approves, and writes nothing', async () => {
    const action = { kind: 'switch_source', to: 'test-backup' } as const;
    const p = await desk().prepare(writer(), { symbol: BTC, action, expectedVersion: '0', reason: REASON });
    expect(p.payloadHash).toBe(chartFeedPayloadHash({ symbol: BTC, action, expectedVersion: '0', reason: REASON }));
    expect(p.to).toEqual({ source: 'test-backup', state: 'on' });
    expect(await count('chart_feed_state')).toBe(0);
  });

  it('refuses a switch to a fallback while the owner list is blank, at prepare and at apply, and nothing changes', async () => {
    const action = { kind: 'switch_source', to: 'test-backup' } as const;
    const blank = { fallbackSources: null, exportRowLimit: 10 };
    expect(await refusalCode(desk(blank).prepare(writer(), { symbol: BTC, action, expectedVersion: '0', reason: REASON }))).toBe(
      CHART_FEED_FALLBACK_UNSET,
    );
    approve('ap-blank', action, '0');
    expect(await refusalCode(apply('ap-blank', action, '0', blank))).toBe(CHART_FEED_FALLBACK_UNSET);
    expect(await count('chart_feed_state')).toBe(0);
    expect(await count('chart_feed_controls')).toBe(0);
    // Refused before the approval was spent: it still applies once the list is set.
    await apply('ap-blank', action, '0');
  });

  it('refuses a change whose approver is its proposer, and one with no approval, and writes nothing', async () => {
    const action = { kind: 'disable' } as const;
    approve('ap-self', action, '0', { requester: PROPOSER, approver: PROPOSER });
    expect(await refusalCode(apply('ap-self', action, '0'))).toBe('approval_mismatch');
    expect(await refusalCode(apply('ap-none', action, '0'))).toBe('approval_missing');
    expect(await count('chart_feed_state')).toBe(0);
    expect(await count('chart_feed_controls')).toBe(0);
  });

  it('applies an approved switch: state, journal row and audit row with who proposed, approved and applied, and when', async () => {
    const action = { kind: 'switch_source', to: 'test-backup' } as const;
    approve('ap-1', action, '0');
    const applied = await apply('ap-1', action, '0');
    expect(applied.market).toMatchObject({ symbol: BTC, source: 'test-backup', state: 'on', version: '1' });
    expect(applied.control).toMatchObject({
      symbol: BTC,
      action: 'switch_source',
      fromSource: 'primary',
      toSource: 'test-backup',
      fromState: 'on',
      toState: 'on',
      version: '1',
      reason: REASON,
      proposerId: PROPOSER,
      approverId: APPROVER,
      executorId: PROPOSER,
      approvalId: 'ap-1',
      at: now.toISOString(),
    });
    const [audit] = await db.sql<Array<{ kind: string; object_id: string; approver_id: string; reason: string; operator_id: string }>>`
      SELECT kind, object_id, approver_id, reason, operator_id FROM trade.operator_audit WHERE kind = 'chart_feed.control'`;
    expect(audit).toMatchObject({ object_id: BTC, approver_id: APPROVER, reason: REASON, operator_id: PROPOSER });

    // A retry with the same approval writes nothing new and answers the same row; the approval cannot be reused.
    const again = await apply('ap-1', action, '0');
    expect(again.control.id).toBe(applied.control.id);
    expect(await count('chart_feed_controls')).toBe(1);

    // The list shows the source per market and the journal.
    const view = await desk().list(writer());
    expect(view.markets.find((m) => m.symbol === BTC)).toMatchObject({ source: 'test-backup', version: '1' });
    expect(view.journal.map((r) => r.approvalId)).toEqual(['ap-1']);
  });

  it('refuses the whole change when the audit row cannot be written: no state, no journal row', async () => {
    await db.sql.unsafe(
      `CREATE OR REPLACE FUNCTION trade.test_boom_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END; $$`,
    );
    await db.sql.unsafe(
      `CREATE TRIGGER test_boom_audit BEFORE INSERT ON trade.operator_audit FOR EACH ROW EXECUTE FUNCTION trade.test_boom_audit()`,
    );
    const action = { kind: 'disable' } as const;
    approve('ap-boom', action, '0');
    expect(await refusalCode(apply('ap-boom', action, '0'))).toBe(CHART_FEED_NOT_WRITTEN);
    expect(await count('chart_feed_state')).toBe(0);
    expect(await count('chart_feed_controls')).toBe(0);
    expect(await chartFeedCandleGate(db.sql)(BTC)).toEqual({ kind: 'serve', until: null });
  });

  it('a disabled chart feed refuses its candle read; delisted with history serves up to the delisting; enable restores', async () => {
    approve('ap-d', { kind: 'disable' }, '0');
    await apply('ap-d', { kind: 'disable' }, '0');
    expect(await chartFeedCandleGate(db.sql)(BTC)).toMatchObject({ kind: 'refuse', code: CHART_FEED_DISABLED });
    expect(await chartFeedCandleGate(db.sql)('ETH/USDT')).toEqual({ kind: 'serve', until: null });

    now = new Date('2026-11-19T03:00:00.000Z');
    approve('ap-x', { kind: 'delist_with_history' }, '1');
    await apply('ap-x', { kind: 'delist_with_history' }, '1');
    expect(await chartFeedCandleGate(db.sql)(BTC)).toEqual({ kind: 'serve', until: now });

    approve('ap-e', { kind: 'enable' }, '2');
    const back = await apply('ap-e', { kind: 'enable' }, '2');
    expect(back.market).toMatchObject({ state: 'on', delistedAt: null, version: '3' });
  });

  it('refuses a stale version before any approval is spent', async () => {
    approve('ap-old', { kind: 'disable' }, '1');
    expect(await refusalCode(apply('ap-old', { kind: 'disable' }, '1'))).toBe('trade.chart_feed.stale');
  });

  it('exports every change oldest first with who and when; over the row limit it refuses with the limit; blank limit refuses', async () => {
    const steps: Array<[string, ChartFeedAction, string]> = [
      ['ap-a', { kind: 'switch_source', to: 'test-backup' }, '0'],
      ['ap-b', { kind: 'switch_source', to: 'primary' }, '1'],
      ['ap-c', { kind: 'disable' }, '2'],
    ];
    for (const [id, action, v] of steps) {
      approve(id, action, v);
      await apply(id, action, v);
      now = new Date(now.getTime() + 60_000);
    }
    const file = await desk().export(reader(), {});
    expect(file.rows.map((r) => [r.approvalId, r.action, r.proposerId, r.approverId])).toEqual([
      ['ap-a', 'switch_source', PROPOSER, APPROVER],
      ['ap-b', 'switch_source', PROPOSER, APPROVER],
      ['ap-c', 'disable', PROPOSER, APPROVER],
    ]);
    expect(file.rows[0]!.at).toBe('2026-11-19T02:00:00.000Z');

    const tight = desk({ fallbackSources: ['test-backup'], exportRowLimit: 2 });
    try {
      await tight.export(reader(), {});
      expect.unreachable('an export over the row limit must refuse');
    } catch (error) {
      expect((error as { code?: string }).code).toBe(CHART_FEED_EXPORT_OVER_LIMIT);
      expect((error as Error).message).toContain('row limit of 2');
    }
    // A window under the limit still exports.
    expect((await tight.export(reader(), { from: '2026-11-19T02:01:00.000Z' })).rows).toHaveLength(2);
    expect(await refusalCode(desk({ fallbackSources: null, exportRowLimit: null }).export(reader(), {}))).toBe(
      CHART_FEED_EXPORT_LIMIT_UNSET,
    );
  });
});
