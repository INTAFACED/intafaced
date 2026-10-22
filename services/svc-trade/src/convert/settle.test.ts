import { describe, expect, it } from 'vitest';
import { formatAmount, MemoryLedger, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import { acceptConvertQuote, buildFirmConvertQuote, estimateConvert } from './quote.js';
import { planConvertSettle, postConvertSettle } from './settle.js';
import { convertSettleIdsFor } from './ids.js';

const USER = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-08-26T12:00:00.000Z');
const ACCEPT_AT = new Date('2026-08-26T12:00:01.000Z');

function boundBuy() {
  const estimate = estimateConvert({
    side: 'buy',
    qty: parseAmount('1'),
    levels: [['100', '5']],
    convertSpreadBps: 100,
    tickSize: parseAmount('0.01'),
  });
  const quote = buildFirmConvertQuote({
    quoteId: 'q-convert-settle',
    userId: USER,
    symbol: 'BTC/USDT',
    marketId: 'm1',
    side: 'buy',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    requestedQty: parseAmount('1'),
    estimate,
    convertSpreadBps: 100,
    source: { kind: 'book', symbol: 'BTC/USDT', asOf: NOW.toISOString() },
    now: NOW,
    quoteTtlMs: 15_000,
  });
  return acceptConvertQuote({ quote, now: ACCEPT_AT });
}

describe('planConvertSettle / postConvertSettle', () => {
  it('posts house inventory first at the bound quoted notional (not a book fill)', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: parseAmount('10'), seedId: 'cvt-btc' }));
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('1000'), rail: 'test', railRef: 'cvt-u' }));

    const bound = boundBuy();
    expect(bound.fillNotional).toBe(bound.quote.userNotional);
    expect(bound.fillPrice).toBe(bound.quote.avgPrice);
    const ids = convertSettleIdsFor(bound.quote.quoteId);
    const plan = planConvertSettle({ bound, ...ids, now: ACCEPT_AT });
    expect(plan.fill.entries.length).toBeGreaterThan(0);
    expect(plan.fill.reason).toBe('trade.fill.mm_maker');
    expect(plan.hold.reason).toBe('order.hold');
    expect(plan.mmHold.reason).toBe('order.hold.mm');
    await postConvertSettle(ledger, plan);

    expect(formatAmount((await ledger.balance(userAvailable(USER, 'BTC'))).amount)).toBe('1');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('settle keys are stable for the same quote id', () => {
    expect(convertSettleIdsFor('q-a')).toEqual(convertSettleIdsFor('q-a'));
    expect(convertSettleIdsFor('q-a').fillId).not.toBe(convertSettleIdsFor('q-b').fillId);
  });

  it('planConvertSettle now past expiresAt refuses even if bound', () => {
    const bound = boundBuy();
    const ids = convertSettleIdsFor(bound.quote.quoteId);
    try {
      planConvertSettle({ bound, ...ids, now: new Date('2026-08-26T12:00:16.000Z') });
      throw new Error('should have refused expired bound quote');
    } catch (err) {
      expect((err as { code: string }).code).toBe('trade.convert_quote_expired');
    }
  });
});
