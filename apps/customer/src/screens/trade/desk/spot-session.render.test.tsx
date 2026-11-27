// @vitest-environment happy-dom
import { act, useContext } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// On a venue whose trades only a session key signs (Hyperliquid), the spot desk offers the trading session for the wallet
// its own frame connects. The wallet lives inside the desk's frame (`VenueFrame`, a wallet provider of its own), so the
// session is read there: read above the frame, the owner is none, and the desk shows no session panel and signs no order.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = '0x1111111111111111111111111111111111111111';
const USER = 'u-spot-session';

vi.mock('../../../features/trade/venue/VenueKit', async (original) => {
  const real = await original<typeof import('../../../features/trade/venue/VenueKit')>();
  const { createContext } = await import('react');
  // Whether a component is inside the desk's frame: the one place its wallet is connected.
  const frame = createContext(false);
  return {
    ...real,
    VenueFrame: ({ children }: { children: React.ReactNode }) => <frame.Provider value={true}>{children}</frame.Provider>,
    useOwner: () => (useContext(frame) ? OWNER : null),
    useVenueApi: () => ({
      markets: async () => ({ ok: true, data: { venueId: 'test-hl', asOf: '2026-11-27T10:00:00.000Z', value: [MARKET] } }),
    }),
  };
});
vi.mock('../../../features/trade/venue/venue-words', async (original) => {
  const real = await original<typeof import('../../../features/trade/venue/venue-words')>();
  return { ...real, useVenueApi: () => ({ submit: vi.fn() }) };
});
vi.mock('../../../features/protocol', async (original) => {
  const real = await original<typeof import('../../../features/protocol')>();
  return { ...real, useWallet: () => ({ status: 'connected', address: OWNER, guard: null, sign: vi.fn() }) };
});
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../../../data/hooks', () => ({ useDataEnv: () => ({ poller: { recordExternalRequest: () => undefined } }) }));
function rest(path: string): Promise<unknown> {
  if (path === '/venue/session')
    return Promise.resolve({ ok: true, data: { venueId: 'test-hl', owner: OWNER, current: null, asOf: '2026-11-27T10:00:00.000Z' } });
  return Promise.resolve({ ok: false, reason: 'refused', code: 'test.not_answered', message: 'TEST: not answered here' });
}
vi.mock('../../../features/session/session', () => ({ useSession: () => ({ userId: USER, api: { rest } }) }));
// The desk itself is not under test: it shows the session panel where the account panel places it.
vi.mock('./VenueSpotDesk', async () => {
  const { DeskSessionLine } = await import('../../../features/trade/venue/VenueSession');
  return { VenueSpotDesk: () => <DeskSessionLine /> };
});

import { venueStatusSchema } from '../../../features/trade/venue-api';
import { VenueSpotGate } from './VenueSpotGate';

const MARKET = { symbol: 'PURR-USDC', kind: 'spot', baseAsset: 'PURR', quoteAsset: 'USDC' };
const STATUS = {
  enabled: true,
  available: true,
  venue: { id: 'test-hl', displayName: 'TEST venue', proofLevel: 'partner-sandbox' },
  test: true,
  chainId: 421614,
  deposit: null,
  builder: null,
  cancelsPerAction: 1,
  tradesSignedBy: 'session_key',
};

let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  sessionStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('the spot desk on a venue whose orders a session key signs', () => {
  it('offers the trading session for the wallet its own frame connects', async () => {
    root = createRoot(host);
    const mounted = root;
    const status = venueStatusSchema.parse(STATUS);
    if (!status.enabled) throw new Error('the TEST status is an enabled venue');
    const mode = { mode: 'on' as const, status, reload: () => undefined };
    await act(async () => mounted.render(<VenueSpotGate mode={mode} pair="PURR-USDC" fallback={<p>today</p>} />));
    await vi.waitFor(() => expect(document.querySelector('[data-testid="venue-session"]')).not.toBeNull());
    await vi.waitFor(() => expect(document.querySelector('[data-testid="venue-session-start"]')).not.toBeNull());
  });
});
