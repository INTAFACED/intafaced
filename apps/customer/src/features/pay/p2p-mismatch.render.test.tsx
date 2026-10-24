// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportMismatch } from './p2p-mismatch';
import type { PersonalPayApi } from './pay-api';
import type { Trade, TradeMismatch } from './schemas';

/** J-p2p-02 #3 (P-trade-orders-20): the seller reports what arrived; the order says what the classification means. */

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

const trade = (mismatch: TradeMismatch | null = null): Trade => ({
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
  mismatch,
});

async function render(node: React.ReactNode) {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(node));
  return host;
}
const button = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Report the amount')!;
async function type(value: string) {
  const input = host.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const report = (classification: TradeMismatch['classification']): TradeMismatch => ({
  kind: 'under',
  amountReceived: '5',
  expected: '9.2',
  classification,
  toleranceBps: classification === 'reported' ? null : 50,
  reportedAt: '2026-10-24T12:10:00.000Z',
});

describe('Report an amount mismatch (J-p2p-02 #3)', () => {
  it('stays off until an amount is entered, then sends the kind and amount once', async () => {
    const reportMismatch = vi.fn(async () => ({ ok: true as const, data: report('within_tolerance') }));
    const onReported = vi.fn();
    await render(<ReportMismatch trade={trade()} pay={{ reportMismatch } as unknown as PersonalPayApi} onReported={onReported} />);
    expect(host.textContent).toContain('The order is for 9.2 EUR.');
    expect(button().disabled).toBe(true);
    await type('9.19');
    expect(button().disabled).toBe(false);
    await act(async () => button().click());
    expect(reportMismatch).toHaveBeenCalledWith(trade().id, 'under', '9.19');
    expect(onReported).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('within this service’s tolerance, so the order goes on');
  });

  it('says a refused report in its own words', async () => {
    const reportMismatch = vi.fn(async () => ({
      ok: false as const,
      reason: 'error',
      message: 'service text',
      code: 'p2p.invalid_amount',
      status: 400,
    }));
    await render(<ReportMismatch trade={trade()} pay={{ reportMismatch } as unknown as PersonalPayApi} onReported={() => {}} />);
    await type('9.3');
    await act(async () => button().click());
    expect(host.textContent).toContain('That amount does not match what you chose');
    expect(host.textContent).not.toContain('service text');
  });

  it('outside the band says the seller need not release and points to a dispute; a blank band says a person decides', async () => {
    await render(<ReportMismatch trade={trade(report('outside_tolerance'))} pay={{} as PersonalPayApi} onReported={() => {}} />);
    const result = host.querySelector('[data-testid="order-mismatch-result"]')!;
    expect(result.textContent).toContain('You reported 5 EUR received of 9.2 EUR.');
    expect(result.textContent).toContain('You do not have to release.');
    expect(result.textContent).toContain('open a dispute below');
    expect(host.querySelector('[data-testid="order-mismatch"]')).toBeNull();
    act(() => root?.unmount());
    await render(<ReportMismatch trade={trade(report('reported'))} pay={{} as PersonalPayApi} onReported={() => {}} />);
    expect(host.textContent).toContain('This service sets no tolerance, so a person decides.');
  });
});
