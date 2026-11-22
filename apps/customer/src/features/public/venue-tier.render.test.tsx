import { renderToString } from 'react-dom/server';
import type { VenueFeeTier, VenuePublicFees } from '@intafaced/contracts/trade-venue-door';
import { describe, expect, it } from 'vitest';
import { VenueTierView } from './VenueFees';

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
});
