import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { UserVenueMarket } from '@intafaced/venue-contracts';
import {
  BuilderFeeVersionError,
  assertWithinVenueCaps,
  builderFeeOf,
  parseBuilderFees,
  type BuilderFeeBook,
} from './builder-fee-versions.js';

const a = parseAmount;
const VENUE = 'test-venue-sim';
const book = (groups: Record<string, unknown>, marketGroups?: Record<string, unknown>, defaultGroup = 'all-markets'): BuilderFeeBook => {
  const parsed = parseBuilderFees({ [VENUE]: { defaultGroup, groups, ...(marketGroups ? { marketGroups } : {}) } });
  if (!parsed) throw new Error('a non-empty builder fee book parsed to null');
  return parsed;
};

const market = (symbol: string, cap: string | null, kind: 'spot' | 'perpetual' = 'spot'): UserVenueMarket => ({
  symbol,
  kind,
  baseAsset: 'BTC',
  quoteAsset: 'USDC',
  orderTypes: ['limit'],
  timeInForce: ['GTC'],
  marginModes: [],
  maxLeverageBps: null,
  tickSize: a('1'),
  lotSize: a('0.0001'),
  makerFeeBps: { known: true, value: a('1') },
  takerFeeBps: { known: true, value: a('3.5') },
  builderFeeCapBps: cap === null ? { known: false } : { known: true, value: a(cap) },
});
const venue = { venueId: VENUE, markets: [market('BTC-USDC', '100'), market('BTC-PERP', '10', 'perpetual')] };

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(BuilderFeeVersionError);
    return (err as BuilderFeeVersionError).code;
  }
  throw new Error('expected a refusal');
}

describe('builder-fee versions by venue and market group', () => {
  it('a version without builder fees has none; one with them reads each market by its group, exactly', () => {
    expect(parseBuilderFees(undefined)).toBeNull();
    const b = book({ 'all-markets': '1.5', perpetuals: '0.0005' }, { 'BTC-PERP': 'perpetuals' });
    expect(builderFeeOf(b, VENUE, 'BTC-USDC')).toEqual({ group: 'all-markets', feeBps: a('1.5') });
    expect(builderFeeOf(b, VENUE, 'BTC-PERP')).toEqual({ group: 'perpetuals', feeBps: a('0.0005') });
    // A market the version does not name takes the default group; another venue has no fee in this version.
    expect(builderFeeOf(b, VENUE, 'ETH-USDC')?.group).toBe('all-markets');
    expect(builderFeeOf(b, 'another-venue', 'BTC-USDC')).toBeNull();
  });

  it('a blank or malformed rate, a number, or a group that does not exist refuses trade.builder_fee_blank', () => {
    expect(codeOf(() => book({ 'all-markets': '' }))).toBe('trade.builder_fee_blank');
    expect(codeOf(() => book({ 'all-markets': 1.5 }))).toBe('trade.builder_fee_blank');
    expect(codeOf(() => book({ 'all-markets': '1.23456' }))).toBe('trade.builder_fee_blank');
    expect(codeOf(() => book({ 'all-markets': '-1' }))).toBe('trade.builder_fee_blank');
    expect(codeOf(() => book({ 'all-markets': '1' }, { 'BTC-PERP': 'perpetuals' }))).toBe('trade.builder_fee_blank');
    expect(codeOf(() => book({ 'all-markets': '1' }, undefined, 'missing'))).toBe('trade.builder_fee_blank');
    expect(codeOf(() => parseBuilderFees({}))).toBe('trade.builder_fee_blank');
    expect(codeOf(() => parseBuilderFees({ [VENUE]: { defaultGroup: 'g', groups: { g: '1' }, extra: 1 } }))).toBe(
      'trade.builder_fee_blank',
    );
  });

  it("is never above the venue's own cap on any market it applies to; at the cap is allowed", () => {
    expect(() => assertWithinVenueCaps(book({ 'all-markets': '10' }), venue)).not.toThrow();
    // 10.5 is within spot's 100 but above the perpetual's 10, and the default group covers the perpetual too.
    expect(codeOf(() => assertWithinVenueCaps(book({ 'all-markets': '10.5' }), venue))).toBe('trade.builder_fee_above_venue_cap');
    expect(() =>
      assertWithinVenueCaps(book({ 'all-markets': '100', perpetuals: '10' }, { 'BTC-PERP': 'perpetuals' }), venue),
    ).not.toThrow();
    expect(
      codeOf(() => assertWithinVenueCaps(book({ 'all-markets': '100.0001', perpetuals: '1' }, { 'BTC-PERP': 'perpetuals' }), venue)),
    ).toBe('trade.builder_fee_above_venue_cap');
  });

  it('a cap the venue does not publish, a venue the door does not reach, the door off, or an unlisted market refuse', () => {
    const uncapped = { venueId: VENUE, markets: [market('BTC-USDC', null)] };
    expect(codeOf(() => assertWithinVenueCaps(book({ 'all-markets': '0' }), uncapped))).toBe('trade.builder_fee_cap_unknown');
    // A venue that sends no cap field at all publishes none.
    const { builderFeeCapBps: _gone, ...bare } = market('BTC-USDC', '100');
    const silent = { venueId: VENUE, markets: [bare as unknown as UserVenueMarket] };
    expect(codeOf(() => assertWithinVenueCaps(book({ 'all-markets': '0' }), silent))).toBe('trade.builder_fee_cap_unknown');
    expect(codeOf(() => assertWithinVenueCaps(book({ 'all-markets': '1' }), { ...venue, venueId: 'other' }))).toBe(
      'trade.builder_fee_venue_unknown',
    );
    expect(codeOf(() => assertWithinVenueCaps(book({ 'all-markets': '1' }), null))).toBe('trade.builder_fee_venue_unknown');
    expect(codeOf(() => assertWithinVenueCaps(book({ 'all-markets': '1', g: '1' }, { 'DOGE-USDC': 'g' }), venue))).toBe(
      'trade.builder_fee_market_unknown',
    );
  });
});
