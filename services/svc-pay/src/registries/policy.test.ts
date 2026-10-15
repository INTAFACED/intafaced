import { describe, expect, it } from 'vitest';
import { canonicalDecimal, compareDecimal, toScaled } from './decimal.js';
import {
  decidePayout,
  isNetworkRoutable,
  isVenueRoutable,
  isWalletRouteRoutable,
  networkDualReasons,
  networkMissing,
  venueDualReasons,
  venueMissing,
  walletRouteDualReasons,
  walletRouteMissing,
  type NetworkState,
  type VenueState,
  type WalletRouteState,
} from './policy.js';
import { looksLikeSecret } from './secret-guard.js';
import { networkSaveInputSchema, venueSaveInputSchema, walletRouteSaveInputSchema } from './schemas.js';

const venue = (o: Partial<VenueState> = {}): VenueState => ({
  venueId: 'binance-spot',
  displayName: 'Binance Spot',
  mode: 'testnet',
  priority: 1,
  enabled: true,
  minOrder: '10',
  maxOrder: '1000',
  supportedPairs: ['USDT/USD'],
  ...o,
});
const network = (o: Partial<NetworkState> = {}): NetworkState => ({
  networkId: 'ethereum',
  displayName: 'Ethereum',
  assetCodes: ['USDT'],
  confirmationsRequired: 12,
  enabled: true,
  feeEstimateSource: 'venue_quote',
  feeEstimateAmount: null,
  ...o,
});
const MERCHANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const route = (o: Partial<WalletRouteState> = {}): WalletRouteState => ({
  assetCode: 'USDT',
  networkId: 'ethereum',
  payoutAllowed: true,
  merchantAllow: [],
  merchantDeny: [],
  maxSinglePayout: '500',
  ...o,
});

describe('decimal strings', () => {
  it('compare as scaled integers, never floats', () => {
    expect(compareDecimal('0.1', '0.10')).toBe(0);
    expect(compareDecimal('10', '9.999999999999999999')).toBe(1);
    expect(compareDecimal('0.000000000000000001', '0')).toBe(1);
    expect(canonicalDecimal('007.500')).toBe('7.5');
    expect(canonicalDecimal('0.0')).toBe('0');
    expect(toScaled('1')).toBe(10n ** 18n);
  });
  it('refuses anything that is not an unsigned decimal', () => {
    for (const bad of ['-1', '1e3', '', ' 1', '1.', '.5', '0.1234567890123456789']) expect(() => toScaled(bad)).toThrow();
  });
});

describe('blank refuses: fully configured means every routing field is set', () => {
  it('a venue needs testnet mode, both limits, a positive max and a pair', () => {
    expect(isVenueRoutable(venue())).toBe(true);
    expect(venueMissing(venue({ minOrder: null }))).toEqual(['min_order']);
    expect(venueMissing(venue({ maxOrder: null }))).toEqual(['max_order']);
    expect(venueMissing(venue({ maxOrder: '0' }))).toEqual(['max_order']);
    expect(venueMissing(venue({ supportedPairs: [] }))).toEqual(['supported_pairs']);
    expect(venueMissing(venue({ mode: 'disabled' }))).toEqual(['mode']);
    expect(isVenueRoutable(venue({ enabled: false }))).toBe(false);
    expect(isVenueRoutable(venue({ minOrder: null }))).toBe(false);
  });
  it('a network needs assets, a confirmation count and a fee source (a fixed fee also an amount)', () => {
    expect(isNetworkRoutable(network())).toBe(true);
    expect(networkMissing(network({ assetCodes: [] }))).toEqual(['asset_codes']);
    expect(networkMissing(network({ confirmationsRequired: null }))).toEqual(['confirmations_required']);
    expect(networkMissing(network({ feeEstimateSource: null }))).toEqual(['fee_estimate_source']);
    expect(networkMissing(network({ feeEstimateSource: 'fixed', feeEstimateAmount: null }))).toEqual(['fee_estimate_source']);
    expect(isNetworkRoutable(network({ enabled: false }))).toBe(false);
  });
  it('a wallet route needs a payout cap', () => {
    expect(isWalletRouteRoutable(route())).toBe(true);
    expect(walletRouteMissing(route({ maxSinglePayout: null }))).toEqual(['max_single_payout']);
    expect(walletRouteMissing(route({ maxSinglePayout: '0' }))).toEqual(['max_single_payout']);
    expect(isWalletRouteRoutable(route({ payoutAllowed: false }))).toBe(false);
  });
});

describe('which changes need a second founder', () => {
  it('creating an entry never does (it is created switched off)', () => {
    expect(venueDualReasons(null, venue({ enabled: false }))).toEqual([]);
    expect(networkDualReasons(null, network({ enabled: false }))).toEqual([]);
    expect(walletRouteDualReasons(null, route({ payoutAllowed: false }))).toEqual([]);
  });
  it('enabling or disabling does, in both directions', () => {
    expect(venueDualReasons(venue({ enabled: false }), venue())).toEqual(['enabled']);
    expect(venueDualReasons(venue(), venue({ enabled: false }))).toEqual(['disabled']);
    expect(networkDualReasons(network({ enabled: false }), network())).toEqual(['enabled']);
    expect(networkDualReasons(network(), network({ enabled: false }))).toEqual(['disabled']);
    expect(walletRouteDualReasons(route({ payoutAllowed: false }), route())).toEqual(['payout_allowed']);
    expect(walletRouteDualReasons(route(), route({ payoutAllowed: false }))).toEqual(['payout_disallowed']);
  });
  it('a venue mode change does', () => {
    expect(venueDualReasons(venue({ enabled: false, mode: 'disabled' }), venue({ enabled: false, mode: 'testnet' }))).toEqual([
      'mode_changed',
    ]);
  });
  it('loosening an enabled venue does; tightening, renaming and re-ordering do not', () => {
    expect(venueDualReasons(venue(), venue({ maxOrder: '1001' }))).toEqual(['max_order_loosened']);
    expect(venueDualReasons(venue(), venue({ minOrder: '9' }))).toEqual(['min_order_loosened']);
    expect(venueDualReasons(venue(), venue({ supportedPairs: ['USDT/USD', 'USDC/USD'] }))).toEqual(['pairs_added']);
    expect(venueDualReasons(venue({ maxOrder: null }), venue({ maxOrder: '5' }))).toEqual(['max_order_loosened']);
    expect(venueDualReasons(venue(), venue({ maxOrder: '999', minOrder: '11', supportedPairs: [] }))).toEqual([]);
    expect(venueDualReasons(venue(), venue({ displayName: 'Binance', priority: 9 }))).toEqual([]);
  });
  it('edits to a venue that is off before and after are inert, so need nobody', () => {
    expect(venueDualReasons(venue({ enabled: false }), venue({ enabled: false, maxOrder: '99999' }))).toEqual([]);
  });
  it('loosening an enabled network does', () => {
    expect(networkDualReasons(network(), network({ confirmationsRequired: 6 }))).toEqual(['confirmations_lowered']);
    expect(networkDualReasons(network(), network({ confirmationsRequired: 24 }))).toEqual([]);
    expect(networkDualReasons(network(), network({ feeEstimateSource: 'chain_estimate' }))).toEqual(['fee_estimate_changed']);
    expect(networkDualReasons(network(), network({ assetCodes: ['USDT', 'USDC'] }))).toEqual(['assets_added']);
  });
  it('loosening an allowed wallet route does', () => {
    expect(walletRouteDualReasons(route(), route({ maxSinglePayout: '501' }))).toEqual(['max_single_payout_loosened']);
    expect(walletRouteDualReasons(route(), route({ maxSinglePayout: '1' }))).toEqual([]);
    expect(walletRouteDualReasons(route({ merchantAllow: [MERCHANT] }), route({ merchantAllow: [MERCHANT, OTHER] }))).toEqual([
      'allow_list_widened',
    ]);
    expect(walletRouteDualReasons(route({ merchantDeny: [MERCHANT] }), route({ merchantDeny: [] }))).toEqual(['deny_list_shortened']);
    expect(walletRouteDualReasons(route(), route({ merchantDeny: [MERCHANT] }))).toEqual([]);
  });
});

describe('payout decision: every missing piece refuses', () => {
  const ok = { merchantId: MERCHANT, amount: '100' };
  it('allows a configured route', () => expect(decidePayout(route(), network(), ok)).toEqual({ allowed: true }));
  it('refuses with a typed code for each gap', () => {
    expect(decidePayout(null, network(), ok)).toEqual({ allowed: false, code: 'registries.payout_no_route' });
    expect(decidePayout(route(), null, ok)).toMatchObject({ code: 'registries.payout_network_not_routable' });
    expect(decidePayout(route(), network({ enabled: false }), ok)).toMatchObject({ code: 'registries.payout_network_not_routable' });
    expect(decidePayout(route(), network({ confirmationsRequired: null }), ok)).toMatchObject({
      code: 'registries.payout_network_not_routable',
    });
    expect(decidePayout(route({ assetCode: 'DAI' }), network(), ok)).toMatchObject({ code: 'registries.payout_asset_not_on_network' });
    expect(decidePayout(route({ payoutAllowed: false }), network(), ok)).toMatchObject({ code: 'registries.payout_not_allowed' });
    expect(decidePayout(route({ maxSinglePayout: null }), network(), ok)).toMatchObject({ code: 'registries.payout_limit_blank' });
    expect(decidePayout(route(), network(), { ...ok, amount: '500.000000000000000001' })).toMatchObject({
      code: 'registries.payout_over_limit',
    });
    expect(decidePayout(route({ merchantDeny: [MERCHANT] }), network(), ok)).toMatchObject({ code: 'registries.payout_merchant_denied' });
    expect(decidePayout(route({ merchantAllow: [OTHER] }), network(), ok)).toMatchObject({
      code: 'registries.payout_merchant_not_allowed',
    });
  });
  it('deny beats allow, and the cap is inclusive', () => {
    expect(decidePayout(route({ merchantAllow: [MERCHANT], merchantDeny: [MERCHANT] }), network(), ok)).toMatchObject({ allowed: false });
    expect(decidePayout(route({ merchantAllow: [MERCHANT] }), network(), { ...ok, amount: '500' })).toEqual({ allowed: true });
  });
  it('compares merchant ids case-insensitively', () => {
    expect(decidePayout(route({ merchantDeny: [MERCHANT] }), network(), { ...ok, merchantId: MERCHANT.toUpperCase() })).toMatchObject({
      allowed: false,
    });
  });
});

describe('no credentials in any field', () => {
  it('the secret tripwire catches key-shaped text and lets ordinary names through', () => {
    for (const bad of [
      'sk_live_51H8abcdEFGH1234',
      'AKIAIOSFODNN7EXAMPLE',
      '0x' + 'ab'.repeat(32),
      '-----BEGIN PRIVATE KEY-----',
      'apiKey: abc',
      'secret=hunter2',
      'password: x',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
      'Bearer abcdefghijklmnopqrstuvwx',
      'Zk9x2Lq8Vb3Nm7Rt1Yc5Hd4Jw6Pa0Sg8XeUiOo',
    ]) {
      expect(looksLikeSecret(bad), bad).toBe(true);
    }
    for (const fine of ['Binance Spot (testnet)', 'Raise cap after Q4 review', 'Ethereum mainnet', 'tighten the limit']) {
      expect(looksLikeSecret(fine), fine).toBe(false);
    }
  });

  const venueInput = {
    venueId: 'binance-spot',
    displayName: 'Binance Spot',
    mode: 'disabled',
    priority: 1,
    enabled: false,
    minOrder: null,
    maxOrder: null,
    supportedPairs: [],
    expectedVersion: null,
    reason: 'initial entry',
  };
  it('an unknown secret-like field is a parse error, not silently dropped', () => {
    expect(venueSaveInputSchema.safeParse(venueInput).success).toBe(true);
    for (const field of ['secret', 'apiKey', 'apiSecret', 'passphrase', 'token', 'privateKey', 'credentials']) {
      expect(venueSaveInputSchema.safeParse({ ...venueInput, [field]: 'x' }).success, field).toBe(false);
    }
    expect(
      networkSaveInputSchema.safeParse({
        networkId: 'eth',
        displayName: 'E',
        assetCodes: [],
        confirmationsRequired: null,
        enabled: false,
        feeEstimateSource: null,
        feeEstimateAmount: null,
        expectedVersion: null,
        reason: 'new one',
        apiKey: 'x',
      }).success,
    ).toBe(false);
    expect(
      walletRouteSaveInputSchema.safeParse({
        assetCode: 'USDT',
        networkId: 'eth',
        payoutAllowed: false,
        merchantAllow: [],
        merchantDeny: [],
        maxSinglePayout: null,
        expectedVersion: null,
        reason: 'new one',
        address: '0xabc',
      }).success,
    ).toBe(false);
  });
  it('a secret pasted into a name or a reason is refused', () => {
    expect(venueSaveInputSchema.safeParse({ ...venueInput, displayName: 'sk_live_51H8abcdEFGH1234' }).success).toBe(false);
    expect(venueSaveInputSchema.safeParse({ ...venueInput, reason: 'key is AKIAIOSFODNN7EXAMPLE' }).success).toBe(false);
  });
  it('a fixed fee needs an amount and a non-fixed fee refuses one', () => {
    const net = {
      networkId: 'eth',
      displayName: 'E',
      assetCodes: [],
      confirmationsRequired: null,
      enabled: false,
      expectedVersion: null,
      reason: 'new one',
    };
    expect(networkSaveInputSchema.safeParse({ ...net, feeEstimateSource: 'fixed', feeEstimateAmount: null }).success).toBe(false);
    expect(networkSaveInputSchema.safeParse({ ...net, feeEstimateSource: 'venue_quote', feeEstimateAmount: '1' }).success).toBe(false);
    expect(networkSaveInputSchema.safeParse({ ...net, feeEstimateSource: 'fixed', feeEstimateAmount: '1.5' }).success).toBe(true);
  });
});
