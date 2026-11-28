/**
 * Unit card — TRADE_ALGO_JOBS_ENABLED stays default OFF
 * 1. Promise: child TWAP ticks do not fire unless an operator denylist-enables jobs
 * 2. Break: `.default(true)` or `enabled: true` in the host would slice on a clean deploy
 * 3. Done bar: env default false + denylist; startAlgoJobs short-circuits; no tickAllAlgos
 * 4. Class N
 * 5. Paths: svc-trade/src/algo + env.ts / index.ts source pins (read-only)
 * 6. RED: TRADE_ALGO_JOBS_ENABLED default true, or disabled host still calls tickAllAlgos
 * 7. Collision: none — does not invent VWAP/POV; tracker stays residual
 */

import { describe, expect, it, vi } from 'vitest';
import { tradeEnvOf } from '../__tests__/entry.js';
import { startAlgoJobs } from './algo-jobs.js';

describe('TRADE_ALGO_JOBS_ENABLED cannot sneak default ON', () => {
  it('env schema defaults the jobs flag false (unset deploy places no children)', () => {
    expect(tradeEnvOf().TRADE_ALGO_JOBS_ENABLED).toBe(false);
  });

  it('only denylist strings enable jobs — empty / 0 / false stay off', () => {
    for (const raw of ['', '0', 'false', 'off', 'no', 'enabled', ' true']) {
      expect(tradeEnvOf({ TRADE_ALGO_JOBS_ENABLED: raw }).TRADE_ALGO_JOBS_ENABLED, JSON.stringify(raw)).toBe(false);
    }
    for (const raw of ['1', 'true', 'on', 'yes', 'TRUE', 'Yes']) {
      expect(tradeEnvOf({ TRADE_ALGO_JOBS_ENABLED: raw }).TRADE_ALGO_JOBS_ENABLED, raw).toBe(true);
    }
  });

  it('scheduler returns before registering algo.twap when enabled is falsy', () => {
    const trade = { tickAllAlgos: vi.fn(async () => undefined) };
    const off = startAlgoJobs({ trade, config: { enabled: false, intervalMs: 250 } });
    expect(off.host.list()).toEqual([]);
    off.stop();
    const on = startAlgoJobs({ trade, config: { enabled: true, intervalMs: 250 } });
    expect(on.host.list()).toEqual(['algo.twap']);
    on.stop();
  });

  it('default-OFF handle never calls tickAllAlgos even after the interval elapses', async () => {
    vi.useFakeTimers();
    try {
      const trade = { tickAllAlgos: vi.fn(async () => undefined) };
      const handle = startAlgoJobs({ trade, config: { enabled: false, intervalMs: 250 } });
      expect(handle.host.list()).toEqual([]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(trade.tickAllAlgos).not.toHaveBeenCalled();
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
