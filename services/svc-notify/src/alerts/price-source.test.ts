/**
 * J-charts-desk-09 #2: a price alert is evaluated against the price the person chose (bid, ask, last, or the mark). A side the
 * ticker does not carry refuses `notify.price_source_unavailable` and never falls back to another side. The sweep quotes once per
 * source a market's alerts need and evaluates each alert against its own.
 */

import { describe, expect, it, vi } from 'vitest';
import { NotifyService } from '../notify-service.js';
import { MemoryNotifyStore } from '../store.js';
import { AlertService } from './service.js';
import { AlertValidationError, MemoryAlertStore } from './store.js';
import { TEST_ALERT_LIMITS } from './test-limits.js';
import { createTradeHttpMarkSource, NOTIFY_PRICE_SOURCE_UNAVAILABLE, priceFromTicker, priceFromTickerSource } from './trade-http-mark.js';
import type { AlertPriceSource, MarkQuote, MarkSource } from './types.js';

const MARKET_ID = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-10-31T12:00:00Z');

describe('priceFromTickerSource', () => {
  it('reads only the side named', () => {
    const body = { bid: '99', ask: '101', last: '100.25' };
    expect(priceFromTickerSource(body, 'bid')).toEqual({ price: '99', quality: 'bid' });
    expect(priceFromTickerSource(body, 'ask')).toEqual({ price: '101', quality: 'ask' });
    expect(priceFromTickerSource(body, 'last')).toEqual({ price: '100.25', quality: 'last' });
  });

  it('mark is the mid-else-last rule exactly', () => {
    for (const body of [
      { bid: '99', ask: '101', last: '7' },
      { bid: null, ask: '101', last: '7' },
      { bid: null, ask: null, last: null },
    ]) {
      expect(priceFromTickerSource(body, 'mark')).toEqual(priceFromTicker(body));
    }
  });

  it('a missing or invalid side is null, never another side', () => {
    expect(priceFromTickerSource({ bid: null, ask: '101', last: '100' }, 'bid')).toBeNull();
    expect(priceFromTickerSource({ bid: '99', ask: undefined, last: '100' }, 'ask')).toBeNull();
    expect(priceFromTickerSource({ bid: '99', ask: '101', last: null }, 'last')).toBeNull();
    expect(priceFromTickerSource({ bid: '0', ask: '-1', last: 'abc' }, 'bid')).toBeNull();
    expect(priceFromTickerSource({ bid: '0', ask: '-1', last: 'abc' }, 'ask')).toBeNull();
    expect(priceFromTickerSource({ bid: '0', ask: '-1', last: 'abc' }, 'last')).toBeNull();
  });
});

function tradeSource(ticker: Record<string, unknown>): MarkSource {
  const fetchImpl = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/api/v1/markets?limit=')) return new Response(JSON.stringify([{ id: MARKET_ID, symbol: 'BTC/USDT' }]), { status: 200 });
    return new Response(JSON.stringify({ ...ticker, timestamp: NOW.getTime() }), { status: 200 });
  }) as unknown as typeof fetch;
  return createTradeHttpMarkSource({ baseUrl: 'http://trade.test', fetchImpl, marketsLimit: 100 });
}

describe('trade ticker MarkSource by source', () => {
  it('quotes bid, ask and last from the ticker, and mark as before', async () => {
    const marks = tradeSource({ bid: '99', ask: '101', last: '100.25' });
    expect(await marks.quote(MARKET_ID, NOW, 'bid')).toEqual({ kind: 'ok', price: '99', at: NOW });
    expect(await marks.quote(MARKET_ID, NOW, 'ask')).toEqual({ kind: 'ok', price: '101', at: NOW });
    expect(await marks.quote(MARKET_ID, NOW, 'last')).toEqual({ kind: 'ok', price: '100.25', at: NOW });
    expect(await marks.quote(MARKET_ID, NOW, 'mark')).toEqual({ kind: 'ok', price: '100', at: NOW });
    expect(await marks.quote(MARKET_ID, NOW)).toEqual({ kind: 'ok', price: '100', at: NOW });
  });

  it.each([
    ['bid', { ask: '101', last: '100' }],
    ['ask', { bid: '99', last: '100' }],
    ['last', { bid: '99', ask: '101' }],
  ] as const)('a ticker without %s refuses by code and does not fall back', async (source, ticker) => {
    const marks = tradeSource(ticker);
    expect(await marks.quote(MARKET_ID, NOW, source)).toEqual({
      kind: 'unavailable',
      reason: 'refused',
      detail: NOTIFY_PRICE_SOURCE_UNAVAILABLE,
    });
    // The mark still prices this ticker; only the side asked for is missing.
    expect((await marks.quote(MARKET_ID, NOW, 'mark')).kind).toBe('ok');
  });

  it('the refusal code is the stable string', () => {
    expect(NOTIFY_PRICE_SOURCE_UNAVAILABLE).toBe('notify.price_source_unavailable');
  });
});

/** A live source with a fixed price per side; `null` is a side the book does not have. Counts calls per source. */
function sidedSource(prices: Record<AlertPriceSource, string | null>) {
  const calls: (AlertPriceSource | undefined)[] = [];
  const marks: MarkSource = {
    kind: 'live',
    async quote(_marketId, at, source): Promise<MarkQuote> {
      calls.push(source);
      const price = prices[source ?? 'mark'];
      return price === null
        ? { kind: 'unavailable', reason: 'refused', detail: NOTIFY_PRICE_SOURCE_UNAVAILABLE }
        : { kind: 'ok', price, at: at ?? NOW };
    },
  };
  return { marks, calls };
}

function rig(prices: Record<AlertPriceSource, string | null>) {
  const { marks, calls } = sidedSource(prices);
  const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
  const store = new MemoryAlertStore();
  return { alerts: new AlertService(store, marks, notify, undefined, TEST_ALERT_LIMITS), store, calls };
}

const above = (source?: AlertPriceSource) => ({
  userId: 'u1',
  marketId: 'BTC-USD',
  direction: 'above' as const,
  targetPrice: '100.5',
  condition: 'greater_than' as const,
  ...(source ? { source } : {}),
});

describe('sweep by source', () => {
  it('two alerts on one market: at or above 100.5 fires on the ask (101) and holds on the bid (99)', async () => {
    const { alerts, calls } = rig({ mark: '100', bid: '99', ask: '101', last: '100' });
    const onBid = await alerts.create(above('bid'), NOW);
    const onAsk = await alerts.create(above('ask'), NOW);
    const report = await alerts.evaluateMarket('BTC-USD', NOW);
    expect(report.mark).toBe('100');
    const byId = new Map(report.results.map((r) => [r.alertId, r.outcome]));
    expect(byId.get(onBid.id)).toMatchObject({ kind: 'hold', markPrice: '99' });
    expect(byId.get(onAsk.id)).toMatchObject({ kind: 'fire', markPrice: '101' });
    expect((await alerts.get('u1', onAsk.id))!.status).toBe('fired');
    expect((await alerts.get('u1', onBid.id))!.status).toBe('active');
    // One quote for the mark and one per source the alerts chose, not one per alert.
    expect(calls.sort()).toEqual(['ask', 'bid', undefined].sort());
  });

  it('quotes a shared source once however many alerts chose it', async () => {
    const { alerts, calls } = rig({ mark: '100', bid: '99', ask: '101', last: '100' });
    await alerts.create(above('ask'), NOW);
    await alerts.create(above('ask'), NOW);
    await alerts.create(above(), NOW);
    const report = await alerts.evaluateMarket('BTC-USD', NOW);
    expect(report.results.filter((r) => r.outcome.kind === 'fire')).toHaveLength(2);
    expect(calls.filter((c) => c === 'ask')).toHaveLength(1);
    expect(calls.filter((c) => c === undefined)).toHaveLength(1);
  });

  it('a missing side refuses its alert by code; an alert on another source on the same market still evaluates', async () => {
    const { alerts } = rig({ mark: '100', bid: null, ask: '101', last: '100' });
    const onBid = await alerts.create(above('bid'), NOW);
    const onAsk = await alerts.create(above('ask'), NOW);
    const report = await alerts.evaluateDueAlerts(NOW);
    expect(report).toMatchObject({ fired: 1, refused: 1, refusals: { 'alert.price_unavailable': 1 } });
    const evaluated = await alerts.evaluateAlert('u1', onBid.id, NOW);
    expect(evaluated.outcome).toMatchObject({ kind: 'refuse', code: 'alert.price_unavailable', detail: NOTIFY_PRICE_SOURCE_UNAVAILABLE });
    expect((await alerts.get('u1', onBid.id))!.status).toBe('active');
    expect((await alerts.get('u1', onAsk.id))!.status).toBe('fired');
  });

  it('evaluateAlert uses the alert own source', async () => {
    const { alerts, calls } = rig({ mark: '100', bid: '99', ask: '101', last: '100' });
    const onAsk = await alerts.create(above('ask'), NOW);
    const report = await alerts.evaluateAlert('u1', onAsk.id, NOW);
    expect(report.outcome).toMatchObject({ kind: 'fire', markPrice: '101' });
    expect(calls).toEqual(['ask']);
  });
});

describe('memory store source round-trip', () => {
  it('defaults to mark, stores the chosen one, edits it, and keeps it through an edit that does not name it', async () => {
    const { alerts } = rig({ mark: '100', bid: '99', ask: '101', last: '100' });
    expect((await alerts.create(above(), NOW)).source).toBe('mark');
    const row = await alerts.create(above('last'), NOW);
    expect(row.source).toBe('last');
    expect((await alerts.edit('u1', row.id, { source: 'bid' }, NOW))!.source).toBe('bid');
    expect((await alerts.edit('u1', row.id, { targetPrice: '120' }, NOW))!.source).toBe('bid');
    expect((await alerts.get('u1', row.id))!.source).toBe('bid');
    const many = await alerts.createMany({ ...above('ask'), marketIds: ['ETH-USD', 'SOL-USD'] }, NOW);
    expect(many.map((a) => a.source)).toEqual(['ask', 'ask']);
  });

  it('refuses a source outside the four on create and on edit, writing nothing', async () => {
    const { alerts, store } = rig({ mark: '100', bid: '99', ask: '101', last: '100' });
    await expect(alerts.create({ ...above(), source: 'mid' as never }, NOW)).rejects.toBeInstanceOf(AlertValidationError);
    expect(await store.list('u1')).toEqual([]);
    const row = await alerts.create(above('ask'), NOW);
    await expect(alerts.edit('u1', row.id, { source: 'mid' as never }, NOW)).rejects.toMatchObject({ code: 'alert.invalid_source' });
    expect((await alerts.get('u1', row.id))!.source).toBe('ask');
  });
});
