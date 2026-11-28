/**
 * CARD R-E6 — auto delta-hedge mill (unset target/range/instrument refuse).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { tradeEnvOf, tradeRouterPaths } from '../__tests__/entry.js';
import { deltaHedgeOwnerEnvComposeWired } from './greeks-compose-wiring.js';
import {
  DELTA_HEDGE_IEEE,
  DELTA_HEDGE_INSTRUMENT_ENV,
  DELTA_HEDGE_INSTRUMENT_UNSET,
  DELTA_HEDGE_RANGE_ENV,
  DELTA_HEDGE_RANGE_UNSET,
  DELTA_HEDGE_TARGET_ENV,
  DELTA_HEDGE_TARGET_UNSET,
  checkAutoDeltaHedge,
  runAutoDeltaHedge,
} from './delta-hedge.js';

const SOCKETS = [DELTA_HEDGE_TARGET_ENV, DELTA_HEDGE_RANGE_ENV, DELTA_HEDGE_INSTRUMENT_ENV] as const;

const previous: Record<string, string | undefined> = {};

function snapshotEnv(): void {
  for (const key of SOCKETS) previous[key] = process.env[key];
}

function restoreEnv(): void {
  for (const key of SOCKETS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
}

function clearSockets(): void {
  for (const key of SOCKETS) delete process.env[key];
}

describe('R-E6 auto delta-hedge mill — unset sockets refuse by name', () => {
  snapshotEnv();
  afterEach(restoreEnv);

  it('blank target / range / instrument each refuse their named code', () => {
    clearSockets();
    expect(checkAutoDeltaHedge({})).toMatchObject({
      ok: false,
      code: DELTA_HEDGE_TARGET_UNSET,
      executed: false,
      orders: [],
    });
    expect(checkAutoDeltaHedge({ target: '0' })).toMatchObject({
      ok: false,
      code: DELTA_HEDGE_RANGE_UNSET,
      executed: false,
    });
    expect(checkAutoDeltaHedge({ target: '0', range: '0.05' })).toMatchObject({
      ok: false,
      code: DELTA_HEDGE_INSTRUMENT_UNSET,
      executed: false,
    });
    expect(checkAutoDeltaHedge({ target: '  ', range: '', instrument: '' })).toMatchObject({
      ok: false,
      code: DELTA_HEDGE_TARGET_UNSET,
    });
  });

  it('IEEE number on target or range refuses — never a JS delta', () => {
    clearSockets();
    expect(checkAutoDeltaHedge({ target: 0, range: '0.05', instrument: 'BTC-PERP' })).toMatchObject({
      ok: false,
      code: DELTA_HEDGE_IEEE,
    });
    expect(checkAutoDeltaHedge({ target: '0', range: 0.05, instrument: 'BTC-PERP' })).toMatchObject({
      ok: false,
      code: DELTA_HEDGE_IEEE,
    });
  });

  it('published decimal sockets preview only — no orders, no invented residual', () => {
    clearSockets();
    const result = checkAutoDeltaHedge({ target: '0.00', range: '0.0500', instrument: ' BTC-PERP ' });
    expect(result).toEqual({
      ok: true,
      preview: true,
      executed: false,
      orders: [],
      target: '0',
      range: '0.05',
      instrument: 'BTC-PERP',
    });
  });

  it('reads owner env when input omits sockets', () => {
    process.env[DELTA_HEDGE_TARGET_ENV] = '0';
    process.env[DELTA_HEDGE_RANGE_ENV] = '0.1';
    process.env[DELTA_HEDGE_INSTRUMENT_ENV] = 'ETH-PERP';
    expect(checkAutoDeltaHedge({})).toMatchObject({
      ok: true,
      target: '0',
      range: '0.1',
      instrument: 'ETH-PERP',
      executed: false,
    });
  });
});

describe('R-E6 hitch — not MMP hedge, no listing, compose empty', () => {
  it('mill does not start oms-mmp-hedge or invent MMP thresholds', async () => {
    // Whatever the sockets hold, the mill previews or refuses: it posts nothing, places no order, and reads no MMP law.
    const posted: unknown[] = [];
    const post = async (recipe: unknown) => void posted.push(recipe);
    process.env.EXECUTION_MM_MMP_THRESHOLDS = '{"deltaLimit":"1"}';
    try {
      for (const sockets of [
        {},
        { target: '0' },
        { target: '0', range: '0.05', instrument: 'BTC-PERP' },
        { target: 0, range: '0.05', instrument: 'BTC-PERP' },
      ]) {
        const result = await runAutoDeltaHedge({ ...sockets, post });
        expect(result.executed, JSON.stringify(sockets)).toBe(false);
        expect(result.orders).toEqual([]);
        expect(JSON.stringify(result)).not.toMatch(/mmp/i);
      }
    } finally {
      delete process.env.EXECUTION_MM_MMP_THRESHOLDS;
    }
    expect(posted).toEqual([]);
    // The owner's target is a decimal string, kept as the owner wrote it in ledger form, never a JS number.
    expect(await runAutoDeltaHedge({ target: '0.10', range: '0.05', instrument: 'BTC-PERP', post })).toMatchObject({
      ok: true,
      target: '0.1',
    });
    expect(await runAutoDeltaHedge({ target: 0.1, range: '0.05', instrument: 'BTC-PERP', post })).toMatchObject({
      ok: false,
      code: DELTA_HEDGE_IEEE,
    });
    // Nothing the mill exports lists an option or folds the MMP hedge in.
    const mill = await import('./delta-hedge.js');
    expect(Object.keys(mill).filter((name) => /mmp|listing|recipe/i.test(name))).toEqual([]);
  });

  it('router.ts / options-listing.ts not recut; index.ts mounts the door', async () => {
    // The hedge is its own REST door (index.boot.test.ts: 'mounts the greeks what-if, delta-hedge and promo doors'):
    // no tRPC procedure and nothing the options listing exports runs it.
    expect(tradeRouterPaths().filter((path) => /hedge/i.test(path))).toEqual([]);
    const listing = await import('../spot/options-listing.js');
    expect(Object.keys(listing).filter((name) => /hedge/i.test(name))).toEqual([]);
  });

  it('compose passes target/range/instrument with empty default', () => {
    expect(deltaHedgeOwnerEnvComposeWired()).toBe(true);
  });

  it('env schema defaults the three sockets empty — never invents 0', () => {
    const unset = tradeEnvOf();
    expect(unset.TRADE_DELTA_HEDGE_TARGET).toBe('');
    expect(unset.TRADE_DELTA_HEDGE_RANGE).toBe('');
    expect(unset.TRADE_DELTA_HEDGE_INSTRUMENT).toBe('');
  });
});
