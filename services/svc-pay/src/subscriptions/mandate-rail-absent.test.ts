import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PayError } from '../payment-service.js';
import { shouldRegisterCardSandbox } from '../rails/posture.js';
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

const here = dirname(fileURLToPath(import.meta.url));
const svcPaySrc = join(here, '..');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

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

describe('fire path — card refuse is before openInvoice', () => {
  it('attemptCycle uses mandateChargeDisposition and does not openInvoice on refuse', () => {
    const fire = stripComments(readFileSync(join(here, 'subscription-service.ts'), 'utf8'));
    expect(fire).toMatch(/mandateChargeDisposition\s*\(\s*sub\.path\s*\)/);
    const refuseAt = fire.indexOf("disposition.kind === 'refuse'");
    const openAt = fire.indexOf('this.openInvoice(');
    expect(refuseAt).toBeGreaterThan(-1);
    expect(openAt).toBeGreaterThan(refuseAt);
    const refuseArm = fire.slice(refuseAt, openAt);
    expect(refuseArm).toMatch(/disposition\.code/);
    expect(refuseArm).not.toMatch(/openInvoice\s*\(/);
    expect(refuseArm).not.toMatch(/chargeAgainstMandate|pullMandate|createPayment\s*\(/);
  });

  it('does not invent an on-chain pull or charge-against-mandate helper', () => {
    const fire = stripComments(readFileSync(join(here, 'subscription-service.ts'), 'utf8'));
    const product = stripComments(readFileSync(join(here, 'mandate-product.ts'), 'utf8'));
    for (const src of [fire, product]) {
      expect(src).not.toMatch(/chargeAgainstMandate|chargeMandate|pullMandate|approve\(/);
    }
  });
});

describe('registered rails have no mandate pull', () => {
  it('no adapter declares mandate or implements charge-against-mandate', () => {
    const railsDir = join(svcPaySrc, 'rails');
    const adapters = ['card-sandbox.ts', 'crypto-native.ts', 'bank-payout.ts'];
    for (const file of adapters) {
      const src = stripComments(readFileSync(join(railsDir, file), 'utf8'));
      expect(src, file).not.toMatch(/capabilities[^=]*=\s*\[[^\]]*['"]mandate['"]/);
      expect(src, file).not.toMatch(/chargeAgainstMandate|chargeMandate\s*\(/);
    }
    expect(readdirSync(railsDir).filter((f) => f.endsWith('.ts'))).toEqual(expect.arrayContaining(adapters));
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
    const tracker = readFileSync(join(here, '../../../../tooling/tracker/features.mjs'), 'utf8');
    const start = tracker.indexOf("f('pay.subscriptions'");
    expect(start).toBeGreaterThan(-1);
    const next = tracker.indexOf('\n  f(', start + 1);
    const block = tracker.slice(start, next === -1 ? undefined : next);
    expect(block).toMatch(/pay\.mandate_rail_absent/);
    expect(block).toMatch(/socket\.psp-partners/);
    expect(block).toMatch(/pre-charge|precharge/i);
  });
});
