import { describe, expect, it } from 'vitest';
import { p2pFixture } from '../../../preview/fixtures/p2p';

const decimal = /^-?\d+(\.\d+)?$/;
const { offers, advertisers, fiats, methods, trade, appeal } = p2pFixture.rows;

describe('p2p fixture', () => {
  it('is sample data for p2p, with a plain note', () => {
    expect(p2pFixture.product).toBe('p2p');
    expect(p2pFixture.sample).toBe(true);
    expect(p2pFixture.note.length).toBeGreaterThan(10);
  });

  it('keeps every amount a decimal string, never a float', () => {
    for (const offer of offers) {
      for (const value of [offer.price, offer.available, offer.minFiat, offer.maxFiat]) expect(value).toMatch(decimal);
    }
    for (const value of [trade.amount, trade.price, trade.fiatAmount]) expect(value).toMatch(decimal);
  });

  it('has buy and sell offers for every currency and points every offer at a real advertiser, currency and method', () => {
    const advertiserIds = new Set(advertisers.map((a) => a.id));
    const fiatIds = new Set(fiats.map((f) => f.id));
    const methodIds = new Set(methods.map((m) => m.id));
    for (const fiat of fiats) {
      for (const side of ['buy', 'sell'] as const) {
        expect(
          offers.some((o) => o.fiat === fiat.id && o.side === side && o.asset === 'USDT'),
          `${fiat.id} ${side}`,
        ).toBe(true);
      }
    }
    for (const offer of offers) {
      expect(advertiserIds.has(offer.advertiserId)).toBe(true);
      expect(fiatIds.has(offer.fiat)).toBe(true);
      expect(offer.methods.length).toBeGreaterThan(0);
      for (const method of offer.methods) expect(methodIds.has(method)).toBe(true);
    }
    expect(new Set(offers.map((o) => o.id)).size).toBe(offers.length);
  });

  it('orders buy offers from cheapest and sell offers from best price', () => {
    const buy = offers
      .filter((o) => o.side === 'buy' && o.asset === 'USDT' && o.fiat === 'usd')
      .map((o) => BigInt(o.price.replace('.', '')));
    const sell = offers
      .filter((o) => o.side === 'sell' && o.asset === 'USDT' && o.fiat === 'usd')
      .map((o) => BigInt(o.price.replace('.', '')));
    expect(buy).toEqual([...buy].sort((a, b) => (a < b ? -1 : 1)));
    expect(sell).toEqual([...sell].sort((a, b) => (a > b ? -1 : 1)));
  });

  it('has merchant badges, and a trade and appeal that agree with each other', () => {
    expect(advertisers.some((a) => a.badge === 'top')).toBe(true);
    expect(advertisers.some((a) => a.badge === 'verified')).toBe(true);
    expect(advertisers.some((a) => a.badge === 'none')).toBe(true);
    expect(advertisers.some((a) => a.id === trade.advertiserId)).toBe(true);
    for (const state of ['awaiting-payment', 'payment-sent', 'released', 'appeal'] as const) {
      expect(trade.steps.some((s) => s.id === trade.stepFor[state])).toBe(true);
      expect(trade.chat[state].length).toBeGreaterThan(1);
    }
    expect(appeal.doneSteps).toBeLessThan(appeal.steps.length);
  });
});
