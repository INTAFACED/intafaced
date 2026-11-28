// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VenueOrder } from '../../../features/trade/venue-api';

// The spot desk reads an order it cancelled back from the venue by client id. Read just after the cancel, the venue's
// read side can still say open; the desk then lists it Open, with Cancel, though the venue has cancelled it. So an order
// cancelled here is read again until the venue says it is done, and not again after that.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = '0x14fde369f88559d681f88c467a2866abf52cbee7';
const CLOID = '0x42a05156a0f714ffcf769b6f727b780a';
const answers: Array<VenueOrder['status']> = [];
const orderByClientId = vi.fn(async () => {
  const status = answers.length > 1 ? answers.shift()! : answers[0]!;
  return { ok: true as const, data: { venueId: 'test-hl', asOf: '2026-11-28T00:28:02.600Z', value: order(status) } };
});

vi.mock('../../../features/trade/venue/VenueKit', () => ({ useVenueApi: () => ({ orderByClientId }) }));

import { useCancelledOrders } from './venue-order-reads';

function order(status: VenueOrder['status']): VenueOrder {
  return {
    venueOrderId: '1',
    venueClientOrderId: CLOID,
    symbol: 'PURR-USDC',
    side: 'buy',
    type: 'limit',
    timeInForce: 'GTC',
    price: '3.6455',
    amount: '3',
    filled: '0',
    remaining: status === 'open' ? '3' : '0',
    averagePrice: null,
    status,
    locked: status === 'open' ? '10.9365' : '0',
    lockedAsset: 'USDC',
    reduceOnly: false,
  };
}

function Rows() {
  const rows = useCancelledOrders(OWNER, [{ key: 'spot:buy:1', clientOrderId: CLOID }]);
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.venueClientOrderId}>{r.status}</li>
      ))}
    </ul>
  );
}

let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  answers.length = 0;
  orderByClientId.mockClear();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  vi.useRealTimers();
});

const settle = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('an order cancelled from the spot desk', () => {
  it('is read again while the venue still reads it open, and shows Cancelled once the venue does', async () => {
    answers.push('open', 'canceled');
    root = createRoot(host);
    act(() => root!.render(<Rows />));
    await settle();
    expect(host.textContent).toBe('open');
    await settle(5_000);
    expect(host.textContent).toBe('canceled');
  });

  it('is not read again once the venue says it is done', async () => {
    answers.push('canceled');
    root = createRoot(host);
    act(() => root!.render(<Rows />));
    await settle(10_000);
    expect(host.textContent).toBe('canceled');
    expect(orderByClientId).toHaveBeenCalledTimes(1);
  });
});
