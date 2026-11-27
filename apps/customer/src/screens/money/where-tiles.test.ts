import { describe, expect, it } from 'vitest';
import { tilesOf } from './where-tiles';
import type { VenueRow } from './where-it-sits';

const prices: Record<string, string> = { USDC: '1', BTC: '100000.5' };
const priceOf = (asset: string) => prices[asset] ?? null;

const row = (asset: string, free: string, locked: string, split: VenueRow['split'] = null): VenueRow => ({
  asset,
  free,
  locked,
  total: String(Number(free) + Number(locked)),
  withdrawable: free,
  orders: [],
  split,
});

describe('Assets tiles: withdrawable, locked and moving, only from what the page reads', () => {
  it('adds the venue’s withdrawable and the wallet’s amounts, values only what is priced, and names what is not', () => {
    const tiles = tilesOf({
      venue: [row('USDC', '5591.99', '3747.26'), row('BTC', '0.1', '0'), row('NOPRICE', '3', '0')],
      wallet: [{ asset: 'USDC', amount: '1240' }],
      moving: [{ asset: 'USDC', amount: '500' }],
      priceOf,
    });
    expect(tiles.withdrawable).toEqual({ known: true, valueUsd: '16832.04', unpriced: ['NOPRICE'], any: true, missing: [] });
    expect(tiles.locked.valueUsd).toBe('3747.26');
    expect(tiles.moving.valueUsd).toBe('500');
    expect(tiles.lockedParts).toEqual([{ asset: 'USDC', amount: '3747.26', kind: 'locked' }]);
    const shares = tiles.shares!;
    const sum = ['withdrawable', 'locked', 'moving'].reduce((s, k) => s + Number(shares[k as 'locked']), 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it('names each part of a lock as the venue splits it, and leaves out parts at zero', () => {
    const tiles = tilesOf({
      venue: [row('USDC', '0', '3747.26', { inOrders: '950', collateral: '2797.26', stake: '0' })],
      wallet: [],
      moving: [],
      priceOf,
    });
    expect(tiles.lockedParts).toEqual([
      { asset: 'USDC', amount: '950', kind: 'in-orders' },
      { asset: 'USDC', amount: '2797.26', kind: 'collateral' },
    ]);
    expect(tiles.moving).toEqual({ known: true, valueUsd: '0', unpriced: [], any: false });
  });

  it('says a tile is not known when no source was read, never zero, and leaves it out of the bar', () => {
    const tiles = tilesOf({ venue: null, wallet: null, moving: null, priceOf });
    expect(tiles.withdrawable).toEqual({ known: false, valueUsd: null, unpriced: [], any: false, missing: [] });
    expect(tiles.locked.known).toBe(false);
    expect(tiles.moving.known).toBe(false);
    expect(tiles.shares).toBeNull();
  });

  it('adds the withdrawable of the sources that answered and names the one that did not', () => {
    const tiles = tilesOf({ venue: [row('USDC', '10', '0')], wallet: null, moving: null, priceOf });
    expect(tiles.withdrawable).toEqual({ known: true, valueUsd: '10', unpriced: [], any: true, missing: ['wallet'] });
    expect(tiles.shares).toEqual({ withdrawable: '1', locked: '0', moving: null });
  });

  it('gives no figure for a tile that holds only unpriced assets', () => {
    const tiles = tilesOf({ venue: [row('NOPRICE', '0', '4')], wallet: [], moving: [], priceOf });
    expect(tiles.locked).toEqual({ known: true, valueUsd: null, unpriced: ['NOPRICE'], any: true });
  });
});
