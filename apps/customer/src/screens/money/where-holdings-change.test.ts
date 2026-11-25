import { describe, expect, it } from 'vitest';
import type { VenueArrival, VenueBalance, VenueFill } from '../../features/trade/venue-api';
import { venueHoldingsChange, type VenueMarketSides } from './where-holdings-change';

const SPOT_BTC: VenueMarketSides = {
  symbol: 'BTC-USDC',
  kind: 'spot',
  baseAsset: 'BTC',
  quoteAsset: 'USDC',
};

const PRICES = {
  published: true as const,
  test: true,
  source: 'TEST price list',
  asOf: '2026-11-24T12:00:00.000Z',
  prices: [
    { asset: 'USDC', usd: '1' },
    { asset: 'USDT', usd: '1' },
  ],
};

describe('venueHoldingsChange (J-portfolio-06 #3)', () => {
  it('computes start = 0 ("No holding yet") when all deposits and fills happened inside the window', () => {
    const arrivals: VenueArrival[] = [
      { arrivalId: 'dep-1', kind: 'deposit', asset: 'USDC', amount: '500', arrivedAt: '2026-11-24T10:00:00.000Z' },
      { arrivalId: 'dep-2', kind: 'deposit', asset: 'USDT', amount: '200', arrivedAt: '2026-11-24T10:01:00.000Z' },
    ];
    // Bought 0.002 BTC at 60000 = 120 USDC; taker fee 3.5 bps in BTC = 0.0000007 BTC -> net 0.0019993 BTC.
    const fills: VenueFill[] = [
      {
        fillId: 'f-1',
        venueClientOrderId: 'o-1',
        symbol: 'BTC-USDC',
        side: 'buy',
        price: '60000',
        amount: '0.002',
        role: 'taker',
        venueFee: '0.0000007',
        builderFee: '0',
        feeAsset: 'BTC',
        realisedPnl: null,
        filledAt: '2026-11-24T10:02:00.000Z',
      },
    ];
    const balances: VenueBalance[] = [
      { asset: 'BTC', free: '0.0019993', locked: '0', total: '0.0019993' },
      { asset: 'USDC', free: '380', locked: '0', total: '380' },
      { asset: 'USDT', free: '150', locked: '50', total: '200' },
    ];

    const out = venueHoldingsChange({
      fromIso: '2026-11-17T10:05:00.000Z',
      toIso: '2026-11-24T10:05:00.000Z',
      balances,
      markets: [SPOT_BTC],
      fills,
      arrivals,
      prices: PRICES,
    });

    expect(out.rows).toEqual([
      {
        assetId: 'BTC',
        startAmount: '0',
        endAmount: '0.0019993',
        change: '0.0019993',
        startPriceUsd: null,
        endPriceUsd: null,
        startValueUsd: null,
        endValueUsd: null,
      },
      {
        assetId: 'USDC',
        startAmount: '0',
        endAmount: '380',
        change: '380',
        startPriceUsd: '1',
        endPriceUsd: '1',
        startValueUsd: '0',
        endValueUsd: '380',
      },
      {
        assetId: 'USDT',
        startAmount: '0',
        endAmount: '200',
        change: '200',
        startPriceUsd: '1',
        endPriceUsd: '1',
        startValueUsd: '0',
        endValueUsd: '200',
      },
    ]);
  });

  it('shows both what rose (+) and what fell (−) when a trade occurs after the window start', () => {
    // Setup happened at 10:00–10:02 (before window start 10:05); second buy of 0.001 BTC at 60000 happened at 10:06.
    const arrivals: VenueArrival[] = [
      { arrivalId: 'dep-1', kind: 'deposit', asset: 'USDC', amount: '500', arrivedAt: '2026-11-24T10:00:00.000Z' },
    ];
    const fills: VenueFill[] = [
      {
        fillId: 'f-1',
        venueClientOrderId: 'o-1',
        symbol: 'BTC-USDC',
        side: 'buy',
        price: '60000',
        amount: '0.002',
        role: 'taker',
        venueFee: '0.0000007',
        builderFee: '0',
        feeAsset: 'BTC',
        realisedPnl: null,
        filledAt: '2026-11-24T10:02:00.000Z',
      },
      {
        fillId: 'f-2',
        venueClientOrderId: 'o-2',
        symbol: 'BTC-USDC',
        side: 'buy',
        price: '60000',
        amount: '0.001',
        role: 'taker',
        venueFee: '0.00000035',
        builderFee: '0',
        feeAsset: 'BTC',
        realisedPnl: null,
        filledAt: '2026-11-24T10:06:00.000Z',
      },
    ];
    // After both buys: BTC = 0.00299895, USDC = 500 - 120 - 60 = 320.
    const balances: VenueBalance[] = [
      { asset: 'BTC', free: '0.00299895', locked: '0', total: '0.00299895' },
      { asset: 'USDC', free: '320', locked: '0', total: '320' },
    ];

    const out = venueHoldingsChange({
      fromIso: '2026-11-24T10:05:00.000Z',
      toIso: '2026-11-25T10:05:00.000Z',
      balances,
      markets: [SPOT_BTC],
      fills,
      arrivals,
      prices: PRICES,
    });

    expect(out.rows).toEqual([
      {
        assetId: 'BTC',
        startAmount: '0.0019993',
        endAmount: '0.00299895',
        change: '0.00099965',
        startPriceUsd: null,
        endPriceUsd: null,
        startValueUsd: null,
        endValueUsd: null,
      },
      {
        assetId: 'USDC',
        startAmount: '380',
        endAmount: '320',
        change: '-60',
        startPriceUsd: '1',
        endPriceUsd: '1',
        startValueUsd: '380',
        endValueUsd: '320',
      },
    ]);
  });

  it('handles spot sells with quote fees and leaves all values unpriced when no prices are published', () => {
    const fills: VenueFill[] = [
      {
        fillId: 'f-sell',
        venueClientOrderId: 'o-sell',
        symbol: 'BTC-USDC',
        side: 'sell',
        price: '60000',
        amount: '0.001',
        role: 'taker',
        venueFee: '0.021',
        builderFee: '0.06',
        feeAsset: 'USDC',
        realisedPnl: null,
        filledAt: '2026-11-24T11:00:00.000Z',
      },
    ];
    const balances: VenueBalance[] = [
      { asset: 'BTC', free: '0.001', locked: '0', total: '0.001' },
      { asset: 'USDC', free: '159.919', locked: '0', total: '159.919' },
    ];
    const out = venueHoldingsChange({
      fromIso: '2026-11-24T10:30:00.000Z',
      toIso: '2026-11-24T12:00:00.000Z',
      balances,
      markets: [SPOT_BTC],
      fills,
      arrivals: [],
      prices: null,
    });
    expect(out.rows).toEqual([
      {
        assetId: 'BTC',
        startAmount: '0.002',
        endAmount: '0.001',
        change: '-0.001',
        startPriceUsd: null,
        endPriceUsd: null,
        startValueUsd: null,
        endValueUsd: null,
      },
      {
        assetId: 'USDC',
        startAmount: '100',
        endAmount: '159.919',
        change: '59.919',
        startPriceUsd: null,
        endPriceUsd: null,
        startValueUsd: null,
        endValueUsd: null,
      },
    ]);
  });
});
