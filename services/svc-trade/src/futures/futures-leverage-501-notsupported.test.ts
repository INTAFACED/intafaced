/**
 * Unit card — live re-leverage is isolated+capped; margin-mode stays NotSupported
 * 1. Promise: POST /positions/leverage is a real door; /margin-mode uses notSupported
 * 2. Break: margin-mode calls rateLimited so bots retry with backoff
 * 3. Done bar: leverage handler is not derivativesNotSupported; margin-mode still is
 * 4. Class N
 * 5. Paths: svc-trade/src/private-rest.ts · futures/position-service.ts · index.ts
 * 6. RED: rateLimited( inside derivativesNotSupported, or leverage still 501-mounted,
 *    or setLeverage deleted / no longer posts futuresMarginAdd/Release
 */

import { describe, expect, it } from 'vitest';
import { doorHeaders, privateRestDoor } from './testing/doors.js';
import { FUTURES_HONEST_GAPS, futuresLiveReleverageMounted } from './mount-vs-tracker.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const levered = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  symbol: 'BTC/USDT-PERP',
  timestamp: Date.parse('2026-08-06T12:00:00.000Z'),
  datetime: '2026-08-06T12:00:00.000Z',
  side: 'long' as const,
  contracts: '1',
  contractSize: null,
  entryPrice: '50000',
  markPrice: null,
  notional: '50000',
  leverage: '5',
  collateral: '10000',
  initialMargin: '10000',
  maintenanceMargin: null,
  unrealizedPnl: null,
  realizedPnl: null,
  liquidationPrice: null,
  marginMode: 'isolated' as const,
  percentage: null,
};

describe('live re-leverage is mounted; margin-mode stays NotSupported', () => {
  it('POST leverage is a real handler, not the 501 helper', async () => {
    const calls: unknown[] = [];
    const app = await privateRestDoor({
      setLeverage: async (_principal, input) => {
        calls.push(input);
        return { ...levered, leverage: input.leverage } as never;
      },
    });
    try {
      for (const url of ['/api/v1/positions/leverage', '/api/v1/futures/leverage']) {
        const res = await app.inject({
          method: 'POST',
          url,
          headers: doorHeaders(),
          payload: { symbol: 'BTC/USDT-PERP', positionId: 'pos-1', leverage: '5', clientAdjustmentId: `lev-${url}` },
        });
        expect(res.statusCode, url).toBe(200);
        expect(res.json().leverage, url).toBe('5');
      }
      expect(calls).toEqual([
        { symbol: 'BTC/USDT-PERP', leverage: '5', positionId: 'pos-1', clientAdjustmentId: 'lev-/api/v1/positions/leverage' },
        { symbol: 'BTC/USDT-PERP', leverage: '5', positionId: 'pos-1', clientAdjustmentId: 'lev-/api/v1/futures/leverage' },
      ]);
      // Leverage is read only as a decimal string: a number is refused before the service is asked.
      const numeric = await app.inject({
        method: 'POST',
        url: '/api/v1/positions/leverage',
        headers: doorHeaders(),
        payload: { symbol: 'BTC/USDT-PERP', positionId: 'pos-1', leverage: 5, clientAdjustmentId: 'lev-numeric' },
      });
      expect(numeric.statusCode).toBe(400);
      expect(numeric.json()).toMatchObject({ intafacedCode: 'trade.leverage_required' });
      expect(calls).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it('deleting setLeverage live path fails — service posts ledger add/release', () => {
    // The service's ledger moves are driven in position-service.test.ts
    // ("re-leverage moves the isolated margin through futures.margin.add and futures.margin.release").
    expect(futuresLiveReleverageMounted()).toBe(true);
    expect(FUTURES_HONEST_GAPS).not.toContain('gap.live_releverage_501');
  });

  it('POST margin-mode still uses the derivativesNotSupported helper', async () => {
    const app = await privateRestDoor();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/margin-mode',
      headers: doorHeaders(),
      payload: { symbol: 'BTC/USDT-PERP', marginMode: 'cross' },
    });
    await app.close();
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ code: 'NotSupported', intafacedCode: 'trade.margin_mode_unsupported' });
  });

  it('the helper sends notSupported, not rateLimited', async () => {
    const app = await privateRestDoor();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/margin-mode',
      headers: doorHeaders(),
      payload: { symbol: 'BTC/USDT-PERP', marginMode: 'cross' },
    });
    await app.close();
    expect(res.statusCode).toBe(501);
    expect(res.json().code).not.toBe('RateLimitExceeded');
    expect(res.json()).not.toHaveProperty('retryAfter');
    expect(res.headers['retry-after']).toBeUndefined();
  });
});

// Kept source pins: what these read is wired where no test can call it yet, or on paths a behaviour test does not drive.
// Each pin stays until a behaviour test holds the same property on every path.
describe('kept source pins', () => {
  const src = readFileSync(join(here, '..', 'private-rest.ts'), 'utf8');

  const service = readFileSync(join(here, 'position-service.ts'), 'utf8');

  const indexSrc = readFileSync(join(here, '..', 'index.ts'), 'utf8');
  const setLev = service.match(/async setLeverage\([\s\S]*?^  async addIsolatedMargin/m)?.[0] ?? '';

  it('POST leverage is a real handler, not the 501 helper (kept source pin)', () => {
    expect(src).toMatch(/app\.post\('\/api\/v1\/positions\/leverage',\s*privateWrite,\s*async/);
    expect(src).not.toMatch(/app\.post\('\/api\/v1\/positions\/leverage',\s*(?:privateWrite,\s*)?derivativesNotSupported\('setLeverage'/);
    expect(src).toMatch(/deps\.setLeverage\(/);
    expect(src).toMatch(/typeof body\.leverage === 'string'/);
  });

  it('deleting setLeverage live path fails — service posts ledger add/release (kept source pin)', () => {
    expect(setLev).toMatch(/async setLeverage\(/);
    expect(setLev).toMatch(/recipes\.futuresMarginAdd\(/);
    expect(setLev).toMatch(/recipes\.futuresMarginRelease\(/);
    expect(setLev).not.toMatch(/notSupported\(/);
    expect(indexSrc).toMatch(/positions\.setLeverage\(/);
    expect(futuresLiveReleverageMounted()).toBe(true);
    expect(FUTURES_HONEST_GAPS).not.toContain('gap.live_releverage_501');
  });

  it('POST margin-mode still uses the derivativesNotSupported helper (kept source pin)', () => {
    expect(src).toMatch(/app\.post\('\/api\/v1\/positions\/margin-mode',\s*privateWrite,\s*derivativesNotSupported\('setMarginMode'/);
  });

  it('the helper sends notSupported, not rateLimited (kept source pin)', () => {
    const helper = src.match(/const derivativesNotSupported[\s\S]*?^\s*\};/m)?.[0] ?? '';
    expect(helper).toMatch(/notSupported\(/);
    expect(helper).not.toMatch(/rateLimited\(/);
  });
});
