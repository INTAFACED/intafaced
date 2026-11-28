import { describe, expect, it } from 'vitest';
import { PayError } from '../payment-service.js';
import { shouldRegisterCardSandbox } from '../rails/posture.js';
import { BankPayoutAbsentAdapter } from '../rails/bank-payout.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { MemoryChain } from '../rails/chain-port.js';
import { CryptoNativeAdapter } from '../rails/crypto-native.js';
import { FEATURES } from '../../../../tooling/tracker/features.mjs';
import { MAX_ATTEMPTS_PER_CYCLE } from './charge-cycle.js';
import {
  CARD_MANDATE_CHARGE_SOCKET,
  assertCardMandateCannotOpenMoney,
  mandateChargeDisposition,
  mandateDunningBound,
  pathOpensMoney,
} from './mandate-product.js';

/**
 * pay.subscriptions — card mandate recurring path stays rail-absent.
 *
 * #1848 (KYB money-gate) owns payment-service / subscription-service / router.
 * This suite pins the mandate door in mandate-product + source scans only.
 */

describe('card mandate cannot open money', () => {
  it('card and card_mandate refuse pay.mandate_rail_absent', () => {
    for (const path of ['card', 'card_mandate'] as const) {
      expect(pathOpensMoney(path)).toBe(false);
      expect(mandateChargeDisposition(path)).toEqual({
        kind: 'refuse',
        code: 'pay.mandate_rail_absent',
        socket: CARD_MANDATE_CHARGE_SOCKET,
      });
      expect(() => assertCardMandateCannotOpenMoney(path)).not.toThrow();
    }
  });

  it('crypto_invoice is the only money opener', () => {
    expect(pathOpensMoney('crypto_invoice')).toBe(true);
    expect(mandateChargeDisposition('crypto_invoice')).toEqual({ kind: 'open_crypto_invoice' });
    expect(() => assertCardMandateCannotOpenMoney('crypto_invoice')).not.toThrow();
  });

  it('fails if a card_mandate path can open money', () => {
    const d = mandateChargeDisposition('card_mandate');
    if (d.kind === 'open_crypto_invoice' || pathOpensMoney('card_mandate')) {
      throw new Error('card_mandate opened money — acquiring is still socket.psp-partners');
    }
    expect(d.code).toBe('pay.mandate_rail_absent');
  });

  it('unknown pull names refuse rather than invent a rail', () => {
    expect(() => mandateChargeDisposition('pull_invented')).toThrow(PayError);
    expect(() => pathOpensMoney('sepa_dd')).toThrow(PayError);
  });
});

describe('registered rails have no mandate pull', () => {
  it('no adapter declares mandate or implements charge-against-mandate', () => {
    const secret = 'mandate-rail-absent-secret-at-least-32-chars';
    const adapters = [
      new CardSandboxAdapter({ secret, toleranceSeconds: 300 }),
      new CryptoNativeAdapter({ chain: new MemoryChain(), secret, minConfirmations: 6, toleranceSeconds: 300 }),
      new BankPayoutAbsentAdapter(),
    ];
    expect(adapters.map((a) => a.id)).toEqual(['card-sandbox', 'crypto-native', 'bank-payout']);
    for (const adapter of adapters) {
      expect(adapter.capabilities, adapter.id).not.toContain('mandate');
      for (const pull of ['chargeAgainstMandate', 'chargeMandate', 'pullMandate']) {
        expect(Reflect.get(adapter, pull), `${adapter.id}.${pull}`).toBeUndefined();
      }
    }
  });
});

describe('the fire path and the mandate product hold no pull helper', () => {
  it('neither the subscription service nor the mandate product offers a pull, approve or charge-against-mandate', async () => {
    // Every export of both modules, and every method of the subscription service, by name: a pull added later is held.
    const pull = /chargeAgainstMandate|chargeMandate|pullMandate|cryptoPull|onchainPull|^approve$/i;
    const product: object = await import('./mandate-product.js');
    const fire: object = await import('./subscription-service.js');
    const { SubscriptionService } = await import('./subscription-service.js');
    const names = [...Object.keys(product), ...Object.keys(fire), ...Object.getOwnPropertyNames(SubscriptionService.prototype)];
    expect(names).toEqual(expect.arrayContaining(['mandateChargeDisposition', 'SubscriptionService', 'runDueSubscriptions']));
    expect(names.filter((name) => pull.test(name))).toEqual([]);
  });
});

describe('PAY_REGISTER_CARD_SANDBOX stays off in ship postures', () => {
  it('defaults off in staging and prod', () => {
    expect(shouldRegisterCardSandbox({ APP_ENV: 'staging' })).toBe(false);
    expect(shouldRegisterCardSandbox({ APP_ENV: 'prod' })).toBe(false);
  });
});

describe('bounded dunning stays parked — no invented magnitudes', () => {
  it('dunning bound is attempt count then named stall, not fees or retry money', () => {
    const bound = mandateDunningBound();
    expect(Object.keys(bound).sort()).toEqual(['afterLimit', 'maxAttemptsPerCycle', 'stallReason']);
    expect(bound.maxAttemptsPerCycle).toBe(MAX_ATTEMPTS_PER_CYCLE);
    expect(bound.afterLimit).toBe('stall_named');
    expect(bound).not.toHaveProperty('lateFee');
    expect(bound).not.toHaveProperty('retryAmount');
    expect(bound).not.toHaveProperty('feeBps');
  });
});

describe('tracker parks card rail and pre-charge (mountain event not this slice)', () => {
  it('pay.subscriptions note still names rail-absent and parked sockets', () => {
    const feature = FEATURES.find((f) => f.id === 'pay.subscriptions');
    expect(feature).toBeDefined();
    const declared = JSON.stringify(feature);
    expect(declared).toMatch(/pay\.mandate_rail_absent/);
    expect(declared).toMatch(/socket\.psp-partners/);
    expect(declared).toMatch(/pre-charge|precharge/i);
  });
});
