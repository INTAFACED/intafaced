import { describe, expect, it } from 'vitest';
import type { CheckoutMethodRule } from '@intafaced/contracts';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { CryptoNativeAdapter } from '../rails/crypto-native.js';
import { MemoryChain } from '../rails/chain-port.js';
import { RailRegistry } from '../rails/registry.js';
import { REFERENCE_RAIL_ROUTING_PROFILES } from '../routing/decide.js';
import { connectionOf, defaultRules, methodRailsOf, offerFor, payableMethods, type MethodRails } from './catalogue.js';

/** The method catalogue and the offer rule (M-adv-payments-core-11, J-merchant-04 step 7). Pure: no database. */

function registry(): RailRegistry {
  return new RailRegistry([
    new CryptoNativeAdapter({
      chain: new MemoryChain(),
      secret: 'methods-crypto-test-secret-at-least-32',
      minConfirmations: 6,
      toleranceSeconds: 300,
    }),
    new CardSandboxAdapter({ secret: 'methods-card-test-secret-at-least-32-chars', toleranceSeconds: 300 }),
  ]);
}

const rule = (method: CheckoutMethodRule['method'], enabled: boolean, over: Partial<CheckoutMethodRule> = {}): CheckoutMethodRule => ({
  method,
  enabled,
  ruleAsset: null,
  minAmount: null,
  maxAmount: null,
  ...over,
});

describe('which methods the public checkout can take', () => {
  it('is each checkout rail under the method it writes, with its profile countries', () => {
    const rails = methodRailsOf({
      checkoutRails: [
        { railId: 'crypto-native', method: 'crypto' },
        { railId: 'card-sandbox', method: 'card' },
      ],
      profiles: REFERENCE_RAIL_ROUTING_PROFILES,
      rails: registry(),
      policy: 'allow-sandbox',
    });
    expect([...rails.entries()]).toEqual([
      ['crypto', { countries: ['*'] }],
      ['card', { countries: ['*'] }],
    ]);
  });

  it('leaves out a rail that is not registered, whose profile does not take the method, or that may not take strangers money', () => {
    const base = { profiles: REFERENCE_RAIL_ROUTING_PROFILES, rails: registry() };
    expect(
      methodRailsOf({ ...base, checkoutRails: [{ railId: 'bank-nowhere', method: 'bank_debit' }], policy: 'allow-sandbox' }).size,
    ).toBe(0);
    expect(
      methodRailsOf({ ...base, checkoutRails: [{ railId: 'card-sandbox', method: 'bank_debit' }], policy: 'allow-sandbox' }).size,
    ).toBe(0);
    expect(methodRailsOf({ ...base, checkoutRails: [{ railId: 'card-sandbox', method: 'card' }], policy: 'live-only' }).size).toBe(0);
    expect(methodRailsOf({ ...base, checkoutRails: [], policy: 'allow-sandbox' }).size).toBe(0);
    // RC-merchant-08: a rail the business's category does not allow is not one of its methods.
    const both = [
      { railId: 'crypto-native', method: 'crypto' },
      { railId: 'card-sandbox', method: 'card' },
    ];
    expect([...methodRailsOf({ ...base, checkoutRails: both, policy: 'allow-sandbox', onlyRails: ['crypto-native'] }).keys()]).toEqual([
      'crypto',
    ]);
  });

  it('reads methods and countries the way routing does: trimmed, methods in lower case, countries in upper case', () => {
    const rails = methodRailsOf({
      checkoutRails: [{ railId: 'card-sandbox', method: ' Card ' }],
      profiles: [{ railId: 'card-sandbox', methods: ['CARD'], countries: [' de', 'fr ', 'DE'] }],
      rails: registry(),
      policy: 'allow-sandbox',
    });
    expect([...rails.entries()]).toEqual([['card', { countries: ['DE', 'FR'] }]]);
  });
});

describe('the offer a payer gets', () => {
  const cryptoOnly: MethodRails = new Map([['crypto', { countries: ['*'] }]]);
  const withCard: MethodRails = new Map([
    ['crypto', { countries: ['*'] }],
    ['card', { countries: ['DE'] }],
  ]);

  it('defaults to the catalogue order with only the connected methods on, so nothing changes before a save', () => {
    expect(defaultRules(cryptoOnly).map((r) => [r.method, r.enabled])).toEqual([
      ['crypto', true],
      ['card', false],
      ['bank_debit', false],
      ['pay_later', false],
      ['bank_transfer', false],
    ]);
    // A connected TEST bank is on by default too, last in the order.
    const withBank: MethodRails = new Map([...cryptoOnly, ['bank_transfer', { countries: ['*'] }]]);
    expect(defaultRules(withBank).map((r) => [r.method, r.enabled])).toEqual([
      ['crypto', true],
      ['card', false],
      ['bank_debit', false],
      ['pay_later', false],
      ['bank_transfer', true],
    ]);
    expect(connectionOf('bank_transfer', cryptoOnly)).toEqual({ state: 'not_connected', notice: 'rail.bank' });
    expect(connectionOf('bank_debit', cryptoOnly)).toEqual({ state: 'not_connected', notice: 'rail.bank' });
    expect(connectionOf('pay_later', cryptoOnly)).toEqual({ state: 'not_connected', notice: 'rail.card' });
    expect(connectionOf('crypto', new Map())).toEqual({ state: 'not_connected', notice: 'rail.crypto' });
  });

  it('keeps the business order and names why each other method is left out', () => {
    const rules = [rule('bank_debit', true), rule('card', true), rule('crypto', true), rule('pay_later', false)];
    const eur = offerFor(rules, withCard, { country: 'de', currency: 'eur' });
    expect(eur).toEqual({
      offered: [
        { method: 'bank_debit', connection: { state: 'not_connected', notice: 'rail.bank' } },
        { method: 'card', connection: { state: 'connected' } },
      ],
      leftOut: [
        { method: 'crypto', reason: 'currency' },
        { method: 'pay_later', reason: 'off' },
      ],
    });
    expect(payableMethods(eur)).toEqual(['card']);
    // A rail with no profile for the country leaves its method out; a method with no rail is still listed with its notice.
    expect(offerFor(rules, withCard, { country: 'US', currency: 'EUR' }).leftOut).toContainEqual({ method: 'card', reason: 'country' });
    expect(payableMethods(offerFor(rules, withCard, { country: 'US', currency: 'EUR' }))).toEqual([]);
  });

  it('applies a minimum and maximum, by value, only when the payment is in their asset and has an amount', () => {
    const rules = [rule('crypto', true, { ruleAsset: 'USDT', minAmount: '9.5', maxAmount: '10' })];
    const at = (currency: string, amount?: string) =>
      offerFor(rules, cryptoOnly, { country: 'DE', currency, ...(amount ? { amount } : {}) }).leftOut;
    expect(at('USDT', '9.49')).toEqual([{ method: 'crypto', reason: 'below_min' }]);
    expect(at('USDT', '10.000000000000000001')).toEqual([{ method: 'crypto', reason: 'above_max' }]);
    expect(at('USDT', '9.5')).toEqual([]);
    expect(at('USDT', '10')).toEqual([]);
    expect(at('USDT')).toEqual([]);
    expect(at('USDC', '1000')).toEqual([]);
  });
});
