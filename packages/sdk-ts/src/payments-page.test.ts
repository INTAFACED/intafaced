import { describe, expect, it } from 'vitest';
import { createPayClient } from './index.js';
import { parsePaymentPage, paymentPageFromResponse, type PayPayment } from './payments-page.js';

const MERCHANT = '22222222-2222-4222-8222-222222222222';

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    merchantId: MERCHANT,
    amount: '1.10',
    assetId: 'USD',
    status: 'captured',
    mode: 'sandbox',
    capturedAmount: '1.1',
    refundedAmount: '0',
    createdAt: '2026-10-16T00:00:00.000Z',
    pricingSnapshot: { fee: '0.05' },
    failure: null,
    ...overrides,
  };
}

describe('payment page', () => {
  it('returns items and a null cursor on the last page', () => {
    const page = parsePaymentPage({ items: [item()], nextCursor: null });
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ amount: '1.10', pricingSnapshot: { fee: '0.05' }, failure: null });
    expect(Array.isArray(page)).toBe(false);
  });

  it('keeps a cursor and a catalog failure', () => {
    const page = parsePaymentPage({
      items: [item({ pricingSnapshot: null, failure: { code: 'card.declined', message: 'The card was declined.' } })],
      nextCursor: 'cursor-1',
    });
    expect(page.nextCursor).toBe('cursor-1');
    expect(page.items[0]?.failure).toEqual({ code: 'card.declined', message: 'The card was declined.' });
    expect(page.items[0]?.pricingSnapshot).toBeNull();
  });

  it('keeps integer basis points and refuses money stored as a number', () => {
    const page = parsePaymentPage({
      items: [item({ pricingSnapshot: { fee: '1.25', feeBps: 250, flatFee: null } })],
      nextCursor: null,
    });
    expect(page.items[0]?.pricingSnapshot).toMatchObject({ fee: '1.25', feeBps: 250, flatFee: null });
    expect(() => parsePaymentPage([item()])).toThrow(/\{ items, nextCursor \}/);
    expect(() => parsePaymentPage({ items: [item()] })).toThrow(/\{ items, nextCursor \}/);
    expect(() => parsePaymentPage({ items: [item({ amount: 1.1 })], nextCursor: null })).toThrow(/decimal string/);
    expect(() => parsePaymentPage({ items: [item({ pricingSnapshot: { fee: 0.05 } })], nextCursor: null })).toThrow(/decimal string/);
    expect(() => parsePaymentPage({ items: [item({ pricingSnapshot: { fee: '1.25', flatFee: 1 } })], nextCursor: null })).toThrow(
      /flatFee/,
    );
  });

  it('refuses a non-page error response', () => {
    expect(() =>
      paymentPageFromResponse({
        status: 401,
        body: { error: { code: 'pay.unauthorized', message: 'no' } },
        rawBody: '',
      }),
    ).toThrow(/pay\.unauthorized/);
  });
});

describe('getPayments', () => {
  it('returns the page and sends the list filters', async () => {
    let url = '';
    const pay = createPayClient({
      baseUrl: 'https://pay.example/api/pay/v1',
      apiKey: 'ifc_test_x',
      maxRetries: 0,
      transport: async (input) => {
        url = input.url;
        return { status: 200, body: JSON.stringify({ items: [item()], nextCursor: null }) };
      },
    });
    const page = await pay.getPayments({
      query: {
        merchantId: MERCHANT,
        limit: '50',
        cursor: 'cursor-1',
        search: 'acme',
        assetId: 'USD',
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-16T00:00:00.000Z',
      },
    });
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]?.amount).toBe('1.10');
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/pay/v1/payments');
    expect(parsed.searchParams.get('merchantId')).toBe(MERCHANT);
    expect(parsed.searchParams.get('limit')).toBe('50');
    expect(parsed.searchParams.get('cursor')).toBe('cursor-1');
    expect(parsed.searchParams.get('search')).toBe('acme');
    expect(parsed.searchParams.get('assetId')).toBe('USD');
    expect(parsed.searchParams.get('from')).toBe('2026-10-01T00:00:00.000Z');
    expect(parsed.searchParams.get('to')).toBe('2026-10-16T00:00:00.000Z');
    const typed: PayPayment = page.items[0]!;
    expect(typed.mode).toBe('sandbox');
  });

  it('refuses a body that is still a bare array', async () => {
    const pay = createPayClient({
      baseUrl: 'https://pay.example/api/pay/v1',
      apiKey: 'ifc_test_x',
      maxRetries: 0,
      transport: async () => ({ status: 200, body: JSON.stringify([item()]) }),
    });
    await expect(pay.getPayments({ query: { merchantId: MERCHANT } })).rejects.toThrow(/\{ items, nextCursor \}/);
  });
});
