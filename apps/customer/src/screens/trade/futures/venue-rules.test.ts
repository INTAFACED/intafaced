import { describe, expect, it } from 'vitest';
import { venueMarketSchema } from '../../../features/trade/venue-api';
import { MARKET_RULE_WORDS, futuresVenueCopy } from './venue-copy';

// J-derivatives-21 #1 and #4: the desk shows the venue's own rules and feed state, and its own words around them claim no
// protection the venue doesn't give.
const PROTECTION =
  /\b(?:protect\w*|guarantee\w*|safe\w*|insur\w*|no liquidation|never liquidat\w*|we (?:pause|halt|stop|hold|freeze)\w*|covered|secured?)\b/i;

const market = {
  symbol: 'XAU-PERP',
  kind: 'perpetual',
  baseAsset: 'XAU',
  quoteAsset: 'USDC',
  orderTypes: ['limit', 'market'],
  timeInForce: ['GTC', 'IOC'],
  marginModes: ['isolated'],
  maxLeverageBps: 100000,
  tickSize: '0.1',
  lotSize: '0.01',
  makerFeeBps: { known: true, value: '1' },
  takerFeeBps: { known: true, value: '3' },
  listedBy: { known: true, value: { kind: 'hip3', name: 'TEST gold deployer' } },
  oracleRule: { known: true, value: 'TEST oracle' },
  markRule: { known: false },
  tradingHours: { known: true, value: '24/7, no close' },
  feed: { known: true, value: { state: 'stale', lastOracleUpdateAt: '2026-11-09T10:00:00.000Z', staleRule: { known: false } } },
  session: { known: false },
  contractSize: { known: true, value: '1' },
  mark: { known: true, value: '2650' },
  funding: { known: false },
};

/** J-derivatives-27: a TEST stock perpetual with its home market closed. */
const stock = {
  ...market,
  symbol: 'XSTK-PERP',
  baseAsset: 'XSTK',
  session: {
    known: true,
    value: {
      state: 'off_hours',
      homeMarket: 'TEST home exchange',
      offHoursMode: { known: true, value: 'TEST mode' },
      offHoursBand: { known: false },
      offHoursMaxLeverageBps: 20000,
      reopensAt: '2026-11-11T14:30:00.000Z',
      offHoursRule: { known: true, value: 'TEST rule' },
    },
  },
};

describe('the futures desk: a market’s published rules (J-derivatives-21)', () => {
  it('reads the listing, rules, hours and feed from the venue, and keeps an unpublished one unpublished', () => {
    const parsed = venueMarketSchema.parse(market);
    expect(parsed.listedBy).toEqual({ known: true, value: { kind: 'hip3', name: 'TEST gold deployer' } });
    expect(parsed.markRule).toEqual({ known: false });
    expect(parsed.feed).toMatchObject({ known: true, value: { state: 'stale', staleRule: { known: false } } });
    // A venue that sends none of them is refused, never read as "no rule": the door always sends each, known or not.
    const { listedBy: _l, ...missing } = market;
    expect(venueMarketSchema.safeParse(missing).success).toBe(false);
    expect(venueMarketSchema.safeParse({ ...market, feed: { known: true, value: { state: 'paused' } } }).success).toBe(false);
  });

  it('reads a stock perpetual’s home-market session from the venue, and refuses a session without its parts (J-derivatives-27)', () => {
    const parsed = venueMarketSchema.parse(stock);
    expect(parsed.session).toEqual(stock.session);
    expect(
      venueMarketSchema.parse({
        ...stock,
        session: { known: true, value: { ...stock.session.value, reopensAt: null, offHoursMaxLeverageBps: null } },
      }).session,
    ).toMatchObject({
      value: { reopensAt: null, offHoursMaxLeverageBps: null },
    });
    const { session: _s, ...missing } = stock;
    expect(venueMarketSchema.safeParse(missing).success).toBe(false);
    expect(
      venueMarketSchema.safeParse({ ...stock, session: { known: true, value: { ...stock.session.value, state: 'paused' } } }).success,
    ).toBe(false);
    const { offHoursRule: _r, ...noRule } = stock.session.value;
    expect(venueMarketSchema.safeParse({ ...stock, session: { known: true, value: noRule } }).success).toBe(false);
  });

  it('claims no protection of its own in the words around the venue’s rules', () => {
    const { t } = futuresVenueCopy.forLocale('en');
    for (const key of Object.keys(MARKET_RULE_WORDS) as Array<keyof typeof MARKET_RULE_WORDS>) {
      const words = t(key, { symbol: 'XAU-PERP', name: 'TEST', venue: 'TEST venue', rule: '', home: 'TEST home', times: '2' });
      expect(words, key).not.toMatch(PROTECTION);
    }
    expect(t('Not published')).toBe('not published by this venue');
    expect(t('Feed stale notice', { venue: 'V', symbol: 'XAU-PERP', rule: 'R' })).toBe(
      'V reports the XAU-PERP price feed stale. The venue’s own rule: R',
    );
    expect(t('Off-hours notice', { venue: 'V', home: 'H', symbol: 'XSTK-PERP', rule: 'R' })).toBe(
      'V reports H closed: XSTK-PERP is in the venue’s off-hours mode. The venue’s own rule: R',
    );
  });
});
