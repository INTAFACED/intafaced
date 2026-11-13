import { describe, expect, it } from 'vitest';
import { isFuturesListing, type FuturesListing } from './api';

/**
 * #4717: the Futures desk has no simulated mode, so it must never offer a paper (simulated)
 * listing beside the live ones; an order placed from the desk is always a live order.
 */
const listing = (flags: Partial<Pick<FuturesListing, 'swap' | 'future' | 'option' | 'spot' | 'paper'>>): FuturesListing =>
  ({ swap: false, future: false, option: false, spot: false, paper: false, ...flags }) as FuturesListing;

describe('isFuturesListing', () => {
  it('offers live perpetual and dated contracts', () => {
    expect(isFuturesListing(listing({ swap: true }))).toBe(true);
    expect(isFuturesListing(listing({ future: true }))).toBe(true);
  });

  it('never offers a paper contract, so no simulated market sits on the live desk', () => {
    expect(isFuturesListing(listing({ swap: true, paper: true }))).toBe(false);
    expect(isFuturesListing(listing({ future: true, paper: true }))).toBe(false);
  });

  it('never offers a spot or option listing', () => {
    expect(isFuturesListing(listing({ spot: true }))).toBe(false);
    expect(isFuturesListing(listing({ option: true }))).toBe(false);
  });
});
