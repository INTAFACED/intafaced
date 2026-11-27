// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

// On a venue whose trades only a session key signs (status `tradesSignedBy: 'session_key'`; Hyperliquid's orders
// are L1 actions under chain 1337, which a browser wallet refuses), the rooms outside the desks that cancel or close an
// order (the orders room, Activity's Orders tab, the Risk room) take the trading session the way the desks do: a cancel or
// a close is prepared for this tab's live session key and signed by it with no wallet prompt; with no live session there,
// the room refuses naming the session, prepares nothing and offers Start. The session, its key, the venue door's
// client and the signing are the real ones; only the app's REST client answers, per path, as svc-trade would.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const USER = 'u-11058';
const OWNER = '0x1111111111111111111111111111111111111111';
const KEY = `0x${'5b'.repeat(32)}` as const;
const sessionKey = privateKeyToAccount(KEY);
const AGENT = sessionKey.address.toLowerCase();

const world = vi.hoisted(() => ({
  status: null as unknown,
  current: null as unknown,
  calls: [] as Array<{ path: string; body: unknown }>,
}));
const walletSign = vi.fn();

vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../../../data/hooks', () => ({ useDataEnv: () => ({ poller: { recordExternalRequest: () => undefined } }) }));
vi.mock('../use-venue-mode', () => ({ useVenueMode: () => ({ mode: 'on', status: world.status, reload: () => undefined }) }));
vi.mock('../../protocol', async (original) => {
  const real = await original<typeof import('../../protocol')>();
  return { ...real, useWallet: () => ({ status: 'connected', address: OWNER, guard: null, sign: walletSign }) };
});
// The venue frame and wallet bar read the wallet's network and the venue's door; this test reads only what the room signs.
vi.mock('./VenueKit', async (original) => {
  const real = await original<typeof import('./VenueKit')>();
  return {
    ...real,
    VenueFrame: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    WalletBar: () => null,
  };
});
vi.mock('./volt/VoltVenue', async (original) => {
  const real = await original<typeof import('./volt/VoltVenue')>();
  return {
    ...real,
    VenueFrame: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    WalletBar: () => null,
  };
});

// TEST typed data: what svc-trade prepares for an L1 action (chain 1337), which the session key signs here.
const typedData = {
  domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' },
  types: {
    Agent: [
      { name: 'source', type: 'string' },
      { name: 'connectionId', type: 'bytes32' },
    ],
  },
  primaryType: 'Agent',
  message: { source: 'b', connectionId: `0x${'ab'.repeat(32)}` },
};
const ORDER = {
  venueOrderId: '1',
  venueClientOrderId: '0x11111111111111111111111111111111',
  symbol: 'BTC-USDC',
  side: 'buy',
  type: 'limit',
  timeInForce: 'GTC',
  price: '50000',
  amount: '0.01',
  filled: '0',
  remaining: '0.01',
  averagePrice: null,
  status: 'open',
  locked: '500',
  lockedAsset: 'USDC',
  reduceOnly: false,
};
const asOf = (value: unknown) => ({ ok: true, data: { venueId: 'test-hl', asOf: '2026-11-27T10:00:00.000Z', value } });
const refused = { ok: false, reason: 'refused', code: 'test.not_answered', message: 'TEST: not answered here' };

function rest(path: string, _schema: unknown, options: { body?: unknown } = {}): Promise<unknown> {
  world.calls.push({ path, body: options.body });
  switch (path) {
    case '/venue/session':
      return Promise.resolve({
        ok: true,
        data: { venueId: 'test-hl', owner: OWNER, current: world.current, asOf: '2026-11-27T10:00:00.000Z' },
      });
    case '/venue/orders/open':
      return Promise.resolve(asOf([ORDER]));
    case '/venue/positions':
    case '/venue/markets':
    case '/venue/fills':
      return Promise.resolve(asOf([]));
    case '/venue/prepare': {
      const body = options.body as { signer: { role: string; address: string } };
      return Promise.resolve({
        ok: true,
        data: {
          actionKey: 'cancel:test:1',
          prepared: {
            venueId: 'test-hl',
            signer: body.signer,
            nonce: '1',
            venueClientOrderId: ORDER.venueClientOrderId,
            typedData,
            digest: `0x${'cd'.repeat(32)}`,
          },
          reused: false,
          signed: false,
          lastOutcome: null,
        },
      });
    }
    case '/venue/submit':
      return Promise.resolve({ ok: true, data: { outcome: { definite: true, accepted: true, order: { ...ORDER, status: 'canceled' } } } });
    default:
      return Promise.resolve(refused);
  }
}
vi.mock('../../session/session', () => ({ useSession: () => ({ userId: USER, api: { rest, call: () => Promise.resolve(refused) } }) }));

import { freshKey } from '../../protocol';
import { VenueOrdersRoom } from '../orders/VenueOrders';
import { VenueRisk } from '../risk/VenueRisk';
import { OrdersPanel } from '../../../screens/money/TradeTabs';

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
let root: Root | null = null;
beforeEach(() => {
  sessionStorage.clear();
  world.status = STATUS;
  world.current = null;
  world.calls = [];
  walletSign.mockReset().mockResolvedValue({ status: 'signed', signature: '0xwallet' });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
});

/** This tab holds the session key, and svc-trade's record says the venue lists it live. */
function liveSession() {
  const held = freshKey(USER, sessionStorage, () => KEY);
  world.current = {
    sessionId: 's1',
    actionKey: 'session:test:1',
    agentAddress: held.address,
    validUntil: null,
    state: 'live',
    replacedBy: null,
    refusal: null,
  };
}

async function show(node: React.ReactNode) {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(node));
}
const buttons = (text: string) => [...document.body.querySelectorAll('button')].filter((b) => b.textContent?.trim() === text);
async function press(text: string, which: 'first' | 'last' = 'first') {
  await vi.waitFor(() => expect(buttons(text).length).toBeGreaterThan(0));
  const found = buttons(text);
  const button = which === 'first' ? found[0]! : found[found.length - 1]!;
  await act(async () => button.click());
}
const prepares = () => world.calls.filter((c) => c.path === '/venue/prepare');
const submits = () => world.calls.filter((c) => c.path === '/venue/submit');

async function signedBySessionKey(intentKind: string) {
  await vi.waitFor(() => expect(submits()).toHaveLength(1));
  expect(prepares()).toHaveLength(1);
  const body = prepares()[0]!.body as { signer: unknown; intent: { kind: string } };
  expect(body.signer).toEqual({ role: 'agent', address: AGENT });
  expect(body.intent.kind).toBe(intentKind);
  expect(walletSign).not.toHaveBeenCalled();
  const sent = submits()[0]!.body as { actionKey: string; signature: { signature: string; signedBy: string } };
  expect(sent.actionKey).toBe('cancel:test:1');
  expect(sent.signature.signedBy.toLowerCase()).toBe(AGENT);
  expect(sent.signature.signature).toBe(await sessionKey.signTypedData(typedData as never));
}

async function refusedNamingTheSession() {
  await vi.waitFor(() => expect(document.body.textContent).toContain('Start a trading session first'));
  expect(prepares()).toHaveLength(0);
  expect(walletSign).not.toHaveBeenCalled();
  expect(document.body.querySelector('[data-testid="venue-session-start"]')).not.toBeNull();
}

const rooms = [
  {
    room: 'the orders room (open orders)',
    node: () => <VenueOrdersRoom path="/trade/orders?product=venue&view=open" />,
    act: () => press('Cancel'),
  },
  { room: "Activity's Orders tab", node: () => <OrdersPanel />, act: () => press('Cancel') },
  {
    room: 'the Risk room (Cancel all orders)',
    node: () => <VenueRisk mode={{ mode: 'on', status: STATUS as never, reload: () => undefined }} />,
    act: async () => {
      await press('Cancel all orders');
      await press('Cancel all orders', 'last');
    },
  },
] as const;

describe.each(rooms)('$room on a session-key venue', ({ node, act: cancel }) => {
  it('a cancel is prepared for the live session key and signed by it, with no wallet prompt', async () => {
    liveSession();
    await show(node());
    await vi.waitFor(() =>
      expect(document.body.querySelector('[data-testid="venue-session-line"]')?.getAttribute('data-session')).toBe('live'),
    );
    await cancel();
    await signedBySessionKey('cancel_orders');
  });

  it('with no session, the cancel is refused naming the session, nothing is prepared, and Start is offered', async () => {
    await show(node());
    await vi.waitFor(() => expect(world.calls.some((c) => c.path === '/venue/orders/open')).toBe(true));
    await cancel();
    await refusedNamingTheSession();
  });
});
