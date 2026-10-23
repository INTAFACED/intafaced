import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkoutUrlFor, paymentLinkCreateFingerprint, paymentLinkCreateKey } from './payment-link-create.js';

const merchantId = '11111111-1111-4111-8111-111111111111';

describe('payment link create key and checkout path', () => {
  it('treats a missing key as no key, and refuses a blank or oversized one', () => {
    expect(paymentLinkCreateKey(undefined)).toEqual({ ok: true, key: undefined });
    expect(paymentLinkCreateKey('  invoice-1  ')).toEqual({ ok: true, key: 'invoice-1' });
    expect(paymentLinkCreateKey('   ').ok).toBe(false);
    expect(paymentLinkCreateKey('k'.repeat(256)).ok).toBe(false);
  });

  it('fingerprints the requested body, and an omitted expiry is not a clock value', () => {
    const base = {
      merchantId,
      label: 'Invoice',
      profileId: null,
      amount: '10.00',
      currency: 'USDT',
      expiresAt: 'default',
      maxUses: 1,
    };
    expect(paymentLinkCreateFingerprint(base)).toBe(paymentLinkCreateFingerprint({ ...base }));
    expect(paymentLinkCreateFingerprint(base)).not.toBe(paymentLinkCreateFingerprint({ ...base, label: 'Other' }));
    expect(paymentLinkCreateFingerprint(base)).not.toBe(paymentLinkCreateFingerprint({ ...base, expiresAt: '2026-10-17T00:00:00.000Z' }));
    expect(paymentLinkCreateFingerprint({ ...base, profileId: merchantId.toUpperCase() })).toBe(
      paymentLinkCreateFingerprint({ ...base, profileId: merchantId }),
    );
    expect(paymentLinkCreateFingerprint(base)).toBe(paymentLinkCreateFingerprint({ ...base, confirmation: undefined }));
    expect(paymentLinkCreateFingerprint(base)).not.toBe(paymentLinkCreateFingerprint({ ...base, confirmation: 'message:Paid' }));
  });

  it('builds a checkout path and does not invent a host', () => {
    expect(checkoutUrlFor('pl_abc', '')).toBe('/checkout?token=pl_abc');
    expect(checkoutUrlFor('pl_abc', '/api/pay')).toBe('/api/pay/checkout?token=pl_abc');
    expect(checkoutUrlFor('pl_a b', '/api/pay/')).toBe('/api/pay/checkout?token=pl_a%20b');
    expect(checkoutUrlFor('pl_abc', '/api/pay')).not.toMatch(/^https?:/);
  });

  it('founder link drilldown copies the list fields and not the checkout credential', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'namespaces', 'founder-merchant-reads.ts'), 'utf8');
    const block = src.slice(src.indexOf("case 'links':"), src.indexOf("case 'invoices':"));
    expect(block).toContain('prefix: row.prefix');
    expect(block).not.toContain('checkoutUrl');
    expect(block).not.toContain('checkout_token');
    expect(block).not.toContain('...row');
  });
});
