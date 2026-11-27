import { renderToString } from 'react-dom/server';
import type { VenueFeeTier, VenuePublicFees } from '@intafaced/contracts/trade-venue-door';
import { describe, expect, it } from 'vitest';
import { VenueFeesView, VenueTierView } from './VenueFees';

// J-cex-spot-21 #4: My tier reads our builder fee from a second request. Until it answers, the builder-fee cell
// carries no value, so a reader never takes "loading" for "not set"; once it answers, the cell holds our fee. TEST rates only.
const rate = (value: string) => ({ known: true as const, value });
const tier = {
  asOf: '2026-11-23T00:00:00.000Z',
  test: true,
  value: {
    schedule: { tiers: null, volumeAsset: 'USDC', volumeDays: 14 },
    account: {
      tierName: null,
      volume: { known: false as const },
      spot: { makerFeeBps: rate('8'), takerFeeBps: rate('10') },
      perpetual: { makerFeeBps: rate('2'), takerFeeBps: rate('5') },
      tierUpdatedAt: null,
      stakingDiscount: {
        asset: 'HYPE',
        countedStake: '150',
        tierName: 'TEST Bronze',
        discountBps: 1000,
        markets: [
          {
            symbol: 'BTC/USDC',
            kind: 'spot' as const,
            before: { makerFeeBps: rate('8'), takerFeeBps: rate('10') },
            after: { makerFeeBps: rate('7.2'), takerFeeBps: rate('9') },
          },
        ],
      },
    },
  },
} as VenueFeeTier;
const builder = [
  {
    symbol: 'BTC/USDC',
    kind: 'spot',
    makerFeeBps: rate('8'),
    takerFeeBps: rate('10'),
    builderFeeCapBps: rate('10'),
    builderFeeBps: rate('3'),
  },
] as VenuePublicFees['value']['markets'];

const builderCell = (html: string) => html.match(/<td data-cell="builder-fee"[^>]*>/)?.[0];

describe('My tier: our builder fee beside the staking discount', () => {
  it('while our fees load, the cell carries no value', () => {
    const cell = builderCell(renderToString(<VenueTierView tier={tier} builder={null} />));
    expect(cell).toBeDefined();
    expect(cell).not.toContain('data-value');
  });

  it('once they answer, the cell holds our fee', () => {
    expect(builderCell(renderToString(<VenueTierView tier={tier} builder={builder} />))).toContain('data-value="3"');
  });

  it('a venue market we do not list reads "not offered here", never loading', () => {
    const html = renderToString(<VenueTierView tier={tier} builder={[]} />);
    expect(builderCell(html)).toContain('data-value=""');
    expect(html).toMatch(/data-cell="builder-fee"[^>]*>not offered here</);
    expect(html).not.toContain('Reading the venue’s fees');
  });
});

// The public fee page lists what a withdrawal to the wallet costs, as the venue publishes it; a figure it gives
// none of reads "not published", never zero, and a venue that publishes no terms says each withdrawal shows its fee.
describe("/fees: a withdrawal's cost beside the trading fees", () => {
  const fees = (withdrawal: VenuePublicFees['value']['withdrawal']) =>
    ({
      venueId: 'test',
      asOf: '2026-11-27T00:00:00.000Z',
      value: {
        venue: { id: 'test', displayName: 'TEST venue' },
        schedule: { tiers: null, volumeAsset: 'USDC', volumeDays: 14 },
        markets: builder,
        withdrawal,
        test: true,
      },
    }) as VenuePublicFees;
  const page = (data: VenuePublicFees) => renderToString(<VenueFeesView load={{ status: 'ready', data, asOf: 0 }} />);

  it("the venue's fee, the network fee and the arrival time, as published", () => {
    const html = page(fees({ asset: 'USDC', fee: rate('1'), networkFee: { known: false }, arrivalSeconds: 240 }));
    expect(html).toContain('Taking USDC out to your wallet');
    expect(html).toContain('The venue’s withdrawal fee: 1 USDC');
    expect(html).toContain('Network fee: not published by the venue.');
    expect(html).toContain('Arrives in about 4 min, as the venue says.');
    expect(html).toContain('No trading fee and no fee of ours is taken on a withdrawal.');
  });

  it('a fee the venue does not publish reads "not published", never zero', () => {
    const html = page(fees({ asset: 'USDC', fee: { known: false }, networkFee: { known: false }, arrivalSeconds: null }));
    expect(html).toContain('not published before you send');
    expect(html).toContain('Arrival time: not published by the venue.');
    expect(html).not.toContain('0 USDC');
  });

  it('a venue that publishes no terms says each withdrawal shows its fee', () => {
    expect(page(fees(null))).toContain('The venue publishes no withdrawal fee before you send.');
  });

  it('every market row names the rate a new account pays, and where your own is', () => {
    expect(page(fees(null))).toContain('the ones a new account pays; your own, by your tier, are on My fee tier');
  });
});
