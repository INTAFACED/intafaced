import { describe, expect, it } from 'vitest';
import type { DepthSnapshot } from './mark-from-depth.js';
import {
  indexSpotMarketId,
  markSourceFromSpotIndex,
  parseIndexSpotMarkets,
  type IndexMarketLookup,
  type IndexMarketRow,
} from './mark-from-spot-index.js';

const PERP: IndexMarketRow = { id: 'f1', symbol: 'BTC/USDT:USDT', kind: 'futures', base_asset: 'BTC', quote_asset: 'USDT' };
const SPOT: IndexMarketRow = { id: 's1', symbol: 'BTC/USDT', kind: 'spot', base_asset: 'BTC', quote_asset: 'USDT' };
const ETH_SPOT: IndexMarketRow = { id: 's2', symbol: 'ETH/USDT', kind: 'spot', base_asset: 'ETH', quote_asset: 'USDT' };

function lookup(rows: IndexMarketRow[]): IndexMarketLookup {
  return {
    byId: async (id) => rows.find((r) => r.id === id) ?? null,
    bySymbol: async (symbol) => rows.find((r) => r.symbol === symbol) ?? null,
  };
}

const observedAt = new Date('2026-10-22T12:00:00.000Z');
const book = (bid: string, ask: string): DepthSnapshot => ({ bids: [[bid, '5']], asks: [[ask, '5']], sequence: 1, observedAt });

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

describe('indexSpotMarketId', () => {
  const pairs = parseIndexSpotMarkets('BTC/USDT:USDT=BTC/USDT');

  it('names the paired spot market when it shares base and quote', async () => {
    expect(await indexSpotMarketId(pairs, lookup([PERP, SPOT]), 'f1')).toBe('s1');
  });

  it('null when the pair is missing, the spot row is absent, not spot, or another asset — never a nearby price', async () => {
    expect(await indexSpotMarketId(new Map(), lookup([PERP, SPOT]), 'f1')).toBeNull();
    expect(await indexSpotMarketId(pairs, lookup([PERP]), 'f1')).toBeNull();
    expect(await indexSpotMarketId(pairs, lookup([PERP, { ...SPOT, kind: 'futures' }]), 'f1')).toBeNull();
    expect(await indexSpotMarketId(parseIndexSpotMarkets('BTC/USDT:USDT=ETH/USDT'), lookup([PERP, ETH_SPOT]), 'f1')).toBeNull();
    // The id asked about must itself be a futures market.
    expect(await indexSpotMarketId(pairs, lookup([PERP, SPOT]), 's1')).toBeNull();
  });
});

describe('markSourceFromSpotIndex', () => {
  it('off when no pair is configured, so the book mark stays as it was', () => {
    expect(markSourceFromSpotIndex({ pairs: new Map(), markets: lookup([PERP, SPOT]), readDepth: async () => null })).toBeNull();
  });

  it('marks the futures market from the spot book’s depth, never from its own', async () => {
    const reads: string[] = [];
    const src = markSourceFromSpotIndex({
      pairs: parseIndexSpotMarkets('BTC/USDT:USDT=BTC/USDT'),
      markets: lookup([PERP, SPOT]),
      readDepth: async (id) => {
        reads.push(id);
        return id === 's1' ? book('64990', '65010') : book('1', '2');
      },
    });
    expect(await src!.markPrice({ marketId: 'f1', at: observedAt })).toBe('65000');
    expect(reads).toEqual(['s1']);
  });

  it('an empty spot book or an unpaired futures market reads null', async () => {
    const src = markSourceFromSpotIndex({
      pairs: parseIndexSpotMarkets('BTC/USDT:USDT=BTC/USDT'),
      markets: lookup([PERP, SPOT, { ...PERP, id: 'f2', symbol: 'ETH/USDT:USDT', base_asset: 'ETH' }]),
      readDepth: async () => ({ bids: [], asks: [], sequence: 0, observedAt }),
    });
    expect(await src!.markPrice({ marketId: 'f1', at: observedAt })).toBeNull();
    expect(await src!.markPrice({ marketId: 'f2', at: observedAt })).toBeNull();
  });
});
