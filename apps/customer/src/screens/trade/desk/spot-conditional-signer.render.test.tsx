// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { DeskSigningContext } from '../../../features/trade/venue/VenueKit';
import type { SessionSigning } from '../../../features/trade/venue/session-signer';
import { venueMarketSchema } from '../../../features/trade/venue-api';
import { VenueConditionalOrders } from './VenueConditionalOrders';

// On a venue whose trades only a session key signs (Hyperliquid: its orders name chain 1337, which a wallet refuses), a
// spot stop the venue holds is the person's own order: prepared for the desk's live session key and signed by it, never
// by the wallet; with no session there, the desk's refusal and nothing is prepared.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const createSpotOrder = vi.fn();
const submit = vi.fn();
const walletSign = vi.fn();
vi.mock('../../../features/trade/venue/VenueKit', async (original) => {
  const real = await original<typeof import('../../../features/trade/venue/VenueKit')>();
  return {
    ...real,
    useVenueApi: () => ({ submit, createSpotOrder, spotOrders: async () => ({ ok: true, data: { orders: [] } }) }),
  };
});
vi.mock('../../../features/protocol/wallet/WalletProvider', async (original) => {
  const real = await original<typeof import('../../../features/protocol/wallet/WalletProvider')>();
  return { ...real, useWallet: () => ({ sign: walletSign }) };
});

const OWNER = '0x1111111111111111111111111111111111111111';
const KEY = `0x${'5b'.repeat(32)}` as const;
const session = privateKeyToAccount(KEY);
const AGENT = session.address.toLowerCase();
const live: NonNullable<SessionSigning['live']> = { privateKey: KEY, address: session.address, nextTicket: 0, pendingOrder: null };
// TEST market: a spot market whose venue judges stops on its last trade, so the stop rests on the venue.
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

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  createSpotOrder.mockReset().mockImplementation(async (req: { signer?: { role: string; address: string } }) => ({
    ok: true,
    data: {
      restsOn: 'venue',
      reused: false,
      actionKey: 'spot-cond:k:venue',
      prepared: { digest: `0x${'cd'.repeat(32)}`, typedData, signer: req.signer, venueClientOrderId: '0x01', nonce: 1 },
    },
  }));
  submit.mockReset().mockResolvedValue({ ok: true, data: { outcome: { definite: true, accepted: true, order: { status: 'open' } } } });
  walletSign.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(signing: SessionSigning | null) {
  act(() =>
    root.render(
      <DeskSigningContext.Provider value={signing}>
        <VenueConditionalOrders market={market} owner={OWNER} venueName="TEST venue" />
      </DeskSigningContext.Provider>,
    ),
  );
}

function type(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label^="${label}"]`)!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function placeStopLimit() {
  type('Size', '1');
  type('Trigger price', '95');
  type('Limit price', '94');
  const place = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Place order')!;
  await act(async () => {
    place.click();
  });
}

describe('a spot stop the venue holds, on a session-key venue', () => {
  it('is prepared for the live session key, which signs it with no wallet prompt', async () => {
    render({ tradesSignedBy: 'session_key', live });
    await placeStopLimit();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(createSpotOrder).toHaveBeenCalledTimes(1);
    expect(createSpotOrder.mock.calls[0]![0]).toMatchObject({ kind: 'stop_limit', signer: { role: 'agent', address: AGENT } });
    expect(walletSign).not.toHaveBeenCalled();
    const [key, signature] = submit.mock.calls[0]!;
    expect(key).toBe('spot-cond:k:venue');
    expect(signature.signedBy.toLowerCase()).toBe(AGENT);
    expect(signature.signature).toBe(await session.signTypedData(typedData as never));
    expect(host.textContent).toContain('Rests on the venue as its trigger order.');
  });

  it('with no session on such a venue, is refused naming the session, and nothing is prepared', async () => {
    render({ tradesSignedBy: 'session_key', live: null });
    await placeStopLimit();
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="spot-conditional-refusal"]')?.textContent).toContain('trade.venue_session_needed'),
    );
    expect(createSpotOrder).not.toHaveBeenCalled();
  });

  it("where the wallet signs trades, the owner's wallet signs it as before", async () => {
    walletSign.mockResolvedValue({ status: 'signed', signature: '0xsig' });
    render({ tradesSignedBy: 'owner_wallet', live: null });
    await placeStopLimit();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(createSpotOrder.mock.calls[0]![0]).toMatchObject({ signer: { role: 'owner', address: OWNER } });
    expect(walletSign).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]![1]).toEqual({ digest: `0x${'cd'.repeat(32)}`, signature: '0xsig', signedBy: OWNER });
  });
});
