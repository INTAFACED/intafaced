import { describe, expect, it } from 'vitest';
import { fakeMarket } from '../public-rest.js';
import { convertPairs } from './pairs.js';

const AT = new Date('2026-11-06T05:00:00.000Z');
const btc = fakeMarket({ id: 'm-btc', symbol: 'BTC/USDT', baseAsset: 'BTC', quoteAsset: 'USDT' });
const eth = fakeMarket({ id: 'm-eth', symbol: 'ETH/USDT', baseAsset: 'ETH', quoteAsset: 'USDT' });
const halted = fakeMarket({ id: 'm-sol', symbol: 'SOL/USDT', baseAsset: 'SOL', quoteAsset: 'USDT', status: 'halted' });
const ethBtc = fakeMarket({ id: 'm-ethbtc', symbol: 'ETH/BTC', baseAsset: 'ETH', quoteAsset: 'BTC', status: 'halted' });

describe('convert.pairs (J-cex-spot-11 #1)', () => {
  it('offers the coins of every market a quote would accept, each with the max-order limit in its quote asset', () => {
    expect(convertPairs([btc, eth], AT, 100_000)).toEqual({
      assets: [
        { asset: 'BTC', maxPerConvert: { amount: '100000', asset: 'USDT' } },
        { asset: 'ETH', maxPerConvert: { amount: '100000', asset: 'USDT' } },
        { asset: 'USDT', maxPerConvert: { amount: '100000', asset: 'USDT' } },
      ],
      restricted: [],
    });
  });

  it('a blank max-order is no limit set, never an invented one', () => {
    expect(convertPairs([btc], AT, null).assets.map((a) => a.maxPerConvert)).toEqual([null, null]);
  });

  it('a coin only a refused market carries is restricted and not offered; one an open market also carries is offered', () => {
    const pairs = convertPairs([btc, halted, ethBtc], AT, 100_000);
    expect(pairs.assets.map((a) => a.asset)).toEqual(['BTC', 'USDT']);
    expect(pairs.restricted).toEqual(['ETH', 'SOL']);
  });

  it('no market a quote accepts: nothing offered', () => {
    expect(convertPairs([halted], AT, 100_000)).toEqual({ assets: [], restricted: ['SOL', 'USDT'] });
  });
});
