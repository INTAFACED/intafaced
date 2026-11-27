// @vitest-environment happy-dom
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { VenueMode } from '../use-venue-mode';
import { tabSpecs } from '../../../app/menus';
import { findRoom } from '../../../app/navigation';

// The menus' Orders (Trade) and Order history (More) are one page, and with venue trading on it lists the trader's
// venue orders, or says "No orders yet" in one plain line, never a wallet prompt standing in for the list.
const state: { mode: VenueMode } = {
  mode: {
    mode: 'on',
    status: { enabled: true, available: false, refusal: { code: 'venue_down', detail: 'TEST venue is down' } },
    reload: () => undefined,
  },
};

vi.mock('../use-venue-mode', () => ({ useVenueMode: () => state.mode }));

vi.mock('../venue/VenueKit', async (original) => {
  const real = await original<typeof import('../venue/VenueKit')>();
  return {
    ...real,
    VenueFrame: ({ children }: { children: React.ReactNode }) => <div data-mock="venue-frame">{children}</div>,
    WalletBar: () => <div data-mock="wallet-bar">Connect INTAFACED wallet</div>,
    useOwner: () => null,
  };
});

vi.mock('../../../data/hooks', async (original) => ({
  ...(await original<typeof import('../../../data/hooks')>()),
  useDataEnv: () => ({ poller: { recordExternalRequest: () => undefined } }),
}));

vi.mock('../../../screens/trade/desk/data', async (original) => ({
  ...(await original<typeof import('../../../screens/trade/desk/data')>()),
  useDeskMarkets: () => ({ status: 'ready' as const, data: [] }),
}));

vi.mock('../../session', () => ({ useSession: () => ({ userId: 'u-1', api: { call: vi.fn() } }) }));

const { TradeRoutes } = await import('../TradeRoutes');

describe('Trade > Orders', () => {
  it('opens the same page as More > Order history', () => {
    for (const mode of ['simple', 'pro'] as const) {
      const orders = tabSpecs(mode, true)
        .find((tab) => tab.door === 'Trade')
        ?.items.find((item) => item.id === 'orders');
      expect(orders?.href).toBe('/trade/orders');
    }
    expect(findRoom('/trade/orders')?.title).toBe('Order history');
  });

  it('with venue trading on and no wallet yet, says "No orders yet" under the wallet bar', () => {
    const html = renderToString(<TradeRoutes path="/trade/orders" />);
    expect(html).toContain('data-mock="wallet-bar"');
    expect(html).toContain('No orders yet');
    expect(html).not.toContain('You have no past orders');
  });
});
