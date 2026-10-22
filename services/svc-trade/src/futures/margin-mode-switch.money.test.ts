/**
 * CARD F2 money proof — margin mode switch refuses (PTX-M08-R02 / R08).
 *
 * Hitch (`checkMarginModeSwitch`) is already on origin/main `margin-mode.ts`.
 * This file does not recut `router.ts`, `trade-service.ts`, `position-service.ts`,
 * `types.ts`, or `ccxt-errors.ts`. POST /positions/margin-mode stays 501 — no
 * live switch product. Mill audits refused attempts. Isolated rows are not
 * one cross book. Owner IM / haircuts stay unset.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { MemoryLedger } from '@intafaced/ledger-client';
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import {
  CROSS_MARGIN_UNSUPPORTED,
  MARGIN_MODE_INELIGIBLE,
  MARGIN_MODE_SWITCH_REQUIRES_PREVIEW,
  attemptMarginModeSwitch,
  checkMarginModeSwitch,
  memoryMarginModeSwitchAudit,
  readIsolatedMarginAggregation,
  sqlMarginModeSwitchAudit,
} from './margin-mode.js';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-08-06T12:00:00.000Z');
const MARKET_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MARKET_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('margin-mode switch refuse hitch (source)', () => {
  it('router.ts has no margin-mode recut', () => {
    const routerSrc = readFileSync(join(here, '..', 'router.ts'), 'utf8');
    expect(routerSrc).not.toMatch(/margin-mode/);
    expect(routerSrc).not.toMatch(/checkMarginModeSwitch/);
    expect(routerSrc).not.toMatch(/attemptMarginModeSwitch/);
    expect(routerSrc).not.toMatch(/readIsolatedMarginAggregation/);
  });

  it('POST /positions/margin-mode stays 501 — no live switch product', () => {
    const privateRest = readFileSync(join(here, '..', 'private-rest.ts'), 'utf8');
    expect(privateRest).toMatch(/app\.post\('\/api\/v1\/positions\/margin-mode'/);
    expect(privateRest).toMatch(/setMarginModeArm\.httpStatus !== 501/);
    const arm = privateRest.slice(privateRest.indexOf('const setMarginModeArm'));
    const post = privateRest.indexOf("app.post('/api/v1/positions/margin-mode'");
    expect(privateRest.indexOf('const setMarginModeArm')).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(-1);
    expect(arm.indexOf('derivativesNotSupported')).toBeGreaterThan(-1);
    expect(privateRest.slice(post, post + 180)).toMatch(/derivativesNotSupported\('setMarginMode'/);
  });

  it('mill attempt is check-then-audit — no ledger post, no margin_mode rewrite', () => {
    const mill = readFileSync(join(here, 'margin-mode.ts'), 'utf8');
    expect(mill).toMatch(/export async function attemptMarginModeSwitch/);
    expect(mill).toMatch(/export async function auditSwitchAttempt/);
    expect(mill).toMatch(/export function readIsolatedMarginAggregation/);
    const attemptStart = mill.indexOf('export async function attemptMarginModeSwitch');
    const attempt = mill.slice(attemptStart, mill.indexOf('export interface IsolatedPositionMarginRow'));
    expect(attempt).toMatch(/checkMarginModeSwitch\(input\)/);
    expect(attempt).toMatch(/auditSwitchAttempt\(audit/);
    expect(attempt.indexOf('checkMarginModeSwitch')).toBeLessThan(attempt.indexOf('auditSwitchAttempt'));
    expect(mill).not.toMatch(/recipes\./);
    expect(mill).not.toMatch(/futuresMarginLock/);
    expect(mill).not.toMatch(/UPDATE\s+trade\.positions/i);
    expect(mill).not.toMatch(/SET\s+margin_mode/i);
  });

  it('listOpen / presentOpenPositions do not net isolated IM as a cross book', () => {
    const src = readFileSync(join(here, 'position-service.ts'), 'utf8');
    const listOpen = src.slice(src.indexOf('async listOpen'), src.indexOf('async listClosed'));
    expect(listOpen).toMatch(/rows\.map\(\(row\) => presentPosition\(row\)\)/);
    expect(listOpen).not.toMatch(/reduce\s*\(/);
    expect(listOpen).not.toMatch(/sharedInitialMargin/);
    const rest = readFileSync(join(here, '..', 'private-rest.ts'), 'utf8');
    const present = rest.slice(rest.indexOf('export function presentOpenPositions'), rest.indexOf('export function suppliedPriceFields'));
    expect(present).toMatch(/rows\.map\(\(row\) => \(\{ \.\.\.row, markSource: null \}\)/);
    expect(present).not.toMatch(/reduce\s*\(/);
    expect(present).not.toMatch(/sharedInitialMargin/);
  });

  it('owner numbers not invented — no new bps/haircut constants copied into jobs/index', () => {
    const mill = readFileSync(join(here, 'margin-mode.ts'), 'utf8');
    expect(mill).not.toMatch(/haircut\s*[:=]/i);
    expect(mill).not.toMatch(/\b\d+\s*bps\b/i);
    const jobs = readFileSync(join(here, 'futures-jobs.ts'), 'utf8');
    expect(jobs).not.toMatch(/checkMarginModeSwitch|attemptMarginModeSwitch|readIsolatedMarginAggregation/);
    const index = readFileSync(join(here, '..', 'index.ts'), 'utf8');
    expect(index).not.toMatch(/checkMarginModeSwitch|attemptMarginModeSwitch|MARGIN_HAIRCUT|haircutBps/);
  });
});

describe('margin-mode switch mill (hermetic)', () => {
  it('switch isolated→cross with open risk and no preview refuses; audit; zero ledger posts', async () => {
    const ledger = new MemoryLedger();
    const audit = memoryMarginModeSwitchAudit();
    const before = ledger.journal().length;
    const check = await attemptMarginModeSwitch(
      {
        from: 'isolated',
        to: 'cross',
        hasOpenRisk: true,
        eligible: true,
        migrationPreviewId: null,
        now: NOW,
        positionId: 'pos-open-risk',
        userId: ALICE,
      },
      audit,
    );
    expect(check).toMatchObject({ ok: false, code: MARGIN_MODE_SWITCH_REQUIRES_PREVIEW });
    expect(checkMarginModeSwitch({ from: 'isolated', to: 'cross', hasOpenRisk: true, eligible: true })).toMatchObject({
      ok: false,
      code: MARGIN_MODE_SWITCH_REQUIRES_PREVIEW,
    });
    const rows = await audit.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'refused',
      code: MARGIN_MODE_SWITCH_REQUIRES_PREVIEW,
      fromMode: 'isolated',
      toMode: 'cross',
      hasOpenRisk: true,
      eligible: true,
      positionId: 'pos-open-risk',
      userId: ALICE,
    });
    expect(ledger.journal()).toHaveLength(before);
    expect(ledger.journal().every((tx) => tx.reason !== 'futures.margin.lock')).toBe(true);
  });

  it('switch without eligible refuses trade.margin_mode_ineligible and still audits', async () => {
    const audit = memoryMarginModeSwitchAudit();
    const check = await attemptMarginModeSwitch(
      {
        from: 'isolated',
        to: 'portfolio',
        hasOpenRisk: false,
        eligible: false,
        migrationPreviewId: 'preview-1',
        now: NOW,
      },
      audit,
    );
    expect(check).toMatchObject({ ok: false, code: MARGIN_MODE_INELIGIBLE });
    const rows = await audit.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'refused', code: MARGIN_MODE_INELIGIBLE, fromMode: 'isolated', toMode: 'portfolio' });
  });

  it('two isolated positions: aggregate read does not report cross / shared IM (PTX-M08-R08)', () => {
    const agg = readIsolatedMarginAggregation([
      { id: 'pos-a', marginMode: 'isolated', initialMargin: '10000' },
      { id: 'pos-b', marginMode: 'isolated', initialMargin: '25000' },
    ]);
    expect(agg).toEqual({
      ok: true,
      book: 'isolated',
      crossBook: false,
      sharedInitialMargin: null,
      positions: [
        { id: 'pos-a', marginMode: 'isolated', initialMargin: '10000' },
        { id: 'pos-b', marginMode: 'isolated', initialMargin: '25000' },
      ],
    });
    expect(JSON.stringify(agg)).not.toMatch(/35000/);
    expect(agg.ok && 'totalInitialMargin' in agg).toBe(false);
    expect(readIsolatedMarginAggregation([{ id: 'pos-x', marginMode: 'cross', initialMargin: '10000' }])).toMatchObject({
      ok: false,
      code: CROSS_MARGIN_UNSUPPORTED,
    });
  });
});

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('svc-trade margin-mode switch F2 money (Postgres unavailable — start docker compose)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'trade', url: URL, migrations });
  const sql = db.sql;

  describe('svc-trade margin-mode switch F2 money', () => {
    beforeEach(async () => {
      await sql`TRUNCATE trade.positions, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
      await sql`DROP TABLE IF EXISTS trade.margin_mode_switch_audit`;
      await sql`
        INSERT INTO trade.markets (
          id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
          maker_bps, taker_bps, status, display_name, listed_at
        ) VALUES
          (${MARKET_A}, 'BTC/USDT-PERP', 'BTC', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'BTC perpetual', now()),
          (${MARKET_B}, 'ETH/USDT-PERP', 'ETH', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'ETH perpetual', now())
      `;
    });

    afterAll(async () => {
      await db.drop();
    }, 30_000);

    it('refused isolated→cross with open risk is SQL-audited; margin_mode not rewritten; zero ledger posts', async () => {
      const inserted = await sql<{ id: string; margin_mode: string }[]>`
        INSERT INTO trade.positions (
          user_id, market_id, side, margin_mode, status,
          size, entry_price, leverage, margin_initial, margin_current, margin_asset, opened_at
        ) VALUES (
          ${ALICE}, ${MARKET_A}, 'long', 'isolated', 'open',
          '1', '50000', 5, '10000', '10000', 'USDT', ${NOW}
        )
        RETURNING id, margin_mode
      `;
      expect(inserted).toHaveLength(1);
      const positionId = inserted[0]!.id;
      const ledger = new MemoryLedger();
      const before = ledger.journal().length;
      const audit = sqlMarginModeSwitchAudit(sql);
      const check = await attemptMarginModeSwitch(
        {
          from: 'isolated',
          to: 'cross',
          hasOpenRisk: true,
          eligible: true,
          migrationPreviewId: null,
          now: NOW,
          positionId,
          userId: ALICE,
        },
        audit,
      );
      expect(check).toMatchObject({ ok: false, code: MARGIN_MODE_SWITCH_REQUIRES_PREVIEW });
      const rows = await audit.list();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        outcome: 'refused',
        code: MARGIN_MODE_SWITCH_REQUIRES_PREVIEW,
        fromMode: 'isolated',
        toMode: 'cross',
        positionId,
        userId: ALICE,
      });
      const after = await sql<{ id: string; margin_mode: string }[]>`
        SELECT id, margin_mode FROM trade.positions WHERE id = ${positionId}
      `;
      expect(after[0]!.margin_mode).toBe('isolated');
      expect(ledger.journal()).toHaveLength(before);
      expect(ledger.journal().filter((tx) => tx.reason === 'futures.margin.lock')).toHaveLength(0);
    });

    it('two isolated SQL rows do not aggregate as one cross book / shared IM', async () => {
      await sql`
        INSERT INTO trade.positions (
          user_id, market_id, side, margin_mode, status,
          size, entry_price, leverage, margin_initial, margin_current, margin_asset, opened_at
        ) VALUES
          (${ALICE}, ${MARKET_A}, 'long', 'isolated', 'open', '1', '50000', 5, '10000', '10000', 'USDT', ${NOW}),
          (${ALICE}, ${MARKET_B}, 'long', 'isolated', 'open', '2', '3000', 5, '25000', '25000', 'USDT', ${NOW})
      `;
      const rows = await sql<{ id: string; margin_mode: string; margin_initial: string }[]>`
        SELECT id, margin_mode, margin_initial::text AS margin_initial
        FROM trade.positions
        WHERE user_id = ${ALICE} AND status = 'open'
        ORDER BY market_id ASC
      `;
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.margin_mode === 'isolated')).toBe(true);
      const agg = readIsolatedMarginAggregation(
        rows.map((r) => ({ id: r.id, marginMode: r.margin_mode, initialMargin: r.margin_initial })),
      );
      expect(agg.ok).toBe(true);
      if (!agg.ok) return;
      expect(agg.book).toBe('isolated');
      expect(agg.crossBook).toBe(false);
      expect(agg.sharedInitialMargin).toBeNull();
      expect(agg.positions).toHaveLength(2);
      expect(agg.positions.every((p) => p.marginMode === 'isolated')).toBe(true);
      expect(JSON.stringify(agg)).not.toMatch(/35000/);
    });
  });
}
