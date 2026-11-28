/**
 * Unit card — funding interval is owner-named, never an invented 8h
 * 1. Promise: empty TRADE_FUTURES_FUNDING_INTERVAL_MS does not schedule funding
 * 2. Break: zod default(28_800_000) arms an 8h tick the owner never named
 * 3. Done bar: source has no 8h default; null interval + markets → no funding jobs
 * 4. Class N
 * 5. Paths: env.ts · futures-jobs.ts
 * 6. RED: default(28_800_000)
 * 7. Collision: #1908 jobs test (maintenanceBps pin — this file does not edit it)
 */

import { describe, expect, it, vi } from 'vitest';
import { tradeEnvWith } from './testing/doors.js';
import { startFuturesJobs } from './futures-jobs.js';
import { readFileSync } from 'node:fs';

describe('funding interval is not an invented 8h', () => {
  it('env.ts does not default TRADE_FUTURES_FUNDING_INTERVAL_MS to 8h', () => {
    // Unset and blank are no schedule; 8h is honoured only when the owner sets it; a value outside the window stops boot.
    expect(tradeEnvWith({}, ['TRADE_FUTURES_FUNDING_INTERVAL_MS']).TRADE_FUTURES_FUNDING_INTERVAL_MS).toBeNull();
    expect(tradeEnvWith({ TRADE_FUTURES_FUNDING_INTERVAL_MS: '  ' }).TRADE_FUTURES_FUNDING_INTERVAL_MS).toBeNull();
    expect(tradeEnvWith({ TRADE_FUTURES_FUNDING_INTERVAL_MS: '28800000' }).TRADE_FUTURES_FUNDING_INTERVAL_MS).toBe(28_800_000);
    expect(() => tradeEnvWith({ TRADE_FUTURES_FUNDING_INTERVAL_MS: '1000' })).toThrow(/no invented 8h schedule/);
  });

  it('enabled with markets but null interval schedules liquidation only', () => {
    const handle = startFuturesJobs({
      sql: {} as never,
      ledger: { post: vi.fn(), balance: vi.fn() },
      matching: { depth: vi.fn() } as never,
      bus: null,
      config: {
        enabled: true,
        liqIntervalMs: 1000,
        fundingIntervalMs: null,
        fundingMarketIds: ['m1'],
        fundingMaxAbsRate: '1', // fixture — not product law (D2)
      },
    });
    expect(handle.host.list().sort()).toEqual(['futures.dated_settlement', 'futures.liquidation', 'futures.payouts']);
    handle.stop();
  });
});

// Kept source pins: what these read is wired where no test can call it yet, or on paths a behaviour test does not drive.
// Each pin stays until a behaviour test holds the same property on every path.
describe('kept source pins', () => {
  it('env.ts does not default TRADE_FUTURES_FUNDING_INTERVAL_MS to 8h (kept source pin)', () => {
    const src = readFileSync(new URL('../env.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/TRADE_FUTURES_FUNDING_INTERVAL_MS[\s\S]{0,400}default\(28_800_000\)/);
    expect(src).toMatch(/TRADE_FUTURES_FUNDING_INTERVAL_MS[\s\S]{0,200}\.default\(''\)/);
  });

  it('jobs source does not pin an 8h funding period (kept source pin)', () => {
    const src = readFileSync(new URL('./futures-jobs.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/28_?800_?000/);
    expect(src).not.toMatch(/8 \* 60 \* 60/);
    expect(src).toMatch(/fundingIntervalMs != null/);
  });
});
