/**
 * C-ops-04 backend: the charts module owner values (LD-14). Real Postgres via TEST_DATABASE_URL.
 * Every value here is a TEST value. A count that was never set reads back as null, never a default.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import { AuthError } from '@intafaced/auth';
import { TradeService } from '../controls/test-admission.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from '../spot/testing.js';
import { MemoryApprovalBook, payloadHash, TradeOpsError } from './common.js';
import {
  ChartOwnerValuesAdmin,
  chartOwnerValuesPublicReader,
  type ChartOwnerValueSetInput,
  type ChartScalarKey,
} from './chart-owner-values.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
if (!rawUrl) throw new Error('TEST_DATABASE_URL is unset; this suite does not start Docker');
/** Same host and role as TEST_DATABASE_URL; assertTestDatabase wants an admin database ending in `_test`. */
const url = (() => {
  const parsed = new URL(rawUrl);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (name.endsWith('_test')) return rawUrl;
  parsed.pathname = '/intafaced_test';
  return parsed.toString();
})();

const OP = '33333333-3333-4333-8333-333333333333';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const operatorWriter = () => principalFor(OP, ['admin:read', 'admin:write']);
const supportReader = () => principalFor(OP, ['admin:read']);
const REASON = 'TEST: set the owner value for the charts pilot';

describe('charts module owner values (C-ops-04)', () => {
  let db: TestDatabase;
  let book: MemoryApprovalBook;
  let owner: ChartOwnerValuesAdmin;
  let now: Date;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE
      trade.operator_audit,
      trade.operator_requests,
      trade.chart_owner_values,
      trade.chart_data_class,
      trade.fills,
      trade.orders,
      trade.positions,
      trade.markets
      RESTART IDENTITY CASCADE`;
    const trade = new TradeService(db.sql, new MemoryLedger(), new StubMatching(), new StubPerks(), new MemoryEventBus('svc-trade'), {
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 150,
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
    });
    for (const symbol of ['BTC/USDT', 'ETH/USDT']) {
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
    now = new Date('2026-10-22T09:00:00.000Z');
    owner = new ChartOwnerValuesAdmin({ sql: db.sql, approvals: book, now: () => now });
  });

  afterEach(async () => {
    await db.sql`DROP TRIGGER IF EXISTS test_boom_audit ON trade.operator_audit`;
  });

  function scalar(key: ChartScalarKey, value: number | null, expectedVersion: string, clientRequestId: string): ChartOwnerValueSetInput {
    return { key, value, expectedVersion, reason: REASON, clientRequestId };
  }

  function allowDataClass(approvalId: string, symbol: string, dataClass: string | null, expectedVersion: string, reason = REASON): void {
    book.put({
      approvalId,
      actionType: 'trade.chart_data_class_set',
      targetService: 'svc-trade',
      targetId: symbol,
      expectedVersion,
      payloadHash: payloadHash({ actionType: 'trade.chart_data_class_set', symbol, dataClass, expectedVersion, reason }),
      requesterId: OP,
      approverId: APPROVER,
    });
  }

  async function auditRows(kind: string) {
    return db.sql<Array<{ kind: string; object_id: string; approver_id: string | null; reason: string; detail: Record<string, unknown> }>>`
      SELECT kind, object_id, approver_id, reason, detail FROM trade.operator_audit WHERE kind = ${kind}
       ORDER BY (detail->>'version')::bigint`;
  }

  it('reads blank: every count is not set, no version, every market has no data class', async () => {
    const view = await owner.get(operatorWriter());
    expect(view.scalars.version).toBeNull();
    expect(view.scalars.values).toEqual({
      compareCap: null,
      chartCountLimit: null,
      drawingCap: null,
      brushPointCap: null,
      delayedBoundarySeconds: null,
      renderBudgetMs: null,
    });
    expect(view.dataClasses.map((row) => row.symbol)).toEqual(['BTC/USDT', 'ETH/USDT']);
    expect(view.dataClasses.every((row) => row.dataClass === null && row.version === null)).toBe(true);
  });

  it('sets a count, versions it, and audits the old and new value with actor, reason and time', async () => {
    const after = await owner.set(operatorWriter(), scalar('compareCap', 3, '0', 'cro-1'));
    expect(after.scalars.version).toBe('1');
    expect(after.scalars.values.compareCap).toBe(3);
    expect(after.scalars.values.drawingCap).toBeNull();
    expect(after.scalars.operatorId).toBe(OP);
    expect(after.scalars.updatedAt).toBe(now.toISOString());

    const second = await owner.set(operatorWriter(), scalar('compareCap', 5, '1', 'cro-2'));
    expect(second.scalars.version).toBe('2');
    expect(second.scalars.values.compareCap).toBe(5);

    const rows = await auditRows('chart_owner_values.set');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ object_id: 'compareCap', approver_id: null, reason: REASON });
    expect(rows[0]!.detail).toMatchObject({ key: 'compareCap', oldValue: null, newValue: 3, version: '1' });
    expect(rows[1]!.detail).toMatchObject({ key: 'compareCap', oldValue: 3, newValue: 5, version: '2' });
  });

  it('clears a count back to not set (fail closed: the audit shows the old value and the blank new one)', async () => {
    await owner.set(operatorWriter(), scalar('chartCountLimit', 4, '0', 'cro-a'));
    const cleared = await owner.set(operatorWriter(), scalar('chartCountLimit', null, '1', 'cro-b'));
    expect(cleared.scalars.values.chartCountLimit).toBeNull();
    const rows = await auditRows('chart_owner_values.set');
    expect(rows[1]!.detail).toMatchObject({ key: 'chartCountLimit', oldValue: 4, newValue: null });
  });

  it('is idempotent on clientRequestId: the same write returns the stored result and writes once', async () => {
    const first = await owner.set(operatorWriter(), scalar('drawingCap', 50, '0', 'cro-same'));
    const replay = await owner.set(operatorWriter(), scalar('drawingCap', 50, '0', 'cro-same'));
    expect(replay).toEqual(first);
    const [count] = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.chart_owner_values`;
    expect(count?.n).toBe('1');
  });

  it('refuses a reused clientRequestId for a different write', async () => {
    await owner.set(operatorWriter(), scalar('drawingCap', 50, '0', 'cro-reuse'));
    await expect(owner.set(operatorWriter(), scalar('drawingCap', 60, '0', 'cro-reuse'))).rejects.toMatchObject({
      code: 'client_request_conflict',
    });
  });

  it('reads the newest version after ten or more writes (versions compare as numbers, not text)', async () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    for (const [index, value] of values.entries()) {
      await owner.set(operatorWriter(), scalar('compareCap', value, String(index), `cro-many-${index}`));
    }
    const view = await owner.get(operatorWriter());
    expect(view.scalars.version).toBe('12');
    expect(view.scalars.values.compareCap).toBe(12);
    // Version 10 (not 9) is the next expected version: a text sort would have made 9 the newest and refused this.
    const next = await owner.set(operatorWriter(), scalar('compareCap', 1, '12', 'cro-many-next'));
    expect(next.scalars.version).toBe('13');
    const publicValues = await chartOwnerValuesPublicReader(db.sql).scalars();
    expect(publicValues.compareCap).toBe(1);
  });

  it('a reused clientRequestId with a different reason is refused as a conflict', async () => {
    await owner.set(operatorWriter(), scalar('drawingCap', 50, '0', 'cro-reason'));
    await expect(
      owner.set(operatorWriter(), {
        key: 'drawingCap',
        value: 50,
        expectedVersion: '0',
        reason: 'TEST: a different reason for the same write',
        clientRequestId: 'cro-reason',
      }),
    ).rejects.toMatchObject({ code: 'client_request_conflict' });
    const [count] = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.chart_owner_values`;
    expect(count?.n).toBe('1');
  });

  it('a concurrent duplicate of the same write replays the stored result and writes once', async () => {
    const input = scalar('chartCountLimit', 8, '0', 'cro-race');
    const [a, b] = await Promise.all([owner.set(operatorWriter(), input), owner.set(operatorWriter(), input)]);
    expect(b).toEqual(a);
    expect(a.scalars.version).toBe('1');
    const [count] = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.chart_owner_values`;
    expect(count?.n).toBe('1');
  });

  it('a data class write that fails after its approval is consumed says the approval is spent, and a retry needs a new one', async () => {
    allowDataClass('appr-spent', 'ETH/USDT', 'delayed', '0');
    await db.sql.unsafe(
      `CREATE OR REPLACE FUNCTION trade.test_boom_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END; $$`,
    );
    await db.sql.unsafe(
      `CREATE TRIGGER test_boom_audit BEFORE INSERT ON trade.operator_audit FOR EACH ROW EXECUTE FUNCTION trade.test_boom_audit()`,
    );
    const failed = owner.set(operatorWriter(), {
      key: 'dataClass',
      symbol: 'ETH/USDT',
      value: 'delayed',
      expectedVersion: '0',
      reason: REASON,
      approvalId: 'appr-spent',
      clientRequestId: 'cdc-spent-1',
    });
    await expect(failed).rejects.toMatchObject({ code: 'chart_owner_values_not_written' });
    await expect(failed).rejects.toThrow(/approval was spent.*new approval is needed/);
    await db.sql`DROP TRIGGER test_boom_audit ON trade.operator_audit`;

    await expect(
      owner.set(operatorWriter(), {
        key: 'dataClass',
        symbol: 'ETH/USDT',
        value: 'delayed',
        expectedVersion: '0',
        reason: REASON,
        approvalId: 'appr-spent',
        clientRequestId: 'cdc-spent-2',
      }),
    ).rejects.toMatchObject({ code: 'approval_reused' });
  });

  it('refuses a stale expectedVersion and changes nothing', async () => {
    await owner.set(operatorWriter(), scalar('brushPointCap', 2000, '0', 'cro-v1'));
    await expect(owner.set(operatorWriter(), scalar('brushPointCap', 3000, '0', 'cro-v0'))).rejects.toMatchObject({
      code: 'chart_owner_values_stale',
    });
    const view = await owner.get(operatorWriter());
    expect(view.scalars.values.brushPointCap).toBe(2000);
  });

  it('refuses a write with no reason, and a count outside its bound, before anything is stored', async () => {
    await expect(
      owner.set(operatorWriter(), { key: 'compareCap', value: 3, expectedVersion: '0', reason: '  ', clientRequestId: 'cro-r' }),
    ).rejects.toMatchObject({ code: 'reason_required' });
    await expect(owner.set(operatorWriter(), scalar('compareCap', 51, '0', 'cro-big'))).rejects.toMatchObject({
      code: 'chart_owner_value_invalid',
    });
    await expect(owner.set(operatorWriter(), scalar('compareCap', 0, '0', 'cro-zero'))).rejects.toMatchObject({
      code: 'chart_owner_value_invalid',
    });
    const [count] = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.chart_owner_values`;
    expect(count?.n).toBe('0');
  });

  it('a support reader (admin:read only) reads and cannot write', async () => {
    await expect(owner.get(supportReader())).resolves.toMatchObject({ canWrite: false, scalars: { version: null } });
    await expect(owner.get(operatorWriter())).resolves.toMatchObject({ canWrite: true });
    await expect(owner.set(supportReader(), scalar('compareCap', 3, '0', 'cro-support'))).rejects.toBeInstanceOf(AuthError);
    const [count] = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.chart_owner_values`;
    expect(count?.n).toBe('0');
  });

  it('refuses the whole change when the audit row cannot be written, and the same request succeeds once the audit path works', async () => {
    await db.sql.unsafe(
      `CREATE OR REPLACE FUNCTION trade.test_boom_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END; $$`,
    );
    await db.sql.unsafe(
      `CREATE TRIGGER test_boom_audit BEFORE INSERT ON trade.operator_audit FOR EACH ROW EXECUTE FUNCTION trade.test_boom_audit()`,
    );
    const refused = owner.set(operatorWriter(), scalar('delayedBoundarySeconds', 30, '0', 'cro-audit'));
    await expect(refused).rejects.toMatchObject({ code: 'chart_owner_values_not_written' });
    const [count] = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.chart_owner_values`;
    expect(count?.n).toBe('0');
    const [stored] = await db.sql<
      Array<{ n: string }>
    >`SELECT count(*)::text AS n FROM trade.operator_requests WHERE client_request_id = 'cro-audit'`;
    expect(stored?.n).toBe('0');

    await db.sql`DROP TRIGGER test_boom_audit ON trade.operator_audit`;
    const ok = await owner.set(operatorWriter(), scalar('delayedBoundarySeconds', 30, '0', 'cro-audit'));
    expect(ok.scalars.values.delayedBoundarySeconds).toBe(30);
  });

  it('a data class write needs a second operator: no approval means nothing changes', async () => {
    await expect(
      owner.set(operatorWriter(), {
        key: 'dataClass',
        symbol: 'BTC/USDT',
        value: 'real_time',
        expectedVersion: '0',
        reason: REASON,
        approvalId: 'appr-missing',
        clientRequestId: 'cdc-missing',
      }),
    ).rejects.toMatchObject({ code: 'approval_missing' });
    const view = await owner.get(operatorWriter());
    expect(view.dataClasses.find((row) => row.symbol === 'BTC/USDT')?.dataClass).toBeNull();
  });

  it("a data class write with a second operator's approval is stored and audited with the approver", async () => {
    allowDataClass('appr-btc-1', 'BTC/USDT', 'real_time', '0');
    const view = await owner.set(operatorWriter(), {
      key: 'dataClass',
      symbol: 'BTC/USDT',
      value: 'real_time',
      expectedVersion: '0',
      reason: REASON,
      approvalId: 'appr-btc-1',
      clientRequestId: 'cdc-btc-1',
    });
    const btc = view.dataClasses.find((row) => row.symbol === 'BTC/USDT');
    expect(btc).toMatchObject({ dataClass: 'real_time', version: '1', operatorId: OP, approverId: APPROVER });
    expect(view.dataClasses.find((row) => row.symbol === 'ETH/USDT')?.dataClass).toBeNull();

    const rows = await auditRows('chart_data_class.set');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ object_id: 'BTC/USDT', approver_id: APPROVER, reason: REASON });
    expect(rows[0]!.detail).toMatchObject({ symbol: 'BTC/USDT', oldValue: null, newValue: 'real_time', version: '1' });
  });

  it('a data class approval is single use, and a stale data class version refuses', async () => {
    allowDataClass('appr-once', 'BTC/USDT', 'delayed', '0');
    await owner.set(operatorWriter(), {
      key: 'dataClass',
      symbol: 'BTC/USDT',
      value: 'delayed',
      expectedVersion: '0',
      reason: REASON,
      approvalId: 'appr-once',
      clientRequestId: 'cdc-once',
    });
    await expect(
      owner.set(operatorWriter(), {
        key: 'dataClass',
        symbol: 'BTC/USDT',
        value: 'delayed',
        expectedVersion: '1',
        reason: REASON,
        approvalId: 'appr-once',
        clientRequestId: 'cdc-once-2',
      }),
    ).rejects.toMatchObject({ code: 'approval_reused' });

    allowDataClass('appr-stale', 'BTC/USDT', 'end_of_day', '0');
    await expect(
      owner.set(operatorWriter(), {
        key: 'dataClass',
        symbol: 'BTC/USDT',
        value: 'end_of_day',
        expectedVersion: '0',
        reason: REASON,
        approvalId: 'appr-stale',
        clientRequestId: 'cdc-stale',
      }),
    ).rejects.toMatchObject({ code: 'chart_owner_values_stale' });
  });

  it('refuses a data class approval that the same operator asked for (four-eyes)', async () => {
    book.put({
      approvalId: 'appr-self',
      actionType: 'trade.chart_data_class_set',
      targetService: 'svc-trade',
      targetId: 'BTC/USDT',
      expectedVersion: '0',
      payloadHash: payloadHash({
        actionType: 'trade.chart_data_class_set',
        symbol: 'BTC/USDT',
        dataClass: 'real_time',
        expectedVersion: '0',
        reason: REASON,
      }),
      requesterId: OP,
      approverId: OP,
    });
    await expect(
      owner.set(operatorWriter(), {
        key: 'dataClass',
        symbol: 'BTC/USDT',
        value: 'real_time',
        expectedVersion: '0',
        reason: REASON,
        approvalId: 'appr-self',
        clientRequestId: 'cdc-self',
      }),
    ).rejects.toMatchObject({ code: 'approval_mismatch' });
  });

  it('refuses a data class for a market that is not listed', async () => {
    allowDataClass('appr-nope', 'NOPE/USDT', 'real_time', '0');
    await expect(
      owner.set(operatorWriter(), {
        key: 'dataClass',
        symbol: 'NOPE/USDT',
        value: 'real_time',
        expectedVersion: '0',
        reason: REASON,
        approvalId: 'appr-nope',
        clientRequestId: 'cdc-nope',
      }),
    ).rejects.toBeInstanceOf(TradeOpsError);
  });

  it('a support reader cannot set a data class even with an approval', async () => {
    allowDataClass('appr-support', 'BTC/USDT', 'real_time', '0');
    await expect(
      owner.set(supportReader(), {
        key: 'dataClass',
        symbol: 'BTC/USDT',
        value: 'real_time',
        expectedVersion: '0',
        reason: REASON,
        approvalId: 'appr-support',
        clientRequestId: 'cdc-support',
      }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('the public reader returns the owner values, and the data class for a symbol only', async () => {
    const reader = chartOwnerValuesPublicReader(db.sql);
    expect(await reader.scalars()).toEqual({
      compareCap: null,
      chartCountLimit: null,
      drawingCap: null,
      brushPointCap: null,
      delayedBoundarySeconds: null,
      renderBudgetMs: null,
    });
    expect(await reader.dataClassFor('BTC/USDT')).toBeNull();

    await owner.set(operatorWriter(), scalar('compareCap', 3, '0', 'cro-pub'));
    allowDataClass('appr-pub', 'BTC/USDT', 'real_time', '0');
    await owner.set(operatorWriter(), {
      key: 'dataClass',
      symbol: 'BTC/USDT',
      value: 'real_time',
      expectedVersion: '0',
      reason: REASON,
      approvalId: 'appr-pub',
      clientRequestId: 'cdc-pub',
    });
    expect((await reader.scalars()).compareCap).toBe(3);
    expect(await reader.dataClassFor('BTC/USDT')).toBe('real_time');
    expect(await reader.dataClassFor('ETH/USDT')).toBeNull();
  });
});
