import { parseAmount as amt } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { assertTradable } from '../spot/risk.js';
import { TradeError, type Market } from '../spot/types.js';
import { readTradePlanes } from './plane-capabilities.js';

const futuresMarket = (): Market =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    symbol: 'BTC/USDT-PERP',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    kind: 'futures',
    tickSize: amt('0.01'),
    lotSize: amt('0.0001'),
    minQty: amt('0.0001'),
    maxQty: amt('100'),
    minNotional: amt('1'),
    status: 'active',
    makerBps: 10,
    takerBps: 20,
    listedAt: new Date('2026-08-06T00:00:00.000Z'),
    assetClass: 'crypto',
    schedule: 'crypto-24x7',
    paper: false,
  }) as Market;

describe('trade plane read', () => {
  it('unset futures stays off and names the same reason a futures write uses', () => {
    const planes = readTradePlanes({});
    expect(planes.futures).toEqual({ enabled: false, reason: 'trade.futures_disabled' });
    expect(planes.spot).toEqual({ enabled: true });
    const previous = process.env.TRADE_FUTURES_ENABLED;
    delete process.env.TRADE_FUTURES_ENABLED;
    try {
      assertTradable(futuresMarket());
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe(readTradePlanes().futures.reason);
    } finally {
      if (previous === undefined) delete process.env.TRADE_FUTURES_ENABLED;
      else process.env.TRADE_FUTURES_ENABLED = previous;
    }
  });

  it('flipping the flag flips the read and the write together', () => {
    const previous = process.env.TRADE_FUTURES_ENABLED;
    process.env.TRADE_FUTURES_ENABLED = 'false';
    try {
      expect(readTradePlanes().futures.reason).toBe('trade.futures_disabled');
      expect(() => assertTradable(futuresMarket())).toThrowError(expect.objectContaining({ code: 'trade.futures_disabled' }));
      process.env.TRADE_FUTURES_ENABLED = 'true';
      expect(readTradePlanes().futures).toEqual({ enabled: true });
      expect(() => assertTradable(futuresMarket())).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.TRADE_FUTURES_ENABLED;
      else process.env.TRADE_FUTURES_ENABLED = previous;
    }
  });

  it('spot off names trade.spot_disabled and does not leak a secret', () => {
    const planes = readTradePlanes({ TRADE_SPOT_ENABLED: 'false', TRADE_FUTURES_ENABLED: 'no' });
    expect(planes.spot).toEqual({ enabled: false, reason: 'trade.spot_disabled' });
    expect(JSON.stringify(planes)).not.toMatch(/secret|operator|token/i);
  });
});
