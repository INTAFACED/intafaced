// @vitest-environment happy-dom
import { act, createContext, useContext, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { venueMarketSchema } from '../../../features/trade/venue-api';

// The spot desk on a venue whose trades only a session key signs (Hyperliquid) offers the trading session from its own
// panel. The wallet the person connects lives in the desk's own frame (VenueFrame's WalletProvider), not in the
// app's outer one, so the desk's session must read its owner inside that frame: read outside it, the owner is never
// connected, the session panel never shows and no order can be signed. Here the app's outer wallet is not connected and
// only the frame's is, as in the app; the session, its panel and its words are the real ones.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = '0x1111111111111111111111111111111111111111';

// The app's outer wallet is not connected; the frame's wallet is the connected one.
const wallets = vi.hoisted(() => ({ outer: { status: 'disconnected', address: null } as unknown, frame: null as unknown }));
const FrameWallet = createContext<unknown>(null);
vi.mock('../../../features/protocol/wallet/WalletProvider', async (original) => {
  const real = await original<typeof import('../../../features/protocol/wallet/WalletProvider')>();
  return { ...real, useWallet: () => useContext(FrameWallet) ?? wallets.outer };
});
vi.mock('../../../features/trade/venue/VenueKit', async (original) => {
  const real = await original<typeof import('../../../features/trade/venue/VenueKit')>();
  return {
    ...real,
    VenueFrame: ({ children }: { children: ReactNode }) => <FrameWallet.Provider value={wallets.frame}>{children}</FrameWallet.Provider>,
    useVenueApi: () => ({ markets: async () => ({ ok: true, data: { value: [market], asOf: '2026-11-27T10:00:00.000Z' } }) }),
  };
});
// The desk itself is drawn elsewhere (its own tests); here it is only the session line it places beside the wallet.
vi.mock('./VenueSpotDesk', async () => {
  const { DeskSessionLine } = await import('../../../features/trade/venue/VenueSession');
  return { VenueSpotDesk: () => <DeskSessionLine /> };
});
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
const rest = vi.fn(async (path: string) =>
  path === '/venue/session'
    ? { ok: true, data: { venueId: 'test-hl', owner: OWNER, current: null, asOf: '2026-11-27T10:00:00.000Z' } }
    : { ok: false, reason: 'unavailable', message: 'TEST: not answered here' },
);
vi.mock('../../../features/session/session', () => ({ useSession: () => ({ userId: 'u-11143', api: { rest } }) }));

import { VenueSpotGate } from './VenueSpotGate';

// TEST market and venue status: a spot pair on a venue whose orders a session key signs.
const market = venueMarketSchema.parse({
  symbol: 'PURR-USDC',
  kind: 'spot',
  baseAsset: 'PURR',
  quoteAsset: 'USDC',
  orderTypes: ['limit', 'market'],
  timeInForce: ['GTC', 'IOC'],
  marginModes: [],
  maxLeverageBps: null,
  tickSize: '0.1',
  lotSize: '0.001',
  minOrderNotional: '10',
  priceBandBps: '1000',
  maxOpenOrders: 3,
  maxOrderQty: '100',
  maxOrderNotional: '10000',
  makerFeeBps: { known: true, value: '1' },
  takerFeeBps: { known: true, value: '3.5' },
  listedBy: { known: false },
  oracleRule: { known: false },
  markRule: { known: false },
  tradingHours: { known: false },
  feed: { known: false },
  session: { known: false },
  contractSize: { known: false },
  mark: { known: false },
  funding: { known: false },
  triggerSources: ['last'],
});
const STATUS = {
  enabled: true,
  available: true,
  venue: { id: 'test-hl', displayName: 'TEST venue', proofLevel: 'testnet' },
  test: true,
  chainId: 421614,
  deposit: null,
  builder: null,
  cancelsPerAction: 10,
  tradesSignedBy: 'session_key',
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  sessionStorage.clear();
  wallets.frame = { status: 'connected', address: OWNER, guard: null, sign: vi.fn() };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("offers Start for the wallet connected in the desk's own frame, read for that wallet", async () => {
  await act(async () =>
    root.render(
      <VenueSpotGate mode={{ mode: 'on', status: STATUS as never, reload: () => undefined } as never} pair="PURR-USDC" fallback={null} />,
    ),
  );
  await vi.waitFor(() => expect(host.querySelector('[data-testid="venue-session-start"]')).not.toBeNull());
  expect(host.querySelector('[data-testid="venue-session-line"]')?.getAttribute('data-session')).toBe('none');
  expect(rest).toHaveBeenCalledWith('/venue/session', expect.anything(), expect.objectContaining({ query: { owner: OWNER } }));
});
