/**
 * CARD R-E6 — auto delta-hedge mill (unset target/range/instrument refuse).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
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
} from './delta-hedge.js';

const here = dirname(fileURLToPath(import.meta.url));

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
  it('mill does not start oms-mmp-hedge or invent MMP thresholds', () => {
    const mill = readFileSync(join(here, 'delta-hedge.ts'), 'utf8');
    expect(mill).not.toMatch(/from ['"][^'"]*oms-mmp/);
    expect(mill).not.toMatch(/EXECUTION_MM_MMP_THRESHOLDS/);
    expect(mill).not.toMatch(/hedgeRemainingAfterMmpFill/);
    expect(mill).not.toMatch(/recipes\./);
    expect(mill).not.toMatch(/options-listing/);
    expect(mill).toMatch(/TRADE_DELTA_HEDGE_TARGET/);
    expect(mill).toMatch(/decimal string/);
  });

  it('router.ts / options-listing.ts not recut; index.ts mounts the door', () => {
    const routerSrc = readFileSync(join(here, '..', 'router.ts'), 'utf8');
    const listingSrc = readFileSync(join(here, '..', 'spot', 'options-listing.ts'), 'utf8');
    const indexSrc = readFileSync(join(here, '..', 'index.ts'), 'utf8');
    expect(routerSrc).not.toMatch(/delta-hedge|checkAutoDeltaHedge|DELTA_HEDGE_/);
    expect(listingSrc).not.toMatch(/delta-hedge|checkAutoDeltaHedge/);
    expect(indexSrc).toContain('registerDeltaHedgeRest');
  });

  it('compose passes target/range/instrument with empty default', () => {
    expect(deltaHedgeOwnerEnvComposeWired()).toBe(true);
  });

  it('env schema defaults the three sockets empty — never invents 0', () => {
    const envSrc = readFileSync(join(here, '..', 'env.ts'), 'utf8');
    expect(envSrc).toMatch(/TRADE_DELTA_HEDGE_TARGET:\s*z\.string\(\)\.default\(''\)/);
    expect(envSrc).toMatch(/TRADE_DELTA_HEDGE_RANGE:\s*z\.string\(\)\.default\(''\)/);
    expect(envSrc).toMatch(/TRADE_DELTA_HEDGE_INSTRUMENT:\s*z\.string\(\)\.default\(''\)/);
  });
});
