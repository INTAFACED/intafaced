import { describe, expect, it } from 'vitest';
import { fakeMarket } from '../public-rest.js';
import { convertPairs, convertRoute } from './pairs.js';

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
      paused: false,
    });
  });

  it('the Convert kill-switch off says paused, with the same coins listed (J-cex-spot-11 #7)', () => {
    expect(convertPairs([btc], AT, 100_000, true)).toMatchObject({ paused: true, assets: [{ asset: 'BTC' }, { asset: 'USDT' }] });
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
    expect(convertPairs([halted], AT, 100_000)).toEqual({ assets: [], restricted: ['SOL', 'USDT'], paused: false });
  });
});

describe('convert.route (J-cex-spot-11 #11)', () => {
  it('a direct market is bought or sold', () => {
    expect(convertRoute([btc], AT, 'USDT', 'BTC')).toEqual({ kind: 'direct', symbol: 'BTC/USDT', side: 'buy' });
    expect(convertRoute([btc], AT, 'BTC', 'USDT')).toEqual({ kind: 'direct', symbol: 'BTC/USDT', side: 'sell' });
  });

  it('a cash currency to a coin with no direct market refuses by name: the two-leg plan is not built', () => {
    expect(() => convertRoute([btc], AT, 'EUR', 'BTC')).toThrow(expect.objectContaining({ code: 'trade.convert_two_leg_unbuilt' }));
    expect(() => convertRoute([btc], AT, 'BTC', 'GBP')).toThrow(expect.objectContaining({ code: 'trade.convert_two_leg_unbuilt' }));
  });

  it('two assets no market or cash route joins refuse as unlisted, never as a two-leg plan', () => {
    expect(() => convertRoute([btc], AT, 'DOGE', 'BTC')).toThrow(expect.objectContaining({ code: 'trade.convert_pair_unlisted' }));
    expect(() => convertRoute([btc, halted], AT, 'EUR', 'SOL')).toThrow(expect.objectContaining({ code: 'trade.convert_pair_unlisted' }));
  });
});
