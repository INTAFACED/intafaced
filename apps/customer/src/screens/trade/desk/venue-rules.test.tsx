import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { VenueMarket } from '../../../features/trade/venue-api';
import { venueMarketSchema } from '../../../features/trade/venue-api';
import { VenueMarketRules } from './VenueMarketRules';
import { bpsAsPercent, intentOf, ticketProblem, unpublishedRules, type TicketFields } from './venue-desk';

// J-cex-spot-04 #2 #6 on the venue spot desk: the market's rules as the venue publishes them, with the venue named, and a
// spot ticket that takes no order while the venue publishes no smallest order value, band or open-order cap. TEST figures.

const MARKET: VenueMarket = venueMarketSchema.parse({
  symbol: 'RUL-USDC',
  kind: 'spot',
  baseAsset: 'RUL',
  quoteAsset: 'USDC',
  orderTypes: ['limit', 'market'],
  timeInForce: ['GTC', 'IOC', 'ALO'],
  marginModes: [],
  maxLeverageBps: null,
  tickSize: '0.1',
  lotSize: '0.001',
  minOrderNotional: '10',
  priceBandBps: '1000',
  maxOpenOrders: 3,
  maxOrderQty: '100',
  maxOrderNotional: '10000',
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
const BARE: VenueMarket = { ...MARKET, minOrderNotional: null, priceBandBps: null };
const buy: TicketFields = { side: 'buy', type: 'limit', price: '20', amount: '1' };
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('the market’s rules as the venue publishes them (J-cex-spot-04 #2)', () => {
  it('names the venue and shows each rule in the venue’s own figures', () => {
    const shown = text(renderToStaticMarkup(<VenueMarketRules market={MARKET} venueName="TEST venue" />));
    expect(shown).toContain('As TEST venue publishes them');
    expect(shown).toContain('Price step 0.1 USDC');
    expect(shown).toContain('Amount step 0.001 RUL');
    expect(shown).toContain('Smallest order value 10 USDC');
    expect(shown).toContain('Price band Limit prices within 10% of the middle of the venue’s book');
    expect(shown).toContain('Open orders Up to 3 open orders on your venue account');
    expect(shown).toContain('Largest order 100 RUL, or 10000 USDC');
    expect(shown).not.toContain('Not published');
  });

  it('a rule the venue does not publish reads "Not published by" the venue, never a figure of ours', () => {
    const shown = text(
      renderToStaticMarkup(<VenueMarketRules market={{ ...BARE, maxOrderQty: null, maxOrderNotional: null }} venueName="TEST venue" />),
    );
    expect(shown).toContain('Smallest order value Not published by TEST venue');
    expect(shown).toContain('Price band Not published by TEST venue');
    expect(shown).toContain('Largest order Not published by TEST venue');
    expect(shown).toContain('Up to 3 open orders');
  });

  it('a door that sends none of the rules reads them as not published', () => {
    const { minOrderNotional: _m, priceBandBps: _b, maxOpenOrders: _c, ...older } = MARKET;
    expect(unpublishedRules(venueMarketSchema.parse(older))).toEqual(['min', 'band', 'cap']);
  });

  it('the band in bps is an exact percent', () => {
    expect([bpsAsPercent('1000'), bpsAsPercent('9500'), bpsAsPercent('250'), bpsAsPercent('1')]).toEqual(['10', '95', '2.5', '0.01']);
  });
});

describe('a spot ticket leaves unpublished venue rules to the venue (J-cex-spot-04 #6, project-state decision PR #4036)', () => {
  it('allows building a limit intent even when the venue publishes no smallest order value or price band, while a blank owner cap still blocks market orders', () => {
    expect(unpublishedRules(BARE)).toEqual(['min', 'band']);
    expect(ticketProblem(buy, BARE, null)).toBeNull();
    expect(ticketProblem({ ...buy, amount: '' }, BARE, null)).toBe('amount');
    expect(intentOf(buy, BARE, null, 'order:0xowner:rul-usdc:a', true)).toMatchObject({ kind: 'place_order', price: '20', amount: '1' });
    // Blank owner protection still blocks a market order.
    expect(ticketProblem({ side: 'buy', type: 'market', price: '', amount: '1' }, BARE, '21', false)).toBe('no_cap');
  });

  it('with every rule published the same order is an intent; a perpetual is not held to the spot rules', () => {
    expect(ticketProblem(buy, MARKET, null)).toBeNull();
    expect(intentOf(buy, MARKET, null, 'order:0xowner:rul-usdc:b', true)).toMatchObject({ kind: 'place_order', price: '20', amount: '1' });
    expect(ticketProblem(buy, { ...BARE, kind: 'perpetual' }, null)).toBeNull();
  });
});

describe('orders below the venue’s smallest order value are refused before preview (J-cex-spot-04 #3)', () => {
  it('returns below_min and builds no intent when a limit order is below minOrderNotional, and admits one at the minimum', () => {
    const tooSmall: TicketFields = { side: 'buy', type: 'limit', price: '20', amount: '0.001' };
    expect(ticketProblem(tooSmall, MARKET, null)).toBe('below_min');
    expect(intentOf(tooSmall, MARKET, null, 'order:0xowner:rul-usdc:small', true)).toBeNull();
    const atMin: TicketFields = { side: 'buy', type: 'limit', price: '20', amount: '0.5' };
    expect(ticketProblem(atMin, MARKET, null)).toBeNull();
    expect(intentOf(atMin, MARKET, null, 'order:0xowner:rul-usdc:min', true)).toMatchObject({ amount: '0.5', price: '20' });
  });

  it('refuses a market buy whose worst value is below minOrderNotional, and leaves a market sell to the venue’s book price', () => {
    const smallBuy: TicketFields = { side: 'buy', type: 'market', price: '', amount: '0.001' };
    expect(ticketProblem(smallBuy, MARKET, '20', true)).toBe('below_min');
    expect(intentOf(smallBuy, MARKET, '20', 'order:0xowner:rul-usdc:mb', true)).toBeNull();
    const lowBoundSell: TicketFields = { side: 'sell', type: 'market', price: '', amount: '0.75' };
    expect(ticketProblem(lowBoundSell, MARKET, '0.1', true)).toBeNull();
  });
});
