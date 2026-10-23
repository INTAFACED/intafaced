// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { destinationRows, OrderPaymentDetails } from './P2P';
import type { PersonalPayApi } from './pay-api';
import type { Trade, TradeDestination } from './schemas';

/** J-p2p-01 #6 (P-trade-orders-08): the payee card names each value, the payee-name rule, and a change since the order. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

const TRADE = '0b6f1c1e-4a7d-4c55-9d1e-2f6f0e8a1b2c';
const BUYER = '22222222-2222-4222-8222-222222222222';
const trade: Trade = {
  id: TRADE,
  offerId: '33333333-3333-4333-8333-333333333333',
  sellerId: '11111111-1111-4111-8111-111111111111',
  buyerId: BUYER,
  asset: 'USDT',
  amount: '10',
  fiatCurrency: 'EUR',
  fiatAmount: '9.2',
  price: '0.92',
  method: 'test-bank-transfer',
  status: 'escrowed',
  resolution: null,
  deadlineAt: null,
  createdAt: '2026-10-23T20:00:00.000Z',
  escrowedAt: '2026-10-23T20:00:01.000Z',
  resolvedAt: null,
  settledAt: null,
};
const destination = (payeeChange: TradeDestination['payeeChange']): TradeDestination => ({
  tradeId: TRADE,
  methodId: 'test-bank-transfer',
  country: 'DE',
  fiatCurrency: 'EUR',
  label: 'TEST account',
  details: { iban: 'DE00 TEST 0000', account_holder: 'TEST Seller' },
  fields: [
    { key: 'account_holder', label: 'Account holder' },
    { key: 'iban', label: 'IBAN' },
  ],
  attachedAt: '2026-10-23T20:00:01.000Z',
  payeeChange,
});

async function revealed(data: TradeDestination) {
  const pay = { destination: async () => ({ ok: true, data }) } as unknown as PersonalPayApi;
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<OrderPaymentDetails trade={trade} pay={pay} userId={BUYER} />));
  await act(async () => host.querySelector('button')!.click());
  await act(async () => undefined);
  return host;
}

describe('P2P payee card (J-p2p-01 #6)', () => {
  it('lists each value under its schema label, in the schema order, then any key the schema no longer names', () => {
    expect(destinationRows(destination(null))).toEqual([
      ['Account holder', 'TEST Seller'],
      ['IBAN', 'DE00 TEST 0000'],
    ]);
    expect(destinationRows({ details: { iban: 'X', bic: 'Y' }, fields: [{ key: 'iban', label: 'IBAN' }] })).toEqual([
      ['IBAN', 'X'],
      ['bic', 'Y'],
    ]);
    expect(destinationRows({ details: { iban: 'X' } })).toEqual([['iban', 'X']]);
  });

  it('shows the account holder and number with the payee-name rule, and no change notice while they match', async () => {
    const card = await revealed(destination(null));
    expect(card.textContent).toContain('Account holder');
    expect(card.textContent).toContain('TEST Seller');
    expect(card.textContent).toContain('DE00 TEST 0000');
    expect(card.querySelector('[data-testid="order-payee-name-rule"]')!.textContent).toContain(
      'Enter the account holder exactly as shown here',
    );
    expect(card.querySelector('[data-testid="order-payee-changed"]')).toBeNull();
  });

  it('says when the seller changed or removed the details after the order, and still shows the agreed ones', async () => {
    const changed = await revealed(destination({ kind: 'changed', at: '2026-10-23T20:05:00.000Z' }));
    expect(changed.querySelector('[data-testid="order-payee-changed"]')!.textContent).toContain(
      'The seller changed these payment details after this order was placed',
    );
    expect(changed.textContent).toContain('Pay to the details shown here');
    expect(changed.textContent).toContain('DE00 TEST 0000');
    act(() => root?.unmount());
    root = null;
    const removed = await revealed(destination({ kind: 'removed', at: null }));
    expect(removed.querySelector('[data-testid="order-payee-changed"]')!.textContent).toContain(
      'The seller removed these payment details after this order was placed',
    );
  });
});
