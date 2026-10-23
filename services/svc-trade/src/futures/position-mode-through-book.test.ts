import { afterEach, describe, expect, it } from 'vitest';
import type { TradeService } from '../spot/trade-service.js';
import { toCcxtError } from '../ccxt-errors.js';
import { FUTURES_ORDERS_THROUGH_BOOK, futuresOrdersThroughBook, installPositionModePlace } from './position-mode.js';

/**
 * While futures orders go through the futures book (TRADE_FUTURES_MATCHING_ENABLED), the spot order path refuses a
 * futures market before anything is held, so no spot hold can rest on a futures book and meet a matched order.
 */
function fakeTradeService(kind: 'spot' | 'futures') {
  const placed: unknown[] = [];
  class Fake {
    async marketBySymbol() {
      return { id: 'm1', symbol: kind === 'futures' ? 'BTC/USDT:USDT' : 'BTC/USDT', kind };
    }
    async marketById() {
      return this.marketBySymbol();
    }
    async placeOrder(_principal: unknown, input: unknown) {
      placed.push(input);
      return { ok: true };
    }
    async placeCopyMirror(_principal: unknown, input: unknown, _followId: string) {
      placed.push(input);
      return { ok: true };
    }
  }
  installPositionModePlace(Fake as unknown as typeof TradeService);
  return { svc: new Fake(), placed };
}

const ORIGINAL = process.env.TRADE_FUTURES_MATCHING_ENABLED;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.TRADE_FUTURES_MATCHING_ENABLED;
  else process.env.TRADE_FUTURES_MATCHING_ENABLED = ORIGINAL;
});

describe('spot order path on a futures book', () => {
  it('reads the switch the way env.ts does', () => {
    expect(futuresOrdersThroughBook({})).toBe(false);
    for (const on of ['1', 'true', 'TRUE', 'on', 'yes'])
      expect(futuresOrdersThroughBook({ TRADE_FUTURES_MATCHING_ENABLED: on }), on).toBe(true);
    // No trim, exactly as env.ts: a padded value is off for both, so the routes and this refusal agree.
    for (const off of ['', '0', 'false', 'off', ' true'])
      expect(futuresOrdersThroughBook({ TRADE_FUTURES_MATCHING_ENABLED: off }), off).toBe(false);
  });

  it('switch on: a futures order on the spot path refuses before the spot path runs, even with a position mode', async () => {
    process.env.TRADE_FUTURES_MATCHING_ENABLED = 'true';
    const { svc, placed } = fakeTradeService('futures');
    await expect(svc.placeOrder({}, { symbol: 'BTC/USDT:USDT', side: 'buy', positionMode: 'one_way' } as never)).rejects.toMatchObject({
      code: FUTURES_ORDERS_THROUGH_BOOK,
    });
    expect(placed).toEqual([]);
  });

  it('switch on: the copy-trading mirror refuses a futures market too; the refusal is a 400 naming the code', async () => {
    process.env.TRADE_FUTURES_MATCHING_ENABLED = 'true';
    const { svc, placed } = fakeTradeService('futures');
    const err = await svc.placeCopyMirror({}, { symbol: 'BTC/USDT:USDT', side: 'buy' } as never, 'f1').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: FUTURES_ORDERS_THROUGH_BOOK });
    expect(placed).toEqual([]);
    expect(toCcxtError(err)).toMatchObject({ status: 400, body: { intafacedCode: FUTURES_ORDERS_THROUGH_BOOK } });
  });

  it('switch on: a spot order is untouched', async () => {
    process.env.TRADE_FUTURES_MATCHING_ENABLED = 'true';
    const { svc, placed } = fakeTradeService('spot');
    await svc.placeOrder({}, { symbol: 'BTC/USDT', side: 'buy' } as never);
    expect(placed).toHaveLength(1);
  });

  it('switch off: the futures order keeps today’s path (a position mode is still required)', async () => {
    delete process.env.TRADE_FUTURES_MATCHING_ENABLED;
    const { svc, placed } = fakeTradeService('futures');
    await expect(svc.placeOrder({}, { symbol: 'BTC/USDT:USDT', side: 'buy' } as never)).rejects.toMatchObject({
      code: 'trade.position_mode_unset',
    });
    await svc.placeOrder({}, { symbol: 'BTC/USDT:USDT', side: 'buy', positionMode: 'one_way' } as never);
    expect(placed).toHaveLength(1);
  });
});
