import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRECHARGE_NOTIFY_SOCKET, preChargeNotifyGap } from './subscriptions/mandate-product.js';

/**
 * SPEC §4: "Every charge is notified before it lands, not after."
 *
 * Unwired bus ? skipped_unwired on the execution. Merchant webhooks remain
 * post-payment. Never invent notified:true.
 */

const here = dirname(fileURLToPath(import.meta.url));

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('pre-charge notify — honest skip when unwired', () => {
  it('names skipped_unwired and forbids invent notified', () => {
    expect(preChargeNotifyGap().socket).toBe(PRECHARGE_NOTIFY_SOCKET);
    expect(preChargeNotifyGap().status).toBe('unwired');
    expect(preChargeNotifyGap().notifyStatus).toBe('skipped_unwired');
    expect(preChargeNotifyGap().inventForbidden).toBe(true);
    expect(preChargeNotifyGap().notified).toBe(false);
    expect(preChargeNotifyGap().code).toBe('pay.subscription_notify_unwired');
  });

  it('subscription fire path records notify then opens invoice', () => {
    const fire = stripComments(readFileSync(join(here, 'subscriptions/subscription-service.ts'), 'utf8'));
    expect(fire).toMatch(/recordPreChargeNotifyAttempt/);
    expect(fire).toMatch(/assertPrechargeNotifyUnpublished/);
    expect(fire).toMatch(/mandateChargeDisposition/);
    expect(fire).toMatch(/openInvoice/);
    expect(fire).not.toMatch(/merchantWebhook\s*\(/);
    expect(fire).not.toMatch(/(?<![A-Za-z])notifyBeforeCharge\s*\(/i);
    expect(fire).not.toMatch(/\.enqueue\s*\(/);
    expect(fire).not.toMatch(/notified:\s*true/);
  });

  it('index does not invent a payment-shaped pre-notify enqueue', () => {
    const index = stripComments(readFileSync(join(here, 'index.ts'), 'utf8'));
    expect(index).toMatch(/markExecutionSettledForPayment/);
    expect(index).not.toMatch(/notifyBeforeCharge/i);
  });
});
