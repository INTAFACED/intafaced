import { describe, expect, it } from 'vitest';
import { venueMarketSchema, type VenueMarket } from '../../../features/trade/venue-api';
import { chartOrderRefusal } from './VenueChartOrders';

/**
 * Unit card — order entry on the venue desk's chart names why it is off (J-charts-desk-15 #6, C-ops-02)
 *
 * 1. Promise: while the venue reports the market halted, cancel only or delisted, or our listing stops routing new orders
 *    to it, the chart takes no order and says which; a market that takes orders has no refusal.
 * 2. Break: the client dropped the venue's market state, so a halted market's chart offered a ticket the venue refused.
 * 3. Done bar: each state gives its own words naming the market and who stopped it; trading, unreported and an older door
 *    with neither field give none.
 */
const t = ((key: string, values?: Record<string, string>) => `${key}|${JSON.stringify(values ?? {})}`) as Parameters<
  typeof chartOrderRefusal
>[2];

const base = venueMarketSchema.parse({
  symbol: 'ABC-USDC',
  kind: 'spot',
  baseAsset: 'ABC',
  quoteAsset: 'USDC',
  orderTypes: ['limit', 'market'],
  timeInForce: ['GTC'],
  marginModes: [],
  maxLeverageBps: null,
  tickSize: '0.1',
  lotSize: '0.001',
  makerFeeBps: { known: true, value: '1' },
  takerFeeBps: { known: true, value: '3.5' },
  listedBy: { known: false },
  oracleRule: { known: false },
  markRule: { known: false },
  tradingHours: { known: false },
  feed: { known: false },
  session: { known: false },
  contractSize: { known: false },
  mark: { known: false },
  funding: { known: false },
});
const at = (patch: Partial<VenueMarket>): VenueMarket => ({ ...base, ...patch });
const words = { symbol: 'ABC-USDC', venue: 'TEST venue' };
const said = (key: string) => `${key}|${JSON.stringify(words)}`;

describe('chartOrderRefusal', () => {
  it('reads the venue state and our routing from the door', () => {
    const parsed = venueMarketSchema.parse({ ...base, status: 'halted', listing: { routing: 'show', delisted: false, version: 1 } });
    expect(parsed.status).toBe('halted');
    expect(parsed.listing?.routing).toBe('show');
  });

  it('names each state that stops new orders', () => {
    expect(chartOrderRefusal(at({ status: 'halted' }), 'TEST venue', t)).toBe(said('Off halted'));
    expect(chartOrderRefusal(at({ status: 'cancel_only' }), 'TEST venue', t)).toBe(said('Off cancel only'));
    expect(chartOrderRefusal(at({ status: 'delisted' }), 'TEST venue', t)).toBe(said('Off delisted'));
    expect(chartOrderRefusal(at({ status: 'trading', listing: { routing: 'stop' } }), 'TEST venue', t)).toBe(said('Off routing stopped'));
    expect(chartOrderRefusal(at({ status: 'trading', listing: { routing: 'close_only' } }), 'TEST venue', t)).toBe(said('Off close only'));
    expect(chartOrderRefusal(at({ status: 'trading', listing: { routing: 'show', delisted: true } }), 'TEST venue', t)).toBe(
      said('Off delisted here'),
    );
  });

  it('the venue halt is named before our routing', () => {
    expect(chartOrderRefusal(at({ status: 'halted', listing: { routing: 'stop' } }), 'TEST venue', t)).toBe(said('Off halted'));
  });

  it('a market that takes orders, or a door that reports neither, has no refusal', () => {
    expect(chartOrderRefusal(at({ status: 'trading', listing: { routing: 'show', delisted: false } }), 'TEST venue', t)).toBeNull();
    expect(chartOrderRefusal(at({ status: null }), 'TEST venue', t)).toBeNull();
    expect(chartOrderRefusal(base, 'TEST venue', t)).toBeNull();
  });
});
