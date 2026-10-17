import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { payCheckoutSettingsGetInputSchema, payCheckoutSettingsSchema, payPaymentListInputSchema } from './index.js';

const merchantId = '11111111-1111-4111-8111-111111111111';

describe('payment.list linkId', () => {
  it('accepts an optional link id and rejects a non-uuid', () => {
    const linkId = randomUUID();
    expect(payPaymentListInputSchema.parse({ merchantId, limit: 10, linkId }).linkId).toBe(linkId);
    expect(payPaymentListInputSchema.parse({ merchantId, limit: 10 }).linkId).toBeUndefined();
    expect(payPaymentListInputSchema.safeParse({ merchantId, limit: 10, linkId: 'not-a-link' }).success).toBe(false);
  });
});

describe('merchant.checkoutSettings.get', () => {
  it('accepts not_configured and a stored profile, and rejects a filled-in empty state', () => {
    expect(payCheckoutSettingsGetInputSchema.parse({ merchantId })).toEqual({ merchantId });
    expect(payCheckoutSettingsSchema.parse({ status: 'not_configured' })).toEqual({ status: 'not_configured' });
    expect(payCheckoutSettingsSchema.safeParse({ status: 'not_configured', domains: [], checkoutConfig: {}, feeRouting: {} }).success).toBe(
      false,
    );
    const profileId = randomUUID();
    expect(
      payCheckoutSettingsSchema.parse({
        status: 'configured',
        profileId,
        checkoutConfig: { brandName: 'North' },
        feeRouting: {},
        domains: ['checkout.example'],
        createdAt: '2026-10-17T00:00:00.000Z',
      }),
    ).toMatchObject({ profileId, domains: ['checkout.example'] });
    expect(
      payCheckoutSettingsSchema.safeParse({
        status: 'configured',
        profileId,
        checkoutConfig: {},
        feeRouting: {},
        domains: [],
        createdAt: '2026-10-17T00:00:00.000Z',
        feeBps: 250,
      }).success,
    ).toBe(false);
    const hidden = payCheckoutSettingsSchema.parse({
      status: 'configured',
      profileId,
      checkoutConfig: { brandName: 'North' },
      feeRouting: null,
      domains: ['checkout.example'],
      createdAt: '2026-10-17T00:00:00.000Z',
    });
    expect(hidden.feeRouting).toBeNull();
    expect(hidden.checkoutConfig).toEqual({ brandName: 'North' });
  });
});
