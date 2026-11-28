import type { FounderMerchantSectionInput } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { partial } from '@intafaced/service-kit/testing';
import { describe, expect, it } from 'vitest';
import { createFounderMerchantReads } from './namespaces/founder-merchant-reads.js';
import type { PayService } from './payment-service.js';
import { scriptedSql } from './scripted-sql.testkit.js';
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

  it('founder link drilldown copies the list fields and not the checkout credential', async () => {
    const linkRow = {
      id: '33333333-3333-4333-8333-333333333333',
      prefix: 'pl_abc',
      label: 'TEST link',
      amount: '10.50',
      currency: 'USDT',
      active: true,
      expiresAt: null,
      maxUses: null,
      uses: 0,
      createdAt: '2026-11-01T00:00:00.000Z',
      inactiveMessage: null,
      confirmationMessage: null,
      confirmationUrl: null,
      embedSnippet: null,
      priceId: null,
      // What the merchant's own list carries and the founder's must not.
      checkoutUrl: '/checkout?token=pl_abc_SECRET',
      checkout_token: 'pl_abc_SECRET',
      token: 'pl_abc_SECRET',
    };
    const pay = partial<PayService>({
      listPaymentLinks: async () => partial<Awaited<ReturnType<PayService['listPaymentLinks']>>>({ items: [linkRow], nextCursor: null }),
    });
    const { sql } = scriptedSql<Sql>((call) => (call.text.includes('FROM pay.merchants') ? [{ id: merchantId }] : []));
    const page = await createFounderMerchantReads({ sql, pay }).section('founder-1', {
      merchantId,
      section: 'links',
      limit: 10,
    } as FounderMerchantSectionInput);
    expect(page).toMatchObject({ section: 'links', nextCursor: null });
    const items = (page as { items: Array<Record<string, unknown>> }).items;
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]!).sort()).toEqual(
      ['id', 'prefix', 'label', 'amount', 'currency', 'active', 'expiresAt', 'maxUses', 'uses', 'createdAt'].sort(),
    );
    expect(items[0]).toMatchObject({ prefix: 'pl_abc', amount: '10.5' });
    expect(JSON.stringify(page)).not.toContain('SECRET');
  });
});
