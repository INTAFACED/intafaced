import { describe, expect, it } from 'vitest';
import { formatAmount, marketMaker, MemoryLedger, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import { planOtcSettle, postOtcSettle } from './settle.js';
import { acceptOtcQuote, buildOtcQuote } from './rfq.js';
import { UNPUBLISHED_OTC_DESK_LAW, type OtcDeskLaw } from './desk-law.js';
import { OtcError } from './errors.js';

const USER = '00000000-0000-4000-8000-000000000001';

const published: OtcDeskLaw = {
  published: true,
  spreadBps: 100,
  minStake: parseAmount('100'),
  counterparty: 'platform',
  quoteTtlMs: 30_000,
  maxMidAgeSeconds: 60,
  // A zero desk minimum is an owner value: these quotes are not held by the CB-otc-07 minimum.
  minNotional: { USDT: 0n },
};

const publishedMaker: OtcDeskLaw = {
  ...published,
  counterparty: 'maker',
};

function boundBuy() {
  const q = buildOtcQuote({
    quoteId: 'q1',
    userId: USER,
    side: 'buy',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    qty: parseAmount('1'),
    midPrice: parseAmount('100'),
    spreadBps: 100,
    counterparty: 'platform',
    counterpartyId: 'platform:otc-desk',
    now: new Date('2026-08-07T10:00:00.000Z'),
    quoteTtlMs: 30_000,
  });
  return acceptOtcQuote({ quote: q, now: new Date('2026-08-07T10:00:01.000Z') });
}

function boundSell() {
  const q = buildOtcQuote({
    quoteId: 'q-sell',
    userId: USER,
    side: 'sell',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    qty: parseAmount('1'),
    midPrice: parseAmount('100'),
    spreadBps: 100,
    counterparty: 'platform',
    counterpartyId: 'platform:otc-desk',
    now: new Date('2026-08-07T10:00:00.000Z'),
    quoteTtlMs: 30_000,
  });
  return acceptOtcQuote({ quote: q, now: new Date('2026-08-07T10:00:01.000Z') });
}

describe('planOtcSettle / postOtcSettle', () => {
  it('refuses when desk law blank — no ledger posts planned', () => {
    const bound = boundBuy();
    expect(() =>
      planOtcSettle({
        law: UNPUBLISHED_OTC_DESK_LAW,
        bound,
        takerOrderId: 't1',
        makerOrderId: 'm1',
        fillId: 'f1',
      }),
    ).toThrow(OtcError);
  });

  it('refuses maker-routed settle until owner publishes routing recipe', () => {
    const bound = boundBuy();
    expect(() =>
      planOtcSettle({
        law: publishedMaker,
        bound: { ...bound, counterparty: 'maker' },
        takerOrderId: 't1',
        makerOrderId: 'm1',
        fillId: 'f1',
      }),
    ).toThrowError(/socket\.otc-maker-routing/);
  });

  it('posts hold + mm hold + fill via ledger-client only at bound quoted notional', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: parseAmount('10'), seedId: 'otc-btc' }));
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('1000'), rail: 'test', railRef: 'otc-fund' }));

    const bound = boundBuy();
    expect(formatAmount(bound.fillNotional)).toBe('101');

    const plan = planOtcSettle({
      law: published,
      bound,
      takerOrderId: 'taker-otc-1',
      makerOrderId: 'maker-otc-1',
      fillId: 'fill-otc-1',
    });

    expect(plan.fill.reason).toBe('trade.fill.mm_maker');
    expect(plan.fill.meta?.takerFeeBps).toBe(0);
    expect(plan.fill.meta?.makerFeeBps).toBe(0);

    await postOtcSettle(ledger, plan);

    expect(formatAmount((await ledger.balance(userAvailable(USER, 'BTC'))).amount)).toBe('1');
    expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe('101');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('sell-side settle moves base from taker and quote from house via recipes only', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'USDT', amount: parseAmount('1000'), seedId: 'otc-usdt' }));
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'BTC', amount: parseAmount('2'), rail: 'test', railRef: 'otc-btc-u' }));

    const bound = boundSell();
    // Sell at mid 100 / 100bps → taker receives mid*(1-spread) = 99 USDT
    expect(formatAmount(bound.fillNotional)).toBe('99');

    const plan = planOtcSettle({
      law: published,
      bound,
      takerOrderId: 'taker-otc-sell',
      makerOrderId: 'maker-otc-sell',
      fillId: 'fill-otc-sell',
    });

    await postOtcSettle(ledger, plan);

    expect(formatAmount((await ledger.balance(userAvailable(USER, 'BTC'))).amount)).toBe('1');
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('99');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  /**
   * House inventory shortfall must refuse BEFORE the customer hold posts.
   * mmHold is first on purpose — see settle.ts header.
   */
  it('inventory shortfall refuses with customer USDT untouched', async () => {
    const ledger = new MemoryLedger();
    // No BTC seed for the house — buy settle needs mmHold(BTC) first.
    await ledger.post(
      recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('1000'), rail: 'test', railRef: 'otc-fund-short' }),
    );

    const before = formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount);
    expect(before).toBe('1000');

    const bound = boundBuy();
    const plan = planOtcSettle({
      law: published,
      bound,
      takerOrderId: 'taker-short',
      makerOrderId: 'maker-short',
      fillId: 'fill-short',
    });

    await expect(postOtcSettle(ledger, plan)).rejects.toBeTruthy();
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('1000');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });
});
