import { describe, expect, it } from 'vitest';
import { markBookResolver, parseIndexSpotMarkets, type IndexMarket, type IndexMarketLookup } from './mark-from-spot-index.js';

const PERP: IndexMarket = { id: 'f1', symbol: 'BTC/USDT:USDT', kind: 'futures', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'active' };
const SPOT: IndexMarket = { id: 's1', symbol: 'BTC/USDT', kind: 'spot', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'active' };
const ETH_SPOT: IndexMarket = { id: 's2', symbol: 'ETH/USDT', kind: 'spot', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'active' };

function lookup(rows: IndexMarket[]): IndexMarketLookup {
  return {
    byId: async (id) => rows.find((r) => r.id === id) ?? null,
    bySymbol: async (symbol) => rows.find((r) => r.symbol === symbol) ?? null,
  };
}

describe('parseIndexSpotMarkets', () => {
  it('reads <futures>=<spot> pairs; blank is off', () => {
    expect(parseIndexSpotMarkets('')).toEqual(new Map());
    expect(parseIndexSpotMarkets(undefined)).toEqual(new Map());
    expect(parseIndexSpotMarkets(' BTC/USDT:USDT = BTC/USDT , ETH/USDT:USDT=ETH/USDT ')).toEqual(
      new Map([
        ['BTC/USDT:USDT', 'BTC/USDT'],
        ['ETH/USDT:USDT', 'ETH/USDT'],
      ]),
    );
  });

  it('a malformed or repeated pair stops the boot rather than guessing', () => {
    for (const raw of ['BTC/USDT:USDT', '=BTC/USDT', 'BTC/USDT:USDT=', 'A=B=C']) {
      expect(() => parseIndexSpotMarkets(raw), raw).toThrow(/TRADE_FUTURES_INDEX_SPOT_MARKETS/);
    }
    expect(() => parseIndexSpotMarkets('BTC/USDT:USDT=BTC/USDT,BTC/USDT:USDT=BTC/USDC')).toThrow(/named twice/);
  });
});

describe('markBookResolver', () => {
  const pairs = parseIndexSpotMarkets('BTC/USDT:USDT=BTC/USDT');

  it('off when no pair is configured', () => {
    expect(markBookResolver(new Map(), lookup([PERP, SPOT]))).toBeNull();
  });

  it('names the paired spot book when it is an active spot market of the same base and quote', async () => {
    expect(await markBookResolver(pairs, lookup([PERP, SPOT]))!('f1')).toBe('s1');
  });

  it('a market no pair names reads its own book, as before', async () => {
    const other = { ...PERP, id: 'f2', symbol: 'ETH/USDT:USDT', baseAsset: 'ETH' };
    const resolve = markBookResolver(pairs, lookup([PERP, SPOT, other, ETH_SPOT]))!;
    expect(await resolve('f2')).toBe('f2');
    expect(await resolve('s2')).toBe('s2');
    expect(await resolve('unknown')).toBe('unknown');
  });

  it('a pair that does not fit reads no book — never a nearby price, never the futures book instead', async () => {
    expect(await markBookResolver(pairs, lookup([PERP]))!('f1')).toBeNull();
    expect(await markBookResolver(pairs, lookup([PERP, { ...SPOT, kind: 'futures' }]))!('f1')).toBeNull();
    for (const status of ['halted', 'delisted', 'pending'] as const) {
      expect(await markBookResolver(pairs, lookup([PERP, { ...SPOT, status }]))!('f1'), status).toBeNull();
    }
    expect(await markBookResolver(parseIndexSpotMarkets('BTC/USDT:USDT=ETH/USDT'), lookup([PERP, ETH_SPOT]))!('f1')).toBeNull();
  });
});
