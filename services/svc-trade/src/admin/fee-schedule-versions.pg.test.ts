/**
 * Versioned owner fee schedule (SP-fees-vip-01 / SP-ops-02). Real Postgres via TEST_DATABASE_URL.
 * Two-person write, typed refusals that store nothing, and the version in force for an order placed earlier.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryApprovalBook, payloadHash } from './common.js';
import { TradeOpsAdmin } from './service.js';
import { feeScheduleAt, feeScheduleHistory } from '../spot/fee-schedule-store.js';
import { parseFeeScheduleJson, publishedProductBps } from '../spot/fee-schedule.js';
import { principalFor } from '../spot/testing.js';

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

const OP = '33333333-3333-4333-8333-333333333333';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const writer = () => principalFor(OP, ['admin:read', 'admin:write']);
const reader = () => principalFor(OP, ['admin:read']);
const NOW = new Date('2026-10-20T12:00:00.000Z');
const LATER = '2026-10-21T00:00:00.000Z';
const reason = 'publish the group schedule';

const BASE = parseFeeScheduleJson(JSON.stringify({ published: true, version: 'boot', makerBps: '10', takerBps: '20' }));
const row = (over: Record<string, unknown> = {}) => ({
  pairGroup: 'group-1',
  tierId: 'regular',
  zeroFee: false,
  makerBps: '8',
  takerBps: '16',
  minFee: null,
  ...over,
});
const proposal = (rows: unknown[] = [row()]) => ({ defaultPairGroup: 'group-1', rows });

describe('fee schedule versions (PG-hard)', () => {
  let db: TestDatabase;
  let book: MemoryApprovalBook;
  let admin: TradeOpsAdmin;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url, migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 60_000);
  beforeEach(async () => {
    await db.sql`TRUNCATE trade.fee_schedule_versions, trade.operator_audit RESTART IDENTITY CASCADE`;
    book = new MemoryApprovalBook();
    admin = new TradeOpsAdmin({
      sql: db.sql,
      approvals: book,
      ledger: null,
      reconcileOrder: async () => {
        throw new Error('unused');
      },
      cancelOrder: async () => undefined,
      now: () => NOW,
    });
  });

  function allow(approvalId: string, schedule: Record<string, unknown>, expectedVersion = '0', effectiveAt = LATER, requesterId = OP) {
    book.put({
      approvalId,
      actionType: 'trade.fee_schedule_set',
      targetService: 'svc-trade',
      targetId: 'spot-fee-schedule',
      expectedVersion,
      payloadHash: payloadHash({ actionType: 'trade.fee_schedule_set', schedule, effectiveAt, expectedVersion, reason }),
      requesterId,
      approverId: APPROVER,
    });
  }

  it('writes a version after a second operator approves, and an order placed before it keeps the old schedule', async () => {
    const schedule = proposal();
    allow('fee-1', schedule);
    const written = await admin.feeScheduleSet(writer(), {
      schedule,
      effectiveAt: LATER,
      expectedVersion: '0',
      reason,
      approvalId: 'fee-1',
    });
    expect(written).toMatchObject({ version: '1', approverId: APPROVER, operatorId: OP, effectiveAt: LATER });

    const placedBefore = new Date('2026-10-20T23:59:59.000Z');
    const placedAfter = new Date('2026-10-21T00:00:01.000Z');
    expect(await feeScheduleAt(db.sql, BASE, placedBefore)).toBe(BASE);
    const after = await feeScheduleAt(db.sql, BASE, placedAfter);
    expect(after.published === true && after.version).toBe('v1');
    expect(publishedProductBps(after, 'spot', { symbol: 'BTC/USDT' })).toEqual({ makerBps: 8, takerBps: 16 });
    expect(publishedProductBps(BASE, 'spot', { symbol: 'BTC/USDT' })).toEqual({ makerBps: 10, takerBps: 20 });
  });

  it('refuses a blank taker fee with the typed code and stores nothing', async () => {
    const schedule = proposal([row({ takerBps: undefined })]);
    allow('fee-blank', schedule);
    await expect(
      admin.feeScheduleSet(writer(), { schedule, effectiveAt: LATER, expectedVersion: '0', reason, approvalId: 'fee-blank' }),
    ).rejects.toMatchObject({ code: 'trade.fee_schedule_blank' });
    expect(await feeScheduleHistory(db.sql)).toEqual([]);
  });

  it('refuses an effective time in the past, a named version, a stale version and a missing approval', async () => {
    const schedule = proposal();
    allow('fee-past', schedule, '0', '2026-10-19T00:00:00.000Z');
    await expect(
      admin.feeScheduleSet(writer(), {
        schedule,
        effectiveAt: '2026-10-19T00:00:00.000Z',
        expectedVersion: '0',
        reason,
        approvalId: 'fee-past',
      }),
    ).rejects.toMatchObject({ code: 'fee_schedule_effective_in_past' });
    await expect(
      admin.feeScheduleSet(writer(), {
        schedule: { ...schedule, version: 'x' },
        effectiveAt: LATER,
        expectedVersion: '0',
        reason,
        approvalId: 'n',
      }),
    ).rejects.toMatchObject({ code: 'trade.fee_schedule_blank' });
    await expect(
      admin.feeScheduleSet(writer(), { schedule, effectiveAt: LATER, expectedVersion: '3', reason, approvalId: 'n' }),
    ).rejects.toMatchObject({ code: 'fee_schedule_stale' });
    await expect(
      admin.feeScheduleSet(writer(), { schedule, effectiveAt: LATER, expectedVersion: '0', reason, approvalId: 'none' }),
    ).rejects.toMatchObject({ code: 'approval_missing' });
    expect(await feeScheduleHistory(db.sql)).toEqual([]);
  });

  it('refuses when the proposer and approver are the same person', async () => {
    const schedule = proposal();
    book.put({
      approvalId: 'fee-same',
      actionType: 'trade.fee_schedule_set',
      targetService: 'svc-trade',
      targetId: 'spot-fee-schedule',
      expectedVersion: '0',
      payloadHash: payloadHash({ actionType: 'trade.fee_schedule_set', schedule, effectiveAt: LATER, expectedVersion: '0', reason }),
      requesterId: APPROVER,
      approverId: APPROVER,
    });
    await expect(
      admin.feeScheduleSet(writer(), { schedule, effectiveAt: LATER, expectedVersion: '0', reason, approvalId: 'fee-same' }),
    ).rejects.toMatchObject({ code: 'approval_mismatch' });
  });

  it('keeps every version, newest effective wins, and the row cannot be changed', async () => {
    const first = proposal();
    allow('fee-a', first);
    await admin.feeScheduleSet(writer(), { schedule: first, effectiveAt: LATER, expectedVersion: '0', reason, approvalId: 'fee-a' });
    const second = proposal([row({ makerBps: '6', takerBps: '12' })]);
    const later = '2026-10-22T00:00:00.000Z';
    allow('fee-b', second, '1', later);
    await admin.feeScheduleSet(writer(), { schedule: second, effectiveAt: later, expectedVersion: '1', reason, approvalId: 'fee-b' });

    const view = await admin.feeScheduleGet(reader());
    expect(view.version).toBe('2');
    expect(view.history.map((h) => h.version)).toEqual(['1', '2']);
    const mid = await feeScheduleAt(db.sql, BASE, new Date('2026-10-21T12:00:00.000Z'));
    expect(publishedProductBps(mid, 'spot', { symbol: 'BTC/USDT' })).toEqual({ makerBps: 8, takerBps: 16 });
    const end = await feeScheduleAt(db.sql, BASE, new Date('2026-10-22T12:00:00.000Z'));
    expect(publishedProductBps(end, 'spot', { symbol: 'BTC/USDT' })).toEqual({ makerBps: 6, takerBps: 12 });
    await expect(db.sql`UPDATE trade.fee_schedule_versions SET reason = 'edit'`).rejects.toThrow();
  });
});
