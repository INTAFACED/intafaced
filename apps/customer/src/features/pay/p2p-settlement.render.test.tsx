// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OfferSettlement, OrderSettlement, TakeSettlementNotice, windowParts } from './personal/Settlement';
import type { Offer, Trade } from './schemas';

/** J-p2p-01 #7 (P-disputes-security-09): a method that is not instant says its settlement window on the ad, the take and the order. */

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

function render(node: React.ReactNode) {
  root = createRoot(host);
  const mounted = root;
  act(() => mounted.render(node));
  return host;
}

const offer = (patch: Partial<Offer>): Offer => ({
  id: '33333333-3333-4333-8333-333333333333',
  makerId: '11111111-1111-4111-8111-111111111111',
  side: 'sell',
  asset: 'USDT',
  fiatCurrency: 'EUR',
  priceType: 'fixed',
  price: '0.92',
  minAmount: '10',
  maxAmount: '50',
  remainingAmount: '100',
  methods: ['sepa', 'slow'],
  terms: '',
  status: 'active',
  createdAt: '2026-10-24T05:00:00.000Z',
  ...patch,
});
const trade = (settlement: Trade['settlement']): Trade => ({
  id: '0b6f1c1e-4a7d-4c55-9d1e-2f6f0e8a1b2c',
  offerId: '33333333-3333-4333-8333-333333333333',
  sellerId: '11111111-1111-4111-8111-111111111111',
  buyerId: '22222222-2222-4222-8222-222222222222',
  asset: 'USDT',
  amount: '10',
  fiatCurrency: 'EUR',
  fiatAmount: '9.2',
  price: '0.92',
  method: 'slow',
  status: 'escrowed',
  resolution: null,
  deadlineAt: null,
  createdAt: '2026-10-24T05:00:00.000Z',
  escrowedAt: '2026-10-24T05:00:01.000Z',
  resolvedAt: null,
  settledAt: null,
  ...(settlement ? { settlement } : {}),
});

describe('non-instant payment methods on screen (J-p2p-01 #7)', () => {
  it('writes a window in its largest whole unit', () => {
    expect(windowParts(172_800)).toEqual({ unit: 'days', count: 2 });
    expect(windowParts(86_400)).toEqual({ unit: 'day', count: 1 });
    expect(windowParts(7_200)).toEqual({ unit: 'hours', count: 2 });
    expect(windowParts(3_600)).toEqual({ unit: 'hour', count: 1 });
    expect(windowParts(90)).toEqual({ unit: 'minutes', count: 2 });
  });

  it('names each slow method on the ad with its window and the seller’s consent, and nothing for an all-instant ad', () => {
    const page = render(
      <OfferSettlement
        offer={offer({ nonInstantMethods: [{ methodId: 'slow', windowSeconds: 172_800 }], acceptsNonInstant: true })}
        label={(id) => id}
      />,
    );
    expect(page.textContent).toContain('slow: not instant, the money can take up to 2 days to arrive');
    expect(page.textContent).toContain('The seller accepts payment methods that are not instant.');
    act(() => root?.unmount());
    root = null;
    expect(render(<OfferSettlement offer={offer({ nonInstantMethods: [] })} label={(id) => id} />).textContent).toBe('');
  });

  it('says a blank window is the payment deadline', () => {
    const page = render(
      <OfferSettlement offer={offer({ nonInstantMethods: [{ methodId: 'slow', windowSeconds: null }] })} label={(id) => id} />,
    );
    expect(page.textContent).toContain('slow: not instant, the money can take until the payment deadline to arrive');
  });

  it('tells the buyer the window only for the slow method they chose', () => {
    const slow = offer({ nonInstantMethods: [{ methodId: 'slow', windowSeconds: 7_200 }] });
    expect(render(<TakeSettlementNotice offer={slow} method="slow" />).textContent).toBe(
      'This method is not instant: the money can take up to 2 hours to arrive. Your order shows its own payment deadline, and on a method that is not instant a dispute opens only after that deadline.',
    );
    act(() => root?.unmount());
    root = null;
    expect(render(<TakeSettlementNotice offer={slow} method="sepa" />).textContent).toBe('');
  });

  it('puts the order’s own window on the order, and nothing for an instant one', () => {
    expect(render(<OrderSettlement trade={trade({ instant: false, windowSeconds: 172_800 })} />).textContent).toBe(
      'Not instant: the payment window is 2 days, and a dispute opens only after it ends',
    );
    act(() => root?.unmount());
    root = null;
    expect(render(<OrderSettlement trade={trade({ instant: true })} />).textContent).toBe('');
    act(() => root?.unmount());
    root = null;
    expect(render(<OrderSettlement trade={trade(undefined)} />).textContent).toBe('');
  });
});
