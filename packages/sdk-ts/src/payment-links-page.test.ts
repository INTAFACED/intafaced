import { describe, expect, it } from 'vitest';
import { createPayClient } from './index.js';
import { parsePaymentLinkPage } from './payment-links-page.js';

const LINK = '66666666-6666-4666-8666-666666666666';

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: LINK,
    prefix: 'pl_test',
    label: 'Invoice',
    amount: '10.00',
    currency: 'USDT',
    active: true,
    expiresAt: '2026-11-01T00:00:00.000Z',
    maxUses: 3,
    uses: 1,
    createdAt: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('payment link page', () => {
  it('returns items and a null cursor on the last page', () => {
    const page = parsePaymentLinkPage({ items: [item({ amount: null, currency: null, maxUses: null })], nextCursor: null });
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).toMatchObject({ id: LINK, amount: null, currency: null, maxUses: null, uses: 1 });
    expect(Array.isArray(page)).toBe(false);
  });

  it('refuses a bare array and a numeric amount', () => {
    expect(() => parsePaymentLinkPage([item()])).toThrow(/\{ items, nextCursor \}/);
    expect(() => parsePaymentLinkPage({ items: [item({ amount: 10 })], nextCursor: null })).toThrow(/decimal string/);
  });
});

describe('getPaymentLinks', () => {
  it('returns the page', async () => {
    const pay = createPayClient({
      baseUrl: 'https://pay.example/api/pay/v1',
      apiKey: 'ifc_test_x',
      maxRetries: 0,
      transport: async () => ({ status: 200, body: JSON.stringify({ items: [item()], nextCursor: 'cursor-1' }) }),
    });
    const page = await pay.getPaymentLinks({ query: { merchantId: '22222222-2222-4222-8222-222222222222', limit: '50' } });
    expect(page.nextCursor).toBe('cursor-1');
    expect(page.items[0]?.amount).toBe('10.00');
  });

  it('refuses a body that is still a bare array', async () => {
    const pay = createPayClient({
      baseUrl: 'https://pay.example/api/pay/v1',
      apiKey: 'ifc_test_x',
      maxRetries: 0,
      transport: async () => ({ status: 200, body: JSON.stringify([item()]) }),
    });
    await expect(pay.getPaymentLinks({ query: { merchantId: '22222222-2222-4222-8222-222222222222' } })).rejects.toThrow(
      /\{ items, nextCursor \}/,
    );
  });
});
