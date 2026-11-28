/**
 * Unit card — unnamed profit pot is NotSupported, not a 5xx retry
 * 1. Promise: REST FuturesError for unconfigured pot tells bots retry:false
 * 2. Break: body is only { error, message } so CCXT retries 503 as venue-down
 * 3. Done bar: presentFuturesErrorWire + private-rest uses it
 * 4. Class N
 * 5. Paths: futures-error-wire.ts, private-rest.ts
 */

import { describe, expect, it } from 'vitest';
import { presentFuturesErrorWire } from './futures-error-wire.js';
import { FuturesError } from './position-service.js';
import { doorHeaders, privateRestDoor } from './testing/doors.js';

describe('presentFuturesErrorWire', () => {
  it('unnamed pot on open is NotSupported and not retryable', () => {
    const body = presentFuturesErrorWire({
      code: 'trade.futures_unconfigured',
      message: 'no pot',
    });
    expect(body).toEqual({
      error: 'trade.futures_unconfigured',
      message: 'no pot',
      ccxtCode: 'NotSupported',
      retry: false,
    });
  });

  it('unnamed pot on winning close is the same class', () => {
    const body = presentFuturesErrorWire({
      code: 'trade.profit_source_unconfigured',
      message: 'cannot pay',
    });
    expect(body.retry).toBe(false);
    expect(body.ccxtCode).toBe('NotSupported');
  });

  it('does not invent a retry class for mark refusal', () => {
    const body = presentFuturesErrorWire({
      code: 'trade.mark_unusable',
      message: 'dark',
    });
    expect(body).toEqual({ error: 'trade.mark_unusable', message: 'dark' });
    expect(body).not.toHaveProperty('retry');
  });
});

describe('private REST answers a FuturesError with presentFuturesErrorWire on each futures door', () => {
  /** A futures door, the dep it calls, and a request it accepts far enough to call that dep. */
  const DOORS: Array<{ dep: string; method: 'GET' | 'POST' | 'PUT'; url: string; payload?: Record<string, unknown> }> = [
    { dep: 'listLiquidations', method: 'GET', url: '/api/v1/futures/liquidations' },
    { dep: 'listFuturesPayouts', method: 'GET', url: '/api/v1/futures/payouts' },
    { dep: 'marginSummary', method: 'GET', url: '/api/v1/futures/margin-summary' },
    { dep: 'readAccountMode', method: 'GET', url: '/api/v1/futures/position-mode' },
    { dep: 'writeAccountMode', method: 'PUT', url: '/api/v1/futures/position-mode', payload: { mode: 'hedge', clientModeId: 'mode-wire' } },
    { dep: 'getPosition', method: 'GET', url: '/api/v1/positions/pos-1' },
    { dep: 'listFundingPayments', method: 'GET', url: '/api/v1/positions/pos-1/funding-payments' },
    { dep: 'positionLiquidation', method: 'GET', url: '/api/v1/positions/pos-1/liquidation' },
    { dep: 'closeAllPositions', method: 'POST', url: '/api/v1/futures/positions/close-all', payload: { clientBatchId: 'close-all-wire' } },
    {
      // The open asks the account's position mode first: the refusal comes from there, through the open's own catch.
      dep: 'readAccountMode',
      method: 'POST',
      url: '/api/v1/positions',
      payload: { symbol: 'BTC/USDT-PERP', side: 'long', size: '1', leverage: '5', marginMode: 'isolated', clientOpenId: 'open-wire' },
    },
    {
      dep: 'addIsolatedMargin',
      method: 'POST',
      url: '/api/v1/positions/margin',
      payload: { symbol: 'BTC/USDT-PERP', positionId: 'pos-1', amount: '10', clientAdjustmentId: 'add-wire' },
    },
    {
      dep: 'reduceIsolatedMargin',
      method: 'POST',
      url: '/api/v1/positions/margin/reduce',
      payload: { symbol: 'BTC/USDT-PERP', positionId: 'pos-1', amount: '10', clientAdjustmentId: 'reduce-wire' },
    },
    {
      dep: 'setLeverage',
      method: 'POST',
      url: '/api/v1/positions/leverage',
      payload: { symbol: 'BTC/USDT-PERP', positionId: 'pos-1', leverage: '5', clientAdjustmentId: 'lev-wire' },
    },
    {
      dep: 'setLeverage',
      method: 'POST',
      url: '/api/v1/futures/leverage',
      payload: { symbol: 'BTC/USDT-PERP', positionId: 'pos-1', leverage: '5', clientAdjustmentId: 'lev-wire-2' },
    },
  ];

  it('private-rest sends FuturesError through presentFuturesErrorWire', async () => {
    for (const [code, status] of [
      ['trade.profit_source_unconfigured', 503],
      ['trade.futures_unconfigured', 503],
      ['trade.leverage_cap_unset', 400],
    ] as const) {
      const err = new FuturesError(`refused ${code}`, code, status);
      const called: string[] = [];
      const deps = Object.fromEntries(
        DOORS.map((d) => [
          d.dep,
          async () => {
            called.push(d.dep);
            throw err;
          },
        ]),
      );
      const app = await privateRestDoor(deps as never);
      try {
        for (const door of DOORS) {
          const res = await app.inject({
            method: door.method,
            url: door.url,
            headers: doorHeaders(),
            ...(door.payload ? { payload: door.payload } : {}),
          });
          expect(res.statusCode, `${door.url} ${code}`).toBe(status);
          expect(res.json(), `${door.url} ${code}`).toEqual(presentFuturesErrorWire(err));
        }
      } finally {
        await app.close();
      }
      expect([...called].sort()).toEqual(DOORS.map((d) => d.dep).sort());
    }
  });
});
