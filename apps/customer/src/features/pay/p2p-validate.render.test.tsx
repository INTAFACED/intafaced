// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidatePayment } from './p2p-validate';
import type { PersonalPayApi } from './pay-api';
import type { Trade } from './schemas';

/** J-p2p-02 #4 (P-trade-orders-11): the seller has the bank rail check the payment, or sees what stops it. */

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

type Blocker = 'rail.bank' | 'p2p.method_not_rail_validated' | null;
const trade = (blocker: Blocker = null): Trade => ({
  id: '0b6f1c1e-4a7d-4c55-9d1e-2f6f0e8a1b2c',
  offerId: '33333333-3333-4333-8333-333333333333',
  sellerId: '11111111-1111-4111-8111-111111111111',
  buyerId: '22222222-2222-4222-8222-222222222222',
  asset: 'USDT',
  amount: '10',
  fiatCurrency: 'EUR',
  fiatAmount: '9.2',
  price: '0.92',
  method: 'test-bank-transfer',
  status: 'fiat_sent',
  resolution: null,
  deadlineAt: null,
  createdAt: '2026-10-24T12:00:00.000Z',
  escrowedAt: '2026-10-24T12:00:01.000Z',
  resolvedAt: null,
  settledAt: null,
  paymentValidation: { blocker },
});

async function render(node: React.ReactNode) {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(node));
  return host;
}
const button = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Check the payment with the bank')!;

describe('Check the payment with the bank (J-p2p-02 #4)', () => {
  it('stays off and names the switched-off rail, the uncovered method, or an unread order', async () => {
    await render(<ValidatePayment trade={trade('rail.bank')} pay={{} as PersonalPayApi} onChecked={() => {}} />);
    expect(button().disabled).toBe(true);
    expect(host.textContent).toContain('Payment validation needs a bank rail. It is switched off in this build');
    act(() => root?.unmount());
    await render(<ValidatePayment trade={trade('p2p.method_not_rail_validated')} pay={{} as PersonalPayApi} onChecked={() => {}} />);
    expect(host.textContent).toContain('does not check test-bank-transfer payments');
    act(() => root?.unmount());
    await render(<ValidatePayment trade={{ ...trade(), paymentValidation: undefined }} pay={{} as PersonalPayApi} onChecked={() => {}} />);
    expect(button().disabled).toBe(true);
    expect(host.textContent).toContain('could not read whether the bank rail can check this order');
  });

  it('checks once; a release reloads the order, nothing arrived says so', async () => {
    const validatePayment = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { outcome: 'pending', trade: trade() } })
      .mockResolvedValueOnce({ ok: true, data: { outcome: 'released', trade: trade() } });
    const onChecked = vi.fn();
    await render(<ValidatePayment trade={trade()} pay={{ validatePayment } as unknown as PersonalPayApi} onChecked={onChecked} />);
    expect(button().disabled).toBe(false);
    await act(async () => button().click());
    expect(host.textContent).toContain('The bank shows no payment for this order.');
    expect(onChecked).not.toHaveBeenCalled();
    await act(async () => button().click());
    expect(host.textContent).toContain('The bank confirmed the payment');
    expect(onChecked).toHaveBeenCalledTimes(1);
  });

  it('says a mismatch in its own words: nothing released, a dispute below', async () => {
    const validatePayment = vi.fn(async () => ({
      ok: false as const,
      reason: 'error',
      message: 'service text',
      code: 'p2p.rail_mismatch',
      status: 409,
    }));
    await render(<ValidatePayment trade={trade()} pay={{ validatePayment } as unknown as PersonalPayApi} onChecked={() => {}} />);
    await act(async () => button().click());
    expect(host.textContent).toContain('so nothing was released');
    expect(host.textContent).not.toContain('service text');
  });
});
