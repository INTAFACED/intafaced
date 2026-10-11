import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PayError } from '../payment-service.js';
import {
  PRECHARGE_NOTIFY_UNPUBLISHED,
  SUBSCRIPTION_NOTIFY_FAILED,
  SUBSCRIPTION_NOTIFY_UNWIRED,
  assertPrechargeNotifyUnpublished,
  mandateChargeDisposition,
  pathOpensMoney,
  preChargeNotifyGap,
  recordPreChargeNotifyAttempt,
} from './mandate-product.js';

/**
 * Pre-charge notify: durable attempt or named skip. Invent notified:true
 * or charge-against-mandate still fail this suite.
 */

const here = dirname(fileURLToPath(import.meta.url));

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('pre-charge notify — attempt recorded, never pretend delivered', () => {
  it('unwired gap is skipped_unwired and notified is false', () => {
    const gap = preChargeNotifyGap();
    expect(gap.code).toBe(SUBSCRIPTION_NOTIFY_UNWIRED);
    expect(gap.notifyStatus).toBe('skipped_unwired');
    expect(gap.notified).toBe(false);
    expect(() => assertPrechargeNotifyUnpublished(gap)).not.toThrow();
  });

  it('invented notified:true refuses pay.precharge_notify_unpublished', () => {
    expect(() =>
      assertPrechargeNotifyUnpublished({
        notified: true,
        status: 'unwired',
        code: SUBSCRIPTION_NOTIFY_UNWIRED,
      }),
    ).toThrow(PayError);
    try {
      assertPrechargeNotifyUnpublished({ notified: true, status: 'unwired', code: SUBSCRIPTION_NOTIFY_UNWIRED });
    } catch (e) {
      expect((e as PayError).code).toBe(PRECHARGE_NOTIFY_UNPUBLISHED);
    }
  });

  it('wired port → attempted; throwing port → failed; never notified true', async () => {
    const wired = await recordPreChargeNotifyAttempt({
      notify: () => undefined,
      subscriptionId: 's',
      occurrence: 0,
      path: 'crypto_invoice',
      merchantId: 'm',
      customerId: 'c',
      amount: '1',
      assetId: 'USDT',
      idempotencyKey: 'k',
    });
    expect(wired.notifyStatus).toBe('attempted');
    expect(wired.notified).toBe(false);

    const failed = await recordPreChargeNotifyAttempt({
      notify: () => {
        throw new Error('bus down');
      },
      subscriptionId: 's',
      occurrence: 0,
      path: 'crypto_invoice',
      merchantId: 'm',
      customerId: 'c',
      amount: '1',
      assetId: 'USDT',
      idempotencyKey: 'k',
    });
    expect(failed.notifyStatus).toBe('failed');
    expect(failed.code).toBe(SUBSCRIPTION_NOTIFY_FAILED);
    expect(failed.notified).toBe(false);
  });

  it('only an explicit in-app delivery-row proof makes the fire result notified', async () => {
    const delivered = await recordPreChargeNotifyAttempt({
      notify: () => ({ inAppDeliveryRowExists: true }),
      subscriptionId: 's',
      occurrence: 0,
      path: 'crypto_invoice',
      merchantId: 'm',
      customerId: 'c',
      amount: '1',
      assetId: 'USDT',
      idempotencyKey: 'k',
    });
    expect(delivered.inAppDeliveryRowExists).toBe(true);
    expect(delivered.notified).toBe(true);
    expect(() => assertPrechargeNotifyUnpublished(delivered)).not.toThrow();
  });

  it('a bare boolean true is not in-app delivery and is not a delivery claim', async () => {
    const bare = await recordPreChargeNotifyAttempt({
      notify: () => true,
      subscriptionId: 's',
      occurrence: 0,
      path: 'crypto_invoice',
      merchantId: 'm',
      customerId: 'c',
      amount: '1',
      assetId: 'USDT',
      idempotencyKey: 'k',
    });
    expect(bare.notifyStatus).toBe('attempted');
    expect(bare.notified).toBe(false);
    expect(bare.inAppDeliveryRowExists).toBe(false);
    expect(() => assertPrechargeNotifyUnpublished(bare)).not.toThrow();
  });

  it('card pull stays closed — invent charge-against-mandate cannot open money', () => {
    expect(pathOpensMoney('card')).toBe(false);
    const card = mandateChargeDisposition('card');
    expect(card.kind).toBe('refuse');
    if (card.kind === 'refuse') {
      expect(card.code).toBe('pay.mandate_rail_absent');
    }
  });

  it('fire records notify then openInvoice and never writes notified:true', () => {
    const fire = stripComments(readFileSync(join(here, 'subscription-service.ts'), 'utf8'));
    const recordAt = fire.indexOf('recordPreChargeNotifyAttempt({');
    const assertAt = fire.indexOf('assertPrechargeNotifyUnpublished(notify)');
    const openCallAt = fire.indexOf('this.openInvoice({');
    expect(recordAt).toBeGreaterThan(-1);
    expect(assertAt).toBeGreaterThan(recordAt);
    expect(openCallAt).toBeGreaterThan(assertAt);
    expect(fire).toMatch(/notify_status/);
    expect(fire).toMatch(/skipped_unwired|notifyPreCharge/);
    expect(fire).not.toMatch(/notified:\s*true/);
    expect(fire).not.toMatch(/chargeAgainstMandate|pullMandate/);
  });
});
