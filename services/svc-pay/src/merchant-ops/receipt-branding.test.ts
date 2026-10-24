import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatMoney } from '@intafaced/i18n';
import { describe, expect, it } from 'vitest';
import { MerchantOpsError } from './errors.js';
import { ReceiptPrecisionInvalid, formatReceiptAmount, normalizeReceiptTemplate, type ReceiptTemplateInput } from './receipt-branding.js';

const here = dirname(fileURLToPath(import.meta.url));

function input(over: Partial<ReceiptTemplateInput> = {}): ReceiptTemplateInput {
  return {
    requestId: '00000000-0000-4000-8000-000000000001',
    logoRef: 'shop-logo',
    accent: '#abc',
    footer: '  Thanks  ',
    language: 'DE',
    ...over,
  };
}

function refusal(fn: () => void): MerchantOpsError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(MerchantOpsError);
    return error as MerchantOpsError;
  }
  throw new Error('expected a refusal');
}

describe('receipt branding (M-adv-payments-core-07)', () => {
  it('stores a canonical accent, footer and language, and refuses a blank or remote logo', () => {
    expect(normalizeReceiptTemplate(input())).toEqual({
      logoRef: 'shop-logo',
      accent: '#AABBCC',
      footer: 'Thanks',
      language: 'de',
    });
    expect(normalizeReceiptTemplate(input({ accent: 'rgb(10, 20, 30)', logoRef: null })).accent).toBe('#0A141E');
    expect(refusal(() => normalizeReceiptTemplate(input({ accent: '' }))).code).toBe('pay.receipt_accent_invalid');
    expect(refusal(() => normalizeReceiptTemplate(input({ accent: 'blue' }))).code).toBe('pay.receipt_accent_invalid');
    expect(refusal(() => normalizeReceiptTemplate(input({ logoRef: 'https://cdn.example/logo.png' }))).code).toBe(
      'pay.receipt_logo_invalid',
    );
    expect(refusal(() => normalizeReceiptTemplate(input({ logoRef: '' }))).code).toBe('pay.receipt_logo_invalid');
    expect(refusal(() => normalizeReceiptTemplate(input({ language: 'no-such-locale' }))).code).toBe('pay.receipt_language_invalid');
    expect(refusal(() => normalizeReceiptTemplate(input({ footer: 'x'.repeat(501) }))).code).toBe('pay.receipt_footer_invalid');
  });

  it('formats every published place for the locale and does not round extra places', () => {
    const shown = formatReceiptAmount('1234.5', 6, 'de', 'USDT');
    expect(shown).toBe(formatMoney('1234.5', 'USDT', 'de', { minFractionDigits: 6, maxFractionDigits: 6, display: 'code' }));
    const separator = new Intl.NumberFormat('de-DE').formatToParts(1.1).find((part) => part.type === 'decimal')!.value;
    expect(shown.split(' ')[0]!.split(separator)[1]).toBe('500000');
    expect(refusal(() => formatReceiptAmount('1.1234567', 6, 'de', 'USDT')).code).toBe('pay.receipt_amount_exceeds_precision');
    expect(refusal(() => formatReceiptAmount('nope', 6, 'en', 'USDT')).code).toBe('pay.receipt_amount_invalid');
    expect(refusal(() => formatReceiptAmount('1', 2, 'en', 'usdt')).code).toBe('pay.receipt_asset_invalid');
    expect(() => formatReceiptAmount('1', 19, 'en', 'USDT')).toThrow(ReceiptPrecisionInvalid);
  });

  it('does not queue a status email from capture, and the branding file never inserts the queue', () => {
    const branding = readFileSync(join(here, 'receipt-branding.ts'), 'utf8');
    const payments = readFileSync(join(here, '..', 'payment-service.ts'), 'utf8');
    expect(branding).not.toMatch(/insert into pay\.payment_status_email_queue/i);
    expect(payments).not.toContain('receipt-branding');
    expect(payments).not.toContain('payment_status_email_queue');
    expect(payments).not.toContain('vendor.email');
  });
});
