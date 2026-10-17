import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  payCreateLinkInputSchema,
  payCreateLinkOutputSchema,
  payGetLinkInputSchema,
  payLinkListItemSchema,
  payLinkListPageSchema,
} from './pay-payment-links.js';

const merchantId = '11111111-1111-4111-8111-111111111111';

describe('payment link contracts', () => {
  it('accepts a create with an idempotency key and refuses a JSON-number amount', () => {
    expect(
      payCreateLinkInputSchema.parse({
        merchantId,
        label: 'Invoice',
        idempotencyKey: 'link:invoice:1',
      }),
    ).toMatchObject({ label: 'Invoice', idempotencyKey: 'link:invoice:1' });
    expect(payCreateLinkInputSchema.safeParse({ merchantId, label: 'Invoice', amount: 10 }).success).toBe(false);
    expect(payCreateLinkInputSchema.safeParse({ merchantId, label: 'Invoice', extra: true }).success).toBe(false);
  });

  it('requires a checkout path on create and allows a null path on an older list row', () => {
    const id = randomUUID();
    const created = payCreateLinkOutputSchema.parse({
      id,
      token: 'pl_testtokenvalue',
      prefix: 'pl_testtok',
      label: 'Invoice',
      expiresAt: '2026-10-17T00:00:00.000Z',
      maxUses: 1,
      checkoutUrl: '/checkout?token=pl_testtokenvalue',
    });
    expect(created.checkoutUrl).toContain('pl_testtokenvalue');
    expect(payCreateLinkOutputSchema.safeParse({ ...created, checkoutUrl: undefined }).success).toBe(false);

    const legacy = payLinkListItemSchema.parse({
      id,
      prefix: 'pl_legacyx',
      label: 'Old',
      amount: null,
      currency: null,
      active: true,
      expiresAt: null,
      maxUses: null,
      uses: 0,
      createdAt: '2026-10-17T00:00:00.000Z',
      token: null,
      checkoutUrl: null,
    });
    expect(legacy.checkoutUrl).toBeNull();
    expect(
      payLinkListPageSchema.parse({
        items: [{ ...legacy, token: 'pl_testtokenvalue', checkoutUrl: '/checkout?token=pl_testtokenvalue', amount: '10.00' }],
        nextCursor: null,
      }).items[0]?.token,
    ).toBe('pl_testtokenvalue');
  });

  it('getLink takes the merchant and the link', () => {
    const linkId = randomUUID();
    expect(payGetLinkInputSchema.parse({ merchantId, linkId })).toEqual({ merchantId, linkId });
    expect(payGetLinkInputSchema.safeParse({ merchantId, linkId: 'not-a-link' }).success).toBe(false);
  });
});
