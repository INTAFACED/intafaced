import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { PayError } from '../payment-service.js';
import { MAX_ATTEMPTS_PER_CYCLE } from './charge-cycle.js';
import {
  CARD_MANDATE_CHARGE_SOCKET,
  DUNNING_STALL_REASON,
  MANDATE_PATH_MATRIX,
  PRECHARGE_NOTIFY_SOCKET,
  PRECHARGE_NOTIFY_UNPUBLISHED,
  SUBSCRIPTION_NOTIFY_UNWIRED,
  acknowledgePreChargeNotifyBeforeCharge,
  assertChargeTracesToMandate,
  assertPrechargeNotifyUnpublished,
  dunningAttemptsExhausted,
  mandateChargeDisposition,
  mandateDunningBound,
  normaliseSubscriptionPath,
  pathOpensMoney,
  preChargeNotifyGap,
  subscriptionsProductPosture,
} from './mandate-product.js';
import { assertMandateTermsUnchanged } from './subscription-service.js';

/**
 * D26-P1-P6 — mandate product paths + notify honesty (no invent).
 * Lifecycle pins that must stay true for the Done bar.
 */
describe('mandate product paths (card + crypto honest)', () => {
  it('matrix names both paths and only crypto opens money', () => {
    expect(MANDATE_PATH_MATRIX.map((r) => r.path)).toEqual(['crypto_invoice', 'card']);
    expect(MANDATE_PATH_MATRIX.every((r) => r.opensMoney === (r.charge === 'open_crypto_invoice'))).toBe(true);
    expect(pathOpensMoney('crypto_invoice')).toBe(true);
    expect(pathOpensMoney('card')).toBe(false);
    expect(pathOpensMoney('card_mandate')).toBe(false);
  });

  it('crypto disposition opens an invoice — never a pull name', () => {
    expect(mandateChargeDisposition('crypto_invoice')).toEqual({ kind: 'open_crypto_invoice' });
  });

  it('card disposition refuses pay.mandate_rail_absent and names the acquirer socket', () => {
    const d = mandateChargeDisposition('card');
    expect(d).toEqual({
      kind: 'refuse',
      code: 'pay.mandate_rail_absent',
      socket: CARD_MANDATE_CHARGE_SOCKET,
    });
    expect(CARD_MANDATE_CHARGE_SOCKET).toBe('socket.psp-partners');
    expect(mandateChargeDisposition('card_mandate').kind).toBe('refuse');
  });

  it('unknown path still refuses at normalise — no silent crypto invent', () => {
    expect(() => normaliseSubscriptionPath('pull_invented')).toThrow(PayError);
    expect(() => mandateChargeDisposition('pull_invented')).toThrow(PayError);
  });
});

describe('mandate lifecycle law (SPEC §4 Done bar pieces)', () => {
  it('charge must trace to an active mandate with matching amount', () => {
    const amount = parseAmount('12.50');
    expect(() =>
      assertChargeTracesToMandate({
        executionSubscriptionId: 'sub_1',
        subscriptionId: 'sub_1',
        mandateId: 'md_1',
        mandateStatus: 'active',
        amount,
        mandateAmount: amount,
      }),
    ).not.toThrow();
  });

  it('refuses a charge with no mandate id', () => {
    try {
      assertChargeTracesToMandate({
        executionSubscriptionId: 'sub_1',
        subscriptionId: 'sub_1',
        mandateId: null,
        mandateStatus: 'active',
        amount: parseAmount('1'),
        mandateAmount: parseAmount('1'),
      });
      throw new Error('should have refused');
    } catch (e) {
      expect((e as PayError).code).toBe('pay.mandate_not_found');
    }
  });

  it('refuses a charge against a cancelled mandate', () => {
    try {
      assertChargeTracesToMandate({
        executionSubscriptionId: 'sub_1',
        subscriptionId: 'sub_1',
        mandateId: 'md_1',
        mandateStatus: 'cancelled',
        amount: parseAmount('1'),
        mandateAmount: parseAmount('1'),
      });
      throw new Error('should have refused');
    } catch (e) {
      expect((e as PayError).code).toBe('pay.mandate_inactive');
    }
  });

  it('price raise without re-consent is refused in code', () => {
    try {
      assertMandateTermsUnchanged({ amount: parseAmount('10'), ceiling: null }, { amount: parseAmount('11'), ceiling: null });
      throw new Error('should have refused');
    } catch (e) {
      expect((e as PayError).code).toBe('pay.subscription_reconsent_required');
    }
  });

  it('dunning is bounded then stalls — not an infinite retry invent', () => {
    expect(mandateDunningBound()).toEqual({
      maxAttemptsPerCycle: MAX_ATTEMPTS_PER_CYCLE,
      afterLimit: 'stall_named',
      stallReason: DUNNING_STALL_REASON,
    });
    expect(dunningAttemptsExhausted(MAX_ATTEMPTS_PER_CYCLE - 1)).toBe(false);
    expect(dunningAttemptsExhausted(MAX_ATTEMPTS_PER_CYCLE)).toBe(true);
    expect(MAX_ATTEMPTS_PER_CYCLE).toBeGreaterThan(0);
    expect(MAX_ATTEMPTS_PER_CYCLE).toBeLessThanOrEqual(5);
  });
});

describe('pre-charge notify — refuse invent + durable attempt', () => {
  it('names the unwired skip and forbids invent notified', () => {
    const gap = preChargeNotifyGap();
    expect(gap.status).toBe('unwired');
    expect(gap.notifyStatus).toBe('skipped_unwired');
    expect(gap.socket).toBe(PRECHARGE_NOTIFY_SOCKET);
    expect(gap.inventForbidden).toBe(true);
    expect(gap.notified).toBe(false);
    expect(gap.code).toBe(SUBSCRIPTION_NOTIFY_UNWIRED);
    expect(PRECHARGE_NOTIFY_SOCKET).toBe('socket.pay-precharge-notify');
    expect(PRECHARGE_NOTIFY_UNPUBLISHED).toBe('pay.precharge_notify_unpublished');
  });

  it('fire-path acknowledge never reports notified true', () => {
    const ack = acknowledgePreChargeNotifyBeforeCharge({
      subscriptionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      occurrence: 0,
      path: 'crypto_invoice',
    });
    expect(ack.notified).toBe(false);
    expect(ack.status).toBe('unwired');
    expect(ack.notifyStatus).toBe('skipped_unwired');
    expect(ack.socket).toBe(PRECHARGE_NOTIFY_SOCKET);
    expect(ack.code).toBe(SUBSCRIPTION_NOTIFY_UNWIRED);
    expect(() => assertPrechargeNotifyUnpublished(ack)).not.toThrow();
  });

  it('wired port records attempted; unwired records skipped_unwired', async () => {
    const { recordPreChargeNotifyAttempt } = await import('./mandate-product.js');
    const calls: unknown[] = [];
    const unwired = await recordPreChargeNotifyAttempt({
      subscriptionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      occurrence: 0,
      path: 'crypto_invoice',
      merchantId: 'm',
      customerId: 'c',
      amount: '10',
      assetId: 'USDT',
      idempotencyKey: 'pay.subscription:cccccccc-cccc-4ccc-8ccc-cccccccccccc:0',
    });
    expect(unwired.notifyStatus).toBe('skipped_unwired');
    expect(unwired.code).toBe(SUBSCRIPTION_NOTIFY_UNWIRED);
    expect(unwired.notified).toBe(false);

    const wired = await recordPreChargeNotifyAttempt({
      notify: (event) => {
        calls.push(event);
      },
      subscriptionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      occurrence: 0,
      path: 'crypto_invoice',
      merchantId: 'm',
      customerId: 'c',
      amount: '10',
      assetId: 'USDT',
      idempotencyKey: 'pay.subscription:cccccccc-cccc-4ccc-8ccc-cccccccccccc:0',
    });
    expect(wired.notifyStatus).toBe('attempted');
    expect(wired.code).toBeNull();
    expect(wired.notified).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('invented notified:true refuses pay.precharge_notify_unpublished — no pretend', () => {
    try {
      assertPrechargeNotifyUnpublished({ notified: true, status: 'unwired', code: SUBSCRIPTION_NOTIFY_UNWIRED });
      throw new Error('should have refused');
    } catch (e) {
      expect((e as PayError).code).toBe('pay.precharge_notify_unpublished');
    }
    try {
      assertPrechargeNotifyUnpublished({ notified: false, status: 'published', code: SUBSCRIPTION_NOTIFY_UNWIRED });
      throw new Error('should have refused');
    } catch (e) {
      expect((e as PayError).code).toBe(PRECHARGE_NOTIFY_UNPUBLISHED);
    }
  });

  it('does not expose a notifyBeforeCharge invent helper that sets notified true', async () => {
    const mod = await import('./mandate-product.js');
    const keys = Object.keys(mod);
    expect(keys).not.toContain('notifyBeforeCharge');
    expect(keys).not.toContain('invoiceUpcoming');
    expect(keys).not.toContain('preChargeNotify');
    expect(keys).toContain('recordPreChargeNotifyAttempt');
  });
});

describe('subscriptionsProductPosture — Ready honesty', () => {
  it('crypto complete + card refuse + notify absent in one merchant-readable object', () => {
    const p = subscriptionsProductPosture();
    expect(p.mountain).toBe('pay.subscriptions');
    expect(p.crypto.status).toBe('product_complete');
    expect(p.card.code).toBe('pay.mandate_rail_absent');
    expect(p.preChargeNotify.notified).toBe(false);
    expect(p.preChargeNotify.code).toBe(SUBSCRIPTION_NOTIFY_UNWIRED);
    expect(p.preChargeNotify.notifyStatus).toBe('skipped_unwired');
    expect(p.preChargeNotify.socket).toBe(PRECHARGE_NOTIFY_SOCKET);
    expect(p.cancel.immediacy).toBe('immediate');
    expect(p.reconsent.code).toBe('pay.subscription_reconsent_required');
    expect(p.dunning.stallReason).toBe('arrears');
  });
});
