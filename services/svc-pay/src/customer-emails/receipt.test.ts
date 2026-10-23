import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MerchantOpsError } from '../merchant-ops/errors.js';
import { assertReceiptAddress, automaticReceipts, gateReceipt } from './receipt.js';

describe('receipt gate (M-plat-org-10)', () => {
  it('does not treat a pending or failed payment as paid', () => {
    expect(gateReceipt('payment', { status: 'authorized', captured: 0n, refunded: 0n })).toEqual({
      ok: false,
      hasCapture: false,
      code: 'pay.receipt_not_paid',
    });
    expect(gateReceipt('payment', { status: 'created', captured: 0n, refunded: 0n }).ok).toBe(false);
    expect(gateReceipt('payment', { status: 'failed', captured: 0n, refunded: 0n })).toMatchObject({
      ok: false,
      code: 'pay.receipt_not_offered',
      hasCapture: false,
    });
    expect(gateReceipt('payment', { status: 'captured', captured: 0n, refunded: 0n })).toMatchObject({
      ok: false,
      code: 'pay.receipt_not_paid',
    });
  });

  it('offers a payment receipt only after a real capture, and a refund receipt only for a real refund', () => {
    expect(gateReceipt('payment', { status: 'captured', captured: 10n, refunded: 4n })).toEqual({ ok: true, hasCapture: true });
    expect(gateReceipt('refund', { status: 'captured', captured: 10n, refunded: 4n })).toEqual({ ok: true, hasCapture: true });
    expect(gateReceipt('refund', { status: 'captured', captured: 10n, refunded: 0n })).toMatchObject({
      ok: false,
      code: 'pay.receipt_refund_absent',
    });
    expect(gateReceipt('payment', { status: 'refunded', captured: 10n, refunded: 10n }).ok).toBe(true);
    expect(gateReceipt('payment', { status: 'disputed', captured: 10n, refunded: 0n }).ok).toBe(true);
  });

  it('stops automatic receipts unless the merchant turned them on, and on is still not connected', () => {
    expect(automaticReceipts(null)).toBe('stopped');
    expect(automaticReceipts(false)).toBe('stopped');
    expect(automaticReceipts(true)).toBe('not_connected');
  });

  it('refuses a blank or unusable address without echoing it', () => {
    for (const address of ['', '   ', 'not-an-email', 'a@b', 'has space@example.test']) {
      try {
        assertReceiptAddress(address);
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(MerchantOpsError);
        expect((error as MerchantOpsError).code).toBe('pay.receipt_address_invalid');
        expect((error as Error).message).not.toContain('@');
        if (address.trim() !== '') expect((error as Error).message).not.toContain(address.trim());
      }
    }
    expect(() => assertReceiptAddress('Payer@Example.test')).not.toThrow();
  });

  it('does not hook receipt send into payment capture', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'payment-service.ts'), 'utf8');
    expect(src).not.toContain('customerEmails');
    expect(src).not.toContain('vendor.email');
    expect(src).not.toContain('ReceiptService');
  });
});
