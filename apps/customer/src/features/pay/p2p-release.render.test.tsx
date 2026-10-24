// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { P2POrder } from './P2POrder';
import type { PersonalPayApi } from './pay-api';
import type { Trade } from './schemas';

/** J-p2p-01 #8: a released order says Completed, as the order list does, and what the buyer received after the fee. */

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
const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const released = (extra: Partial<Trade>): Trade => ({
  id: TRADE,
  offerId: '33333333-3333-4333-8333-333333333333',
  sellerId: SELLER,
  buyerId: BUYER,
  asset: 'USDT',
  amount: '50',
  fiatCurrency: 'EUR',
  fiatAmount: '46',
  price: '0.92',
  method: 'test-bank-transfer',
  status: 'released',
  resolution: 'released',
  deadlineAt: null,
  createdAt: '2026-10-24T05:00:00.000Z',
  escrowedAt: '2026-10-24T05:00:01.000Z',
  resolvedAt: '2026-10-24T05:10:00.000Z',
  settledAt: '2026-10-24T05:10:01.000Z',
  ...extra,
});

function payWith(order: Trade): PersonalPayApi {
  return {
    viewer: BUYER,
    trade: async () => ({ ok: true, data: order }),
    // The other side by handle (J-p2p-02 #2): this order's counterparty has no public profile here.
    reputation: async () => ({ ok: true, data: { handle: null, profile: { status: 'absent' } } }),
    contacts: () => new Promise(() => undefined),
    guard: { status: () => null, restore: async () => undefined, knownProof: () => null },
  } as unknown as PersonalPayApi;
}

async function open(order: Trade, userId: string) {
  root = createRoot(host);
  const mounted = root;
  await act(async () =>
    mounted.render(
      <P2POrder pay={payWith(order)} tradeId={TRADE} userId={userId} renderActions={() => null} renderSecondary={() => null} />,
    ),
  );
  await act(async () => undefined);
  return host;
}

describe('P2P released order (J-p2p-01 #8)', () => {
  it('says Completed and gives the buyer the amount after the fee frozen at take', async () => {
    const page = await open(released({ displayStatus: 'completed', feeBps: 100, fee: '0.5', netAmount: '49.5' }), BUYER);
    expect(page.querySelector('.p2p-order-identity')!.textContent).toContain('Completed');
    const result = page.querySelector('[data-testid="order-result"]')!;
    expect(result.textContent).toContain('49.5 USDT, after the service fee');
    expect(result.textContent).toContain('0.5 USDT (1% of the released amount)');
    expect(result.textContent).not.toContain('before any service fee');
  });

  it('keeps the record’s own words when the read has no split', async () => {
    const page = await open(released({ feeBps: 100, fee: null, netAmount: null }), BUYER);
    const result = page.querySelector('[data-testid="order-result"]')!;
    expect(result.textContent).toContain('released from escrow, before any service fee');
    expect(result.textContent).toContain('Not on the order record this page reads.');
  });

  it('shows the seller what left their escrow, not the buyer’s share', async () => {
    const page = await open(released({ displayStatus: 'completed', feeBps: 100, fee: '0.5', netAmount: '49.5' }), SELLER);
    const result = page.querySelector('[data-testid="order-result"]')!;
    expect(result.textContent).toContain('50 USDT released from your escrow');
    expect(result.textContent).not.toContain('49.5');
    // J-p2p-02 #6: and the fee the release took, at the rate frozen at take.
    expect(result.textContent).toContain('0.5 USDT (1% of the released amount)');
  });
});
