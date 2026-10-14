import { definePreviewFixture } from './types';

/**
 * SAMPLE data for the earn Preview. Invented numbers; never mixed with real data. See ../README.md.
 * Every rate here is a SAMPLE rate: an illustration of how the product will look, not an offer and not a promise.
 * Amounts are decimal strings, rates are percent-per-year decimal strings ("4.20" is 4.20% a year).
 */
export type EarnKind = 'flexible' | 'locked';
export type EarnAsset = 'USDT' | 'USDC' | 'BTC' | 'ETH' | 'SOL';

export interface EarnProduct {
  readonly id: string;
  readonly asset: EarnAsset;
  readonly kind: EarnKind;
  /** Whole days of the lock; null for flexible products. */
  readonly termDays: number | null;
  /** Sample rate in percent per year, as a decimal string. */
  readonly ratePct: string;
  /** Smallest amount that can be put in, in the coin itself. */
  readonly minAmount: string;
}

export interface EarnPosition {
  readonly id: string;
  readonly productId: string;
  readonly principal: string;
  /** Sample rewards collected so far, in the coin itself. */
  readonly collected: string;
  readonly startedDaysAgo: number;
  /** Days until a locked position ends; null for flexible positions. */
  readonly endsInDays: number | null;
}

export interface EarnSample {
  readonly products: readonly EarnProduct[];
  readonly positions: readonly EarnPosition[];
  /** Sample amount the person could put in, per coin. */
  readonly available: Readonly<Record<EarnAsset, string>>;
  /** Sample USD price per coin, used only to show "about $x" next to a sample amount. */
  readonly prices: Readonly<Record<EarnAsset, string>>;
  readonly assetNames: Readonly<Record<EarnAsset, string>>;
  /** Decimal places shown for a coin's amounts. */
  readonly places: Readonly<Record<EarnAsset, number>>;
}

export const earnFixture = definePreviewFixture<EarnSample>(
  'earn',
  'Earn products: every rate is a sample rate, not an offer.',
  {
    products: [
      { id: 'usdt-flex', asset: 'USDT', kind: 'flexible', termDays: null, ratePct: '4.20', minAmount: '1' },
      { id: 'usdc-flex', asset: 'USDC', kind: 'flexible', termDays: null, ratePct: '3.90', minAmount: '1' },
      { id: 'btc-flex', asset: 'BTC', kind: 'flexible', termDays: null, ratePct: '1.10', minAmount: '0.0001' },
      { id: 'eth-flex', asset: 'ETH', kind: 'flexible', termDays: null, ratePct: '2.60', minAmount: '0.001' },
      { id: 'sol-flex', asset: 'SOL', kind: 'flexible', termDays: null, ratePct: '5.40', minAmount: '0.1' },
      { id: 'usdt-30', asset: 'USDT', kind: 'locked', termDays: 30, ratePct: '6.10', minAmount: '100' },
      { id: 'usdt-60', asset: 'USDT', kind: 'locked', termDays: 60, ratePct: '6.80', minAmount: '100' },
      { id: 'usdt-90', asset: 'USDT', kind: 'locked', termDays: 90, ratePct: '7.40', minAmount: '100' },
      { id: 'btc-30', asset: 'BTC', kind: 'locked', termDays: 30, ratePct: '1.80', minAmount: '0.005' },
      { id: 'eth-60', asset: 'ETH', kind: 'locked', termDays: 60, ratePct: '3.60', minAmount: '0.05' },
      { id: 'sol-90', asset: 'SOL', kind: 'locked', termDays: 90, ratePct: '7.20', minAmount: '2' },
    ],
    positions: [
      { id: 'p1', productId: 'usdt-flex', principal: '2500', collected: '4.03', startedDaysAgo: 14, endsInDays: null },
      { id: 'p2', productId: 'usdt-30', principal: '5000', collected: '9.19', startedDaysAgo: 11, endsInDays: 19 },
      { id: 'p3', productId: 'btc-flex', principal: '0.15', collected: '0.00009041', startedDaysAgo: 20, endsInDays: null },
    ],
    available: { USDT: '8420.5', USDC: '1200', BTC: '0.25', ETH: '3.5', SOL: '40' },
    prices: { USDT: '1', USDC: '1', BTC: '64250', ETH: '3180', SOL: '148.5' },
    assetNames: { USDT: 'Tether', USDC: 'USD Coin', BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana' },
    places: { USDT: 2, USDC: 2, BTC: 8, ETH: 6, SOL: 4 },
  },
);
