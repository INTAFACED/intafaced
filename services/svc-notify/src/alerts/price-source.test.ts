/**
 * J-charts-desk-09 #2: a price alert is evaluated against the price the person chose (bid, ask, last, or the mark). A side the
 * ticker does not carry refuses `notify.price_source_unavailable` and never falls back to another side. The sweep reads every
 * side a market's alerts need in one call, and a port that cannot name a side refuses every alert on one.
 */

import { describe, expect, it, vi } from 'vitest';
import { NotifyService } from '../notify-service.js';
import { MemoryNotifyStore } from '../store.js';
import { AlertService } from './service.js';
import { AlertValidationError, MemoryAlertStore } from './store.js';
import { TEST_ALERT_LIMITS } from './test-limits.js';
import { createTradeHttpMarkSource, priceFromTickerSide } from './trade-http-mark.js';
import { NOTIFY_PRICE_SOURCE_UNAVAILABLE } from './types.js';
import type { AlertPriceSide, AlertPriceSource, MarkQuote, MarkSource } from './types.js';

const MARKET_ID = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-10-31T12:00:00Z');
const REFUSED: MarkQuote = { kind: 'unavailable', reason: 'refused', detail: NOTIFY_PRICE_SOURCE_UNAVAILABLE };

describe('priceFromTickerSide', () => {
  it('reads only the side named', () => {
    const body = { bid: '99', ask: '101', last: '100.25' };
    expect(priceFromTickerSide(body, 'bid')).toEqual({ price: '99', quality: 'bid' });
    expect(priceFromTickerSide(body, 'ask')).toEqual({ price: '101', quality: 'ask' });
    expect(priceFromTickerSide(body, 'last')).toEqual({ price: '100.25', quality: 'last' });
  });

  it('a missing or invalid side is null, never another side', () => {
    expect(priceFromTickerSide({ bid: null, ask: '101', last: '100' }, 'bid')).toBeNull();
    expect(priceFromTickerSide({ bid: '99', ask: undefined, last: '100' }, 'ask')).toBeNull();
    expect(priceFromTickerSide({ bid: '99', ask: '101', last: null }, 'last')).toBeNull();
    expect(priceFromTickerSide({ bid: '0', ask: '-1', last: 'abc' }, 'bid')).toBeNull();
    expect(priceFromTickerSide({ bid: '0', ask: '-1', last: 'abc' }, 'ask')).toBeNull();
    expect(priceFromTickerSide({ bid: '0', ask: '-1', last: 'abc' }, 'last')).toBeNull();
  });
});

function tradeSource(ticker: Record<string, unknown> | null) {
  const tickerReads: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/api/v1/markets?limit=')) return new Response(JSON.stringify([{ id: MARKET_ID, symbol: 'BTC/USDT' }]), { status: 200 });
    tickerReads.push(u);
    return new Response(JSON.stringify(ticker === null ? null : { ...ticker, timestamp: NOW.getTime() }), { status: 200 });
  }) as unknown as typeof fetch;
  return { marks: createTradeHttpMarkSource({ baseUrl: 'http://trade.test', fetchImpl, marketsLimit: 100 }), tickerReads };
}

describe('trade ticker MarkSource by side', () => {
  it('quotes bid, ask and last from one ticker read, and the mark as before', async () => {
    const { marks, tickerReads } = tradeSource({ bid: '99', ask: '101', last: '100.25' });
    const sides = await marks.quoteSides!(MARKET_ID, ['bid', 'ask', 'last'], NOW);
    expect(tickerReads).toHaveLength(1);
    expect(sides.get('bid')).toEqual({ kind: 'ok', price: '99', at: NOW });
    expect(sides.get('ask')).toEqual({ kind: 'ok', price: '101', at: NOW });
    expect(sides.get('last')).toEqual({ kind: 'ok', price: '100.25', at: NOW });
    expect(await marks.quote(MARKET_ID, NOW)).toEqual({ kind: 'ok', price: '100', at: NOW });
  });

  it.each([
    ['bid', { ask: '101', last: '100' }],
    ['ask', { bid: '99', last: '100' }],
    ['last', { bid: '99', ask: '101' }],
  ] as const)('a ticker without %s refuses by code and does not fall back', async (side, ticker) => {
    const { marks } = tradeSource(ticker);
    expect((await marks.quoteSides!(MARKET_ID, [side], NOW)).get(side)).toEqual(REFUSED);
    // The mark still prices this ticker; only the side asked for is missing.
    expect((await marks.quote(MARKET_ID, NOW)).kind).toBe('ok');
  });

  it('a ticker read that fails refuses every side with its own reason, and asking for no side reads nothing', async () => {
    const { marks, tickerReads } = tradeSource(null);
    const sides = await marks.quoteSides!(MARKET_ID, ['bid', 'ask'], NOW);
    expect(sides.get('bid')).toEqual(REFUSED);
    expect(sides.get('ask')).toEqual(REFUSED);
    expect((await marks.quoteSides!(MARKET_ID, [], NOW)).size).toBe(0);
    expect(tickerReads).toHaveLength(1);
    const unknown = await marks.quoteSides!('22222222-2222-2222-2222-222222222222', ['bid'], NOW);
    expect(unknown.get('bid')).toMatchObject({
      kind: 'unavailable',
      reason: 'refused',
      detail: expect.stringContaining('no trade market'),
    });
  });

  it('the refusal code is the stable string', () => {
    expect(NOTIFY_PRICE_SOURCE_UNAVAILABLE).toBe('notify.price_source_unavailable');
  });
});

/**
 * A live source with a fixed price per side; `null` is a side the book does not have. Records each mark call and each
 * `quoteSides` call. `sides: false` builds a port that cannot name a side at all.
 */
function sidedSource(prices: Record<AlertPriceSource, string | null>, sides = true) {
  const markCalls: number[] = [];
  const sideCalls: (readonly AlertPriceSide[])[] = [];
  const priced = (price: string | null, at?: Date): MarkQuote => (price === null ? REFUSED : { kind: 'ok', price, at: at ?? NOW });
  const marks: MarkSource = {
    kind: 'live',
    async quote(_marketId: string, at?: Date): Promise<MarkQuote> {
      markCalls.push(1);
      return priced(prices.mark, at);
    },
    ...(sides
      ? {
          async quoteSides(_marketId: string, asked: readonly AlertPriceSide[], at?: Date) {
            sideCalls.push([...asked]);
            return new Map(asked.map((side) => [side, priced(prices[side], at)] as const));
          },
        }
      : {}),
  };
  return { marks, markCalls, sideCalls };
}

function rig(prices: Record<AlertPriceSource, string | null>, sides = true) {
  const { marks, markCalls, sideCalls } = sidedSource(prices, sides);
  const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
  const store = new MemoryAlertStore();
  return { alerts: new AlertService(store, marks, notify, undefined, TEST_ALERT_LIMITS), store, markCalls, sideCalls };
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
    const { alerts, markCalls, sideCalls } = rig({ mark: '100', bid: '99', ask: '101', last: '100' });
    const onBid = await alerts.create(above('bid'), NOW);
    const onAsk = await alerts.create(above('ask'), NOW);
    const report = await alerts.evaluateMarket('BTC-USD', NOW);
    expect(report.mark).toBe('100');
    const byId = new Map(report.results.map((r) => [r.alertId, r.outcome]));
    expect(byId.get(onBid.id)).toMatchObject({ kind: 'hold', markPrice: '99' });
    expect(byId.get(onAsk.id)).toMatchObject({ kind: 'fire', markPrice: '101' });
    expect((await alerts.get('u1', onAsk.id))!.status).toBe('fired');
    expect((await alerts.get('u1', onBid.id))!.status).toBe('active');
    // One mark quote and one read for every side the alerts chose, not one per alert or per side.
    expect(markCalls).toHaveLength(1);
    expect(sideCalls).toHaveLength(1);
    expect([...sideCalls[0]!].sort()).toEqual(['ask', 'bid']);
  });

  it('asks for a shared side once however many alerts chose it, and for no side when every alert is on the mark', async () => {
    const { alerts, sideCalls } = rig({ mark: '100', bid: '99', ask: '101', last: '100' });
    await alerts.create(above('ask'), NOW);
    await alerts.create(above('ask'), NOW);
    await alerts.create(above(), NOW);
    const report = await alerts.evaluateMarket('BTC-USD', NOW);
    expect(report.results.filter((r) => r.outcome.kind === 'fire')).toHaveLength(2);
    expect(sideCalls).toEqual([['ask']]);

    const onlyMark = rig({ mark: '101', bid: '99', ask: '101', last: '100' });
    await onlyMark.alerts.create(above(), NOW);
    await onlyMark.alerts.evaluateMarket('BTC-USD', NOW);
    expect(onlyMark.sideCalls).toEqual([]);
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

  it('a port that cannot name a side refuses every alert on one, even when the mark would fire it; mark alerts still evaluate', async () => {
    // The mark (101) is past 100.5, so a fallback to it would fire the bid alert. It must refuse instead.
    const { alerts, markCalls } = rig({ mark: '101', bid: '99', ask: '101', last: '100' }, false);
    const onBid = await alerts.create(above('bid'), NOW);
    const onMark = await alerts.create(above(), NOW);
    const report = await alerts.evaluateMarket('BTC-USD', NOW);
    const byId = new Map(report.results.map((r) => [r.alertId, r.outcome]));
    expect(byId.get(onBid.id)).toMatchObject({ kind: 'refuse', code: 'alert.price_unavailable', detail: NOTIFY_PRICE_SOURCE_UNAVAILABLE });
    expect(byId.get(onMark.id)).toMatchObject({ kind: 'fire', markPrice: '101' });
    expect((await alerts.get('u1', onBid.id))!.status).toBe('active');
    expect(markCalls).toHaveLength(1);
    const single = await alerts.evaluateAlert('u1', onBid.id, NOW);
    expect(single.outcome).toMatchObject({ kind: 'refuse', detail: NOTIFY_PRICE_SOURCE_UNAVAILABLE });
  });

  it('evaluateAlert uses the alert own source', async () => {
    const { alerts, markCalls, sideCalls } = rig({ mark: '100', bid: '99', ask: '101', last: '100' });
    const onAsk = await alerts.create(above('ask'), NOW);
    const report = await alerts.evaluateAlert('u1', onAsk.id, NOW);
    expect(report.outcome).toMatchObject({ kind: 'fire', markPrice: '101' });
    expect(sideCalls).toEqual([['ask']]);
    expect(markCalls).toEqual([]);
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

  it('a kind other than price watches only the mark: a bid, ask or last source refuses on create and on edit', async () => {
    const { alerts, store } = rig({ mark: '100', bid: '99', ask: '101', last: '100' });
    await expect(alerts.create({ ...above('bid'), kind: 'whale' }, NOW)).rejects.toMatchObject({ code: 'alert.invalid_source' });
    expect(await store.list('u1')).toEqual([]);
    const whale = await alerts.create({ ...above(), kind: 'whale' }, NOW);
    expect(whale.source).toBe('mark');
    await expect(alerts.edit('u1', whale.id, { source: 'ask' }, NOW)).rejects.toMatchObject({ code: 'alert.invalid_source' });
    expect((await alerts.get('u1', whale.id))!.source).toBe('mark');
  });
});
