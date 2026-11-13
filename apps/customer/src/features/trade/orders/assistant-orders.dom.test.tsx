// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Orders by your assistant on /trade/orders (J-agents-21 #7): every state of the list, with the person's door answered
// here. The list only reads: nothing here signs, sends or cancels.

const OWNER = '0x1111111111111111111111111111111111111111';
const KEY = '7f6c1f2e-0d3b-4f4a-9a51-1b2c3d4e5f60';
const order = (over: object = {}) => ({
  venueOrderId: '901',
  venueClientOrderId: '0xabc',
  symbol: 'BTC-USDC',
  side: 'buy' as 'buy' | 'sell',
  type: 'market',
  timeInForce: 'IOC' as 'GTC' | 'IOC' | 'ALO',
  price: '60100',
  amount: '0.0005',
  filled: '0.0005',
  remaining: '0',
  averagePrice: '60010',
  status: 'filled',
  locked: '0',
  lockedAsset: 'USDC',
  reduceOnly: false,
  ...over,
});
const kept = (over: object = {}) => ({
  actionKey: `agent:order:${KEY}:spot-buy`,
  venueClientOrderId: '0xabc',
  origin: `agent:${KEY}`,
  state: 'accepted' as 'accepted' | 'unknown' | 'refused' | 'not_sent',
  order: order() as ReturnType<typeof order> | null,
  asOf: '2026-11-13T10:00:00.000Z',
  ...over,
});

const venue = { agentAccounts: vi.fn(), keptOrders: vi.fn() };
vi.mock('../venue-api', async (actual) => ({ ...(await actual<typeof import('../venue-api')>()), venueApi: () => venue }));
vi.mock('../../session/session', () => ({ useSession: () => ({ userId: 'u-test', api: {} }) }));
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { AssistantOrders, ASSISTANT_ORDER_PAGES, assistantOrders } = await import('./AssistantOrders');
const { ordersCopy } = await import('./orders-copy');

function Harness() {
  const { t } = ordersCopy.useCopy();
  return <AssistantOrders t={t} revision={0} />;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  venue.agentAccounts.mockReset();
  venue.keptOrders.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
async function show() {
  await act(async () => root.render(<Harness />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return host.querySelector('[data-testid="assistant-orders"]')!;
}
const accounts = (...owners: string[]) => ({
  ok: true,
  data: { accounts: owners.map((owner, i) => ({ accountId: `a${i}`, status: 'open', owner, subAccount: `0x${i}` })) },
});

describe('Orders by your assistant', () => {
  it('shows only the assistant’s orders, newest first, each tagged by your assistant with the venue’s figures', async () => {
    venue.agentAccounts.mockResolvedValue(accounts(OWNER));
    venue.keptOrders.mockResolvedValue({
      ok: true,
      data: {
        orders: [
          kept(),
          kept({ actionKey: 'order:mine', origin: null, venueClientOrderId: '0xdef', order: order({ venueClientOrderId: '0xdef' }) }),
          kept({
            actionKey: `agent:order:${KEY}:rest`,
            venueClientOrderId: '0x123',
            order: order({ status: 'open', filled: '0', averagePrice: null }),
          }),
        ],
        nextCursor: null,
      },
    });
    const view = await show();
    expect(view.querySelector('h3')!.textContent).toBe('Orders by your assistant');
    const rows = [...view.querySelectorAll('tbody tr')];
    expect(rows.map((r) => r.getAttribute('data-venue-client-order-id'))).toEqual(['0x123', '0xabc']);
    expect(rows.map((r) => r.querySelector('[data-placed-by="assistant"]')!.textContent)).toEqual([
      'by your assistant',
      'by your assistant',
    ]);
    const cells = [...rows[1]!.querySelectorAll('td')].map((c) => c.textContent);
    expect(cells.slice(0, 2)).toEqual(['BTC-USDC', 'Buy']);
    expect(cells[5]).toBe('Filled');
    expect(rows[0]!.querySelectorAll('td')[4]!.textContent).toBe('not known');
    expect(rows[0]!.querySelectorAll('td')[5]!.textContent).toBe('Open');
    expect(venue.keptOrders).toHaveBeenCalledWith(OWNER, undefined, expect.anything());
  });

  it('reads every page of each wallet once, and says when it stops at its page limit', async () => {
    venue.agentAccounts.mockResolvedValue(accounts(OWNER, OWNER.toUpperCase().replace('0X', '0x')));
    venue.keptOrders.mockImplementation(async (_owner: string, cursor?: string) => ({
      ok: true,
      data: {
        orders: [kept({ actionKey: `agent:order:${KEY}:${cursor ?? 'first'}` })],
        nextCursor: `c${Number((cursor ?? 'c0').slice(1)) + 1}`,
      },
    }));
    const view = await show();
    expect(venue.keptOrders).toHaveBeenCalledTimes(ASSISTANT_ORDER_PAGES);
    expect(view.querySelectorAll('tbody tr')).toHaveLength(ASSISTANT_ORDER_PAGES);
    expect(view.textContent).toContain(`Only the first ${ASSISTANT_ORDER_PAGES} orders are read here.`);
  });

  it('says the assistant has placed nothing, and names a refused, unknown or unsent order in words', async () => {
    venue.agentAccounts.mockResolvedValue({ ok: true, data: { accounts: [] } });
    expect((await show()).textContent).toContain('Your assistant hasn’t placed an order.');
    expect(venue.keptOrders).not.toHaveBeenCalled();
    act(() => root.unmount());
    root = createRoot(host);
    venue.agentAccounts.mockResolvedValue(accounts(OWNER));
    venue.keptOrders.mockResolvedValue({
      ok: true,
      data: {
        orders: [
          kept({ actionKey: 'a1', state: 'refused', order: null }),
          kept({ actionKey: 'a2', state: 'unknown', order: null }),
          kept({ actionKey: 'a3', state: 'not_sent', order: null }),
        ],
        nextCursor: null,
      },
    });
    const rows = [...(await show()).querySelectorAll('tbody tr')];
    expect(rows.map((r) => r.querySelectorAll('td')[5]!.textContent)).toEqual([
      'Not sent',
      'Not known: the venue hasn’t answered',
      'Refused by the venue',
    ]);
    expect(rows.map((r) => r.querySelectorAll('td')[0]!.textContent)).toEqual(['not known', 'not known', 'not known']);
    expect(assistantOrders([kept({ origin: null })])).toEqual([]);
  });

  it('says the venue account is off here when the door is off, and shows a failure in words', async () => {
    venue.agentAccounts.mockResolvedValue({ ok: false, reason: 'error', message: 'off', code: 'trade.user_venue_off', status: 404 });
    expect((await show()).textContent).toContain('Trading on your own venue account isn’t on here');
    act(() => root.unmount());
    root = createRoot(host);
    venue.agentAccounts.mockResolvedValue(accounts(OWNER));
    venue.keptOrders.mockResolvedValue({ ok: false, reason: 'error', message: 'down', code: 'trade.venue_down', status: 503 });
    const failed = await show();
    expect(failed.querySelector('[data-testid="failure"]')).not.toBeNull();
    expect(failed.querySelector('tbody')).toBeNull();
  });
});
