/**
 * Unit card — whale flow mark (allow-list + sourced volume, never invent)
 * 1. Promise: v22.alerts whale kind — refuse `alerts.whale_mark_dark` without
 *    a sourced flow; fire only when env allow-list + ticker volume exist
 * 2. Break: reuse price mid/last as volume; empty allow-list quotes ok; missing
 *    volume becomes `'0'`
 * 3. Done bar: dark source; allow-list miss → unavailable; quoteVolume else
 *    baseVolume; empty/zero volume refuses
 * 4. Class N
 * 5. Paths: services/svc-notify/src/alerts/whale-mark.ts
 * 6. RED: this suite
 * 7. Collision: none
 */

import { describe, expect, it, vi } from 'vitest';
import { NOTIFY_MARKETS_LIST_LIMIT_UNSET } from './trade-http-mark.js';
import { createDarkWhaleMarkSource, createTradeHttpWhaleMarkSource, flowFromTicker, parseWhaleFlowAllowlist } from './whale-mark.js';

const MARKET_ID = '11111111-1111-1111-1111-111111111111';
const SYMBOL = 'BTC/USDT';
const OTHER_ID = '22222222-2222-2222-8222-222222222222';
/** Owner-explicit page size — never a silent 50. */
const MARKETS_LIMIT = 100;

function isMarketsList(url: string): boolean {
  return url.includes('/api/v1/markets?limit=');
}

describe('parseWhaleFlowAllowlist', () => {
  it('blank / unset is empty — never a wildcard all-markets claim', () => {
    expect(parseWhaleFlowAllowlist(undefined)).toEqual([]);
    expect(parseWhaleFlowAllowlist(null)).toEqual([]);
    expect(parseWhaleFlowAllowlist('')).toEqual([]);
    expect(parseWhaleFlowAllowlist('  ,  ')).toEqual([]);
  });

  it('splits, trims, and dedupes exact market ids', () => {
    expect(parseWhaleFlowAllowlist(`${MARKET_ID}, ${OTHER_ID},${MARKET_ID}`)).toEqual([MARKET_ID, OTHER_ID]);
  });
});

describe('flowFromTicker — sourced volume, never invent', () => {
  it('prefers quoteVolume, falls back to baseVolume, refuses empty/zero', () => {
    expect(flowFromTicker({ quoteVolume: '1500.5', baseVolume: '9' })).toBe('1500.5');
    expect(flowFromTicker({ quoteVolume: null, baseVolume: '9' })).toBe('9');
    expect(flowFromTicker({ quoteVolume: null, baseVolume: null })).toBeNull();
    expect(flowFromTicker({ quoteVolume: '0', baseVolume: '0' })).toBeNull();
  });
});

describe('createDarkWhaleMarkSource', () => {
  it('is dark wiring and quotes unavailable — never an invented flow', async () => {
    const marks = createDarkWhaleMarkSource();
    expect(marks.kind).toBe('dark');
    const q = await marks.quote(MARKET_ID);
    expect(q).toMatchObject({ kind: 'unavailable', reason: 'dark' });
  });
});

describe('createTradeHttpWhaleMarkSource', () => {
  it('quotes sourced volume for an allow-listed market and refuses the rest', async () => {
    const now = new Date('2026-08-23T00:00:00Z');
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (isMarketsList(u)) {
        expect(u).toBe(`http://trade.test/api/v1/markets?limit=${MARKETS_LIMIT}`);
        return new Response(JSON.stringify([{ id: MARKET_ID, symbol: SYMBOL }]), { status: 200 });
      }
      if (u.includes('/api/v1/ticker/')) {
        return new Response(JSON.stringify({ quoteVolume: '2500', last: '101', timestamp: now.getTime() }), { status: 200 });
      }
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;

    const marks = createTradeHttpWhaleMarkSource({
      baseUrl: 'http://trade.test/',
      allowlist: [MARKET_ID],
      fetchImpl,
      marketsLimit: MARKETS_LIMIT,
    });
    expect(marks.kind).toBe('live');
    expect(await marks.quote(MARKET_ID, now)).toEqual({ kind: 'ok', price: '2500', at: now });
    const skipped = await marks.quote(OTHER_ID, now);
    expect(skipped.kind).toBe('unavailable');
    if (skipped.kind === 'unavailable') expect(skipped.reason).toBe('dark');
  });

  it('refuses a ticker with price but no volume — never treats last as flow', async () => {
    const now = new Date('2026-08-23T00:00:00Z');
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (isMarketsList(u)) {
        return new Response(JSON.stringify([{ id: MARKET_ID, symbol: SYMBOL }]), { status: 200 });
      }
      return new Response(JSON.stringify({ bid: '100', ask: '102', last: '101', timestamp: now.getTime() }), { status: 200 });
    }) as unknown as typeof fetch;

    const marks = createTradeHttpWhaleMarkSource({
      baseUrl: 'http://trade.test',
      allowlist: [MARKET_ID],
      fetchImpl,
      marketsLimit: MARKETS_LIMIT,
    });
    const q = await marks.quote(MARKET_ID, now);
    expect(q.kind).toBe('unavailable');
    if (q.kind === 'unavailable') {
      expect(q.detail).toMatch(/quoteVolume\/baseVolume/);
    }
  });

  it('a 200 JSON null whale ticker returns the unavailable refusal and does not throw', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (isMarketsList(u)) {
        return new Response(JSON.stringify([{ id: MARKET_ID, symbol: SYMBOL }]), { status: 200 });
      }
      return new Response(JSON.stringify(null), { status: 200 });
    }) as unknown as typeof fetch;

    const marks = createTradeHttpWhaleMarkSource({
      baseUrl: 'http://trade.test',
      allowlist: [MARKET_ID],
      fetchImpl,
      marketsLimit: MARKETS_LIMIT,
    });
    const q = await marks.quote(MARKET_ID);
    expect(q).toEqual({
      kind: 'unavailable',
      reason: 'stale',
      detail: 'trade ticker has no usable quoteVolume/baseVolume',
    });
  });

  it('omit marketsLimit refuses notify.markets_list_limit_unset — never invent 50 or fetch', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('must not fetch');
    }) as unknown as typeof fetch;

    const marks = createTradeHttpWhaleMarkSource({
      baseUrl: 'http://trade.test',
      allowlist: [MARKET_ID],
      fetchImpl,
    });
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

    const marks = createTradeHttpWhaleMarkSource({
      baseUrl: 'http://trade.test',
      allowlist: [MARKET_ID],
      fetchImpl,
      marketsLimit: 500,
    });
    const q = await marks.quote(MARKET_ID);
    expect(q.kind).toBe('unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('markets HTTP 400 stays failure — never invents flow', async () => {
    const fetchImpl = vi.fn(async () => new Response('limit required', { status: 400 })) as unknown as typeof fetch;
    const marks = createTradeHttpWhaleMarkSource({
      baseUrl: 'http://trade.test',
      allowlist: [MARKET_ID],
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
