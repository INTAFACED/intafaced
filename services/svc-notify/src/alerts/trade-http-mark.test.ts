/**
 * Unit card — trade public ticker MarkSource (v22.alerts product residual)
 * 1. Promise: README § Price alerts — "until a real mark feed is wired";
 *    tracker residual "owner mark source before any watch can fire"; bank
 *    already reads the same public ticker (services/svc-bank loans/prices.ts)
 * 2. Break on tip: a ticker timestamp from 2023 still returned `{ kind: 'ok' }`
 *    and evaluateMarket fired the one-shot on a memory
 * 3. Done bar: live source fires on mid/last decimal strings; missing URL stays
 *    dark; bad/empty/stale ticker refuses by name — never invents a price
 * 4. Class P (no ledger; decimal strings only)
 * 5. Paths: services/svc-notify only
 * 6. RED: empty ticker returns ok with "0" or invents mid from nothing
 * 7. Collision: none on wall
 */

import { describe, expect, it, vi } from 'vitest';
import { NotifyService } from '../notify-service.js';
import { MemoryNotifyStore } from '../store.js';
import { AlertService } from './service.js';
import { MemoryAlertStore } from './store.js';
import {
  assertNotifyMarketsListLimit,
  createTradeHttpMarkSource,
  midDecimalString,
  NOTIFY_MARKETS_LIST_LIMIT_UNSET,
  NotifyMarketsListLimitUnsetError,
  priceFromTicker,
} from './trade-http-mark.js';
import { TEST_ALERT_LIMITS } from './test-limits.js';

const MARKET_ID = '11111111-1111-1111-1111-111111111111';
const SYMBOL = 'BTC/USDT';
/** Owner-explicit page size — never a silent 50. */
const MARKETS_LIMIT = 100;

function isMarketsList(url: string): boolean {
  return url.includes('/api/v1/markets?limit=');
}

describe('midDecimalString / priceFromTicker (no invent)', () => {
  it('mids two-sided quotes as decimal strings without JS number', () => {
    expect(midDecimalString('100.00', '102.00')).toBe('101');
    expect(midDecimalString('1.5', '2.5')).toBe('2');
    expect(midDecimalString('0', '1')).toBeNull();
    expect(midDecimalString('-1', '1')).toBeNull();
  });

  it('prefers mid, falls back to last, refuses empty', () => {
    expect(priceFromTicker({ bid: '10', ask: '12', last: '99' })).toEqual({
      price: '11',
      quality: 'mid',
    });
    expect(priceFromTicker({ bid: null, ask: null, last: '42.5' })).toEqual({
      price: '42.5',
      quality: 'last',
    });
    expect(priceFromTicker({ bid: null, ask: null, last: null })).toBeNull();
    expect(priceFromTicker({ bid: '0', ask: '0', last: '0' })).toBeNull();
  });
});

describe('assertNotifyMarketsListLimit', () => {
  it('refuses blank / NaN / 0 — never invents 50', () => {
    expect(() => assertNotifyMarketsListLimit(undefined)).toThrow(NotifyMarketsListLimitUnsetError);
    expect(() => assertNotifyMarketsListLimit(null)).toThrow(NotifyMarketsListLimitUnsetError);
    expect(() => assertNotifyMarketsListLimit(Number.NaN)).toThrow(NotifyMarketsListLimitUnsetError);
    expect(() => assertNotifyMarketsListLimit(0)).toThrow(NotifyMarketsListLimitUnsetError);
    try {
      assertNotifyMarketsListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(NotifyMarketsListLimitUnsetError);
      expect((e as NotifyMarketsListLimitUnsetError).code).toBe(NOTIFY_MARKETS_LIST_LIMIT_UNSET);
      expect((e as NotifyMarketsListLimitUnsetError).message).toBe(NOTIFY_MARKETS_LIST_LIMIT_UNSET);
    }
  });

  it('owner-explicit 50 is allowed and caps at 500', () => {
    expect(assertNotifyMarketsListLimit(50)).toBe(50);
    expect(assertNotifyMarketsListLimit(1)).toBe(1);
    expect(assertNotifyMarketsListLimit(500)).toBe(500);
    expect(assertNotifyMarketsListLimit(501)).toBe(500);
  });
});

describe('createTradeHttpMarkSource', () => {
  it('is live wiring — canFire true even when a single quote is unavailable', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (isMarketsList(String(url))) {
        expect(String(url)).toBe(`http://trade.test/api/v1/markets?limit=${MARKETS_LIMIT}`);
        return new Response(JSON.stringify([{ id: MARKET_ID, symbol: SYMBOL }]), { status: 200 });
      }
      return new Response(JSON.stringify({ bid: null, ask: null, last: null }), { status: 200 });
    }) as unknown as typeof fetch;

    const marks = createTradeHttpMarkSource({
      baseUrl: 'http://trade.test',
      fetchImpl,
      marketsLimit: MARKETS_LIMIT,
    });
    expect(marks.kind).toBe('live');
    const q = await marks.quote(MARKET_ID);
    expect(q.kind).toBe('unavailable');
    if (q.kind === 'unavailable') expect(q.reason).toBe('stale');
  });

  it('a 200 JSON null ticker returns the unavailable refusal and does not throw', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (isMarketsList(u)) {
        return new Response(JSON.stringify([{ id: MARKET_ID, symbol: SYMBOL }]), { status: 200 });
      }
      return new Response(JSON.stringify(null), { status: 200 });
    }) as unknown as typeof fetch;

    const marks = createTradeHttpMarkSource({
      baseUrl: 'http://trade.test',
      fetchImpl,
      marketsLimit: MARKETS_LIMIT,
    });
    const q = await marks.quote(MARKET_ID);
    expect(q).toEqual({
      kind: 'unavailable',
      reason: 'stale',
      detail: 'trade ticker has no usable bid/ask/last',
    });
  });

  it('resolves marketId → symbol → mid and never invents on HTTP failure', async () => {
    const now = new Date('2026-08-14T00:00:00Z');
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (isMarketsList(u)) {
        expect(u).toBe(`http://trade.test/api/v1/markets?limit=${MARKETS_LIMIT}`);
        return new Response(JSON.stringify([{ id: MARKET_ID, symbol: SYMBOL }]), { status: 200 });
      }
      if (u.includes('/api/v1/ticker/')) {
        return new Response(JSON.stringify({ bid: '100', ask: '102', last: '101', timestamp: now.getTime() }), { status: 200 });
      }
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;

    const marks = createTradeHttpMarkSource({
      baseUrl: 'http://trade.test/',
      fetchImpl,
      marketsLimit: MARKETS_LIMIT,
    });
    const ok = await marks.quote(MARKET_ID, now);
    expect(ok).toEqual({
      kind: 'ok',
      price: '101',
      at: now,
    });

    // Unknown market id → refuse, no second invent path
    const miss = await marks.quote('22222222-2222-2222-2222-222222222222', now);
    expect(miss.kind).toBe('unavailable');
  });

  it('refuses a ticker whose timestamp is older than the bank marking window', async () => {
    const now = new Date('2026-08-14T00:10:00Z');
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (isMarketsList(u)) {
        return new Response(JSON.stringify([{ id: MARKET_ID, symbol: SYMBOL }]), { status: 200 });
      }
      return new Response(JSON.stringify({ bid: '200', ask: '200', last: '200', timestamp: now.getTime() - 301_000 }), { status: 200 });
    }) as unknown as typeof fetch;

    const marks = createTradeHttpMarkSource({
      baseUrl: 'http://trade.test',
      fetchImpl,
      marketsLimit: MARKETS_LIMIT,
    });
    const q = await marks.quote(MARKET_ID, now);
    expect(q).toMatchObject({ kind: 'unavailable', reason: 'stale' });

    const notifyStore = new MemoryNotifyStore();
    const alerts = new AlertService(
      new MemoryAlertStore(),
      marks,
      new NotifyService(notifyStore, { fanoutEnabled: true }),
      undefined,
      TEST_ALERT_LIMITS,
    );
    await alerts.create({
      userId: 'u1',
      marketId: MARKET_ID,
      direction: 'above',
      targetPrice: '150',
    });
    const report = await alerts.evaluateDueAlerts(now);
    expect(report.fired).toBe(0);
    expect(report.refused).toBe(1);
    expect(report.refusals).toEqual({ 'alert.price_unavailable': 1 });
    expect(await notifyStore.unreadCount('u1')).toBe(0);
  });

  it('fires a one-shot watch when trade mid crosses the target', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (isMarketsList(u)) {
        return new Response(JSON.stringify([{ id: MARKET_ID, symbol: SYMBOL }]), { status: 200 });
      }
      return new Response(JSON.stringify({ bid: '200', ask: '200', last: '200' }), { status: 200 });
    }) as unknown as typeof fetch;

    const store = new MemoryAlertStore();
    const notifyStore = new MemoryNotifyStore();
    const notify = new NotifyService(notifyStore, { fanoutEnabled: true });
    const marks = createTradeHttpMarkSource({
      baseUrl: 'http://trade.test',
      fetchImpl,
      marketsLimit: MARKETS_LIMIT,
    });
    const alerts = new AlertService(store, marks, notify, undefined, TEST_ALERT_LIMITS);

    expect(alerts.evaluationStatus()).toEqual({
      markSource: 'live',
      canFire: true,
      code: null,
    });

    const watch = await alerts.create({
      userId: 'u1',
      marketId: MARKET_ID,
      direction: 'above',
      targetPrice: '150',
    });
    expect(watch.status).toBe('active');

    const report = await alerts.evaluateDueAlerts(new Date());
    expect(report.fired).toBe(1);
    expect(report.refused).toBe(0);
    expect(await notifyStore.unreadCount('u1')).toBe(1);

    const after = await store.list('u1');
    expect(after[0]?.status).toBe('fired');
  });

  it('refuses when markets list is down — does not invent a symbol', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const marks = createTradeHttpMarkSource({
      baseUrl: 'http://trade.test',
      fetchImpl,
      marketsLimit: MARKETS_LIMIT,
    });
    const q = await marks.quote(MARKET_ID);
    expect(q).toMatchObject({ kind: 'unavailable', reason: 'refused' });
    if (q.kind === 'unavailable') {
      expect(q.detail).toMatch(/unreachable/);
    }
  });

  it('omit marketsLimit refuses notify.markets_list_limit_unset — never invent 50 or fetch', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('must not fetch');
    }) as unknown as typeof fetch;

    const marks = createTradeHttpMarkSource({ baseUrl: 'http://trade.test', fetchImpl });
    const q = await marks.quote(MARKET_ID);
    expect(q).toEqual({
      kind: 'unavailable',
      reason: 'refused',
      detail: NOTIFY_MARKETS_LIST_LIMIT_UNSET,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('owner-published 500 reaches the query string', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(String(url)).toBe('http://trade.test/api/v1/markets?limit=500');
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    const marks = createTradeHttpMarkSource({
      baseUrl: 'http://trade.test',
      fetchImpl,
      marketsLimit: 500,
    });
    const q = await marks.quote(MARKET_ID);
    expect(q.kind).toBe('unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('markets HTTP 400 stays failure — never invents a mark', async () => {
    const fetchImpl = vi.fn(async () => new Response('limit required', { status: 400 })) as unknown as typeof fetch;
    const marks = createTradeHttpMarkSource({
      baseUrl: 'http://trade.test',
      fetchImpl,
      marketsLimit: MARKETS_LIMIT,
    });
    const q = await marks.quote(MARKET_ID);
    expect(q).toMatchObject({ kind: 'unavailable', reason: 'refused' });
    if (q.kind === 'unavailable') {
      expect(q.detail).toMatch(/unreachable/);
      expect(q.detail).not.toBe(NOTIFY_MARKETS_LIST_LIMIT_UNSET);
    }
  });
});
