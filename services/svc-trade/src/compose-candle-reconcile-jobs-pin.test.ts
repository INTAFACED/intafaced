import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tradeEnvOf } from './__tests__/entry.js';

/**
 * Unit card — compose stack passes candle and reconcile jobs into svc-trade
 *
 * 1. Promise: host `.env` can enable/pin TRADE_CANDLE_JOBS_* and
 *    TRADE_RECONCILE_JOBS_* (env.ts already declares them, default OFF).
 * 2. Break: compose booted trade without the names → operator enable / interval /
 *    market list is a no-op and the container always uses schema-only defaults.
 * 3. Done bar: docker-compose.apps.yml svc-trade has
 *    TRADE_CANDLE_JOBS_ENABLED: ${TRADE_CANDLE_JOBS_ENABLED:-false}
 *    TRADE_CANDLE_JOBS_INTERVAL_MS: ${TRADE_CANDLE_JOBS_INTERVAL_MS:-60000}
 *    TRADE_CANDLE_JOBS_MARKET_IDS: ${TRADE_CANDLE_JOBS_MARKET_IDS:-}
 *    TRADE_CANDLE_JOBS_TIMEFRAMES: ${TRADE_CANDLE_JOBS_TIMEFRAMES:-}
 *    TRADE_CANDLE_JOBS_LIMIT: ${TRADE_CANDLE_JOBS_LIMIT:-}
 *    TRADE_RECONCILE_JOBS_ENABLED: ${TRADE_RECONCILE_JOBS_ENABLED:-false}
 *    TRADE_RECONCILE_JOBS_INTERVAL_MS: ${TRADE_RECONCILE_JOBS_INTERVAL_MS:-60000}
 * 4. Class N/P
 * 5. Paths: docker-compose.apps.yml (svc-trade block only)
 * 6. RED: pin fails if a unique key drops, is duplicated, jobs default ON, or
 *    market ids invent a UUID
 * 7. Collision: existing MM seed / algo / convert / copy / futures / OTC /
 *    options / slippage — this pin does not restamp them.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const KEYS = [
  { name: 'TRADE_CANDLE_JOBS_ENABLED', fallback: 'false' },
  { name: 'TRADE_CANDLE_JOBS_INTERVAL_MS', fallback: '60000' },
  { name: 'TRADE_CANDLE_JOBS_MARKET_IDS', fallback: '' },
  { name: 'TRADE_CANDLE_JOBS_TIMEFRAMES', fallback: '' },
  { name: 'TRADE_CANDLE_JOBS_LIMIT', fallback: '' },
  { name: 'TRADE_RECONCILE_JOBS_ENABLED', fallback: 'false' },
  { name: 'TRADE_RECONCILE_JOBS_INTERVAL_MS', fallback: '60000' },
] as const;

function tradeComposeBlock(): string {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const start = compose.indexOf('\n  svc-trade:');
  expect(start, 'svc-trade service missing from docker-compose.apps.yml').toBeGreaterThanOrEqual(0);
  const rest = compose.slice(start + 1);
  const next = rest.search(/\n  svc-[a-z]+:/);
  return next === -1 ? rest : rest.slice(0, next);
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

describe('compose passes candle and reconcile jobs into svc-trade', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const block = tradeComposeBlock();

  it('env.ts still declares both jobs default OFF (schema-only until compose names them)', () => {
    const unset = tradeEnvOf();
    expect(unset.TRADE_CANDLE_JOBS_ENABLED).toBe(false);
    expect(unset.TRADE_RECONCILE_JOBS_ENABLED).toBe(false);
    expect(unset.TRADE_CANDLE_JOBS_MARKET_IDS).toBe('');
    // No invented 1m timeframe and no invented limit: blank stays blank, and the limit reads null.
    expect(unset.TRADE_CANDLE_JOBS_TIMEFRAMES).toBe('');
    expect(unset.TRADE_CANDLE_JOBS_LIMIT).toBeNull();
    expect(tradeEnvOf({ TRADE_CANDLE_JOBS_LIMIT: 'nope' }).TRADE_CANDLE_JOBS_LIMIT).toBeNull();
    expect(tradeEnvOf({ TRADE_CANDLE_JOBS_LIMIT: '200' }).TRADE_CANDLE_JOBS_LIMIT).toBe(200);
  });

  it('compose svc-trade block passes unique keys once with jobs OFF and empty market ids', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-trade/);
    for (const key of KEYS) {
      expect(block, `${key.name} missing from svc-trade compose environment`).toMatch(
        new RegExp(`${key.name}:\\s*\\$\\{${key.name}:-${key.fallback}\\}`),
      );
    }
    expect(block).toMatch(/TRADE_CANDLE_JOBS_ENABLED:\s*\$\{TRADE_CANDLE_JOBS_ENABLED:-false\}/);
    expect(block).toMatch(/TRADE_RECONCILE_JOBS_ENABLED:\s*\$\{TRADE_RECONCILE_JOBS_ENABLED:-false\}/);
    expect(block).toMatch(/TRADE_CANDLE_JOBS_MARKET_IDS:\s*\$\{TRADE_CANDLE_JOBS_MARKET_IDS:-\}/);
    expect(block).toMatch(/TRADE_CANDLE_JOBS_TIMEFRAMES:\s*\$\{TRADE_CANDLE_JOBS_TIMEFRAMES:-\}/);
    expect(block).not.toMatch(/TRADE_CANDLE_JOBS_TIMEFRAMES:\s*\$\{TRADE_CANDLE_JOBS_TIMEFRAMES:-1m\}/);
    expect(block).toMatch(/TRADE_CANDLE_JOBS_LIMIT:\s*\$\{TRADE_CANDLE_JOBS_LIMIT:-\}/);
    expect(block).not.toMatch(/TRADE_CANDLE_JOBS_ENABLED:\s*\$\{TRADE_CANDLE_JOBS_ENABLED:-true\}/);
    expect(block).not.toMatch(/TRADE_RECONCILE_JOBS_ENABLED:\s*\$\{TRADE_RECONCILE_JOBS_ENABLED:-true\}/);
  });

  it('names each key once in compose (no duplicate assignments)', () => {
    for (const key of KEYS) {
      expect(countAssignments(compose, key.name), `${key.name} must appear once`).toBe(1);
      expect(countAssignments(block, key.name), `${key.name} must appear once on svc-trade`).toBe(1);
    }
  });

  it('does not restamp MM seed, algo, convert, copy, futures, OTC, options, slippage', () => {
    expect(block).toMatch(/TRADE_MARKET_SLIPPAGE_CAP_BPS:\s*\$\{TRADE_MARKET_SLIPPAGE_CAP_BPS:-\}/);
    expect(block).toMatch(/TRADE_FUTURES_ENABLED:\s*\$\{TRADE_FUTURES_ENABLED:-false\}/);
    expect(block).toMatch(/TRADE_FUTURES_JOBS_ENABLED:\s*\$\{TRADE_FUTURES_JOBS_ENABLED:-false\}/);
    expect(block).toMatch(/TRADE_MM_SEED_ENABLED:\s*\$\{TRADE_MM_SEED_ENABLED:-false\}/);
    expect(block).toMatch(/TRADE_ALGO_JOBS_ENABLED:\s*\$\{TRADE_ALGO_JOBS_ENABLED:-false\}/);
    expect(block).toMatch(/TRADE_CONVERT_ENABLED:\s*\$\{TRADE_CONVERT_ENABLED:-true\}/);
    expect(block).toMatch(/TRADE_CONVERT_QUOTE_TTL_MS:\s*\$\{TRADE_CONVERT_QUOTE_TTL_MS:-\}/);
    expect(block).toMatch(/TRADE_COPY_FEE_SHARE_LAW:\s*\$\{TRADE_COPY_FEE_SHARE_LAW:-\}/);
    expect(block).toMatch(/TRADE_OPTIONS_SETTLEMENT_ASSET_LAW:\s*\$\{TRADE_OPTIONS_SETTLEMENT_ASSET_LAW:-\}/);
    expect(block).toMatch(/TRADE_OTC_DESK_LAW:\s*\$\{TRADE_OTC_DESK_LAW:-\}/);
  });
});
