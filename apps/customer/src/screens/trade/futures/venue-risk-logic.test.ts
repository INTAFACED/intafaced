import { describe, expect, it } from 'vitest';
import type { VenueMarket } from '../../../features/trade/venue-api';
import { buyingPower, percentOf, roomLeft, takenAssets } from './venue-risk-logic';

// J-derivatives-02 #3 #7: buying power and the room under the open-interest cap, only from the venue's own figures.

const market = (over: Partial<VenueMarket>) => ({ symbol: 'XRSK-PERP', ...over }) as VenueMarket;

describe('venue risk figures', () => {
  it('reads a scaled rate as an exact percent', () => {
    expect(percentOf('0.025')).toBe('2.5');
    expect(percentOf('0')).toBe('0');
  });

  it('counts only what the venue takes, less its haircut, and refuses to guess an unpublished haircut', () => {
    const free = (a: string) => ({ USDC: '1000', USDT: '200', BTC: '1' })[a] ?? '0';
    expect(buyingPower([{ asset: 'USDC', haircut: { known: true, value: '0' } }], free)).toEqual({ known: true, value: '1000' });
    expect(
      buyingPower(
        [
          { asset: 'USDC', haircut: { known: true, value: '0' } },
          { asset: 'USDT', haircut: { known: true, value: '0.02' } },
        ],
        free,
      ),
    ).toEqual({ known: true, value: '1196' });
    expect(buyingPower([{ asset: 'USDT', haircut: { known: false } }], free)).toEqual({ known: false, asset: 'USDT' });
    // A taken asset the person holds none of needs no haircut.
    expect(buyingPower([{ asset: 'DAI', haircut: { known: false } }], free)).toEqual({ known: true, value: '0' });
  });

  it('gives the room under the cap from the venue figures, none where it reports no cap', () => {
    expect(roomLeft(market({ openInterest: { known: true, value: { size: '12.5', capSize: '13' } } }))).toBe('0.5');
    expect(roomLeft(market({ openInterest: { known: true, value: { size: '14', capSize: '13' } } }))).toBe('0');
    expect(roomLeft(market({ openInterest: { known: true, value: { size: '1', capSize: null } } }))).toBeNull();
    expect(roomLeft(market({ openInterest: { known: false } }))).toBeNull();
  });

  it('lists what the venue takes, or null where it publishes no list', () => {
    expect(takenAssets(market({ collateral: { known: true, value: [{ asset: 'USDC', haircut: { known: false } }] } }))).toEqual(['USDC']);
    expect(takenAssets(market({ collateral: { known: false } }))).toBeNull();
    expect(takenAssets(market({}))).toBeNull();
  });
});
