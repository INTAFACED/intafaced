// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeldKey } from '../../protocol';
import type { SessionSigning } from './session-signer';

// `useVenueActions` with a trading session (session-signer.ts): an order, cancel or close is prepared for the live
// session key and signed by it here, with no wallet prompt; an approval stays the wallet's; with no live key on a venue
// only a session key trades on, nothing is prepared. Idempotency is as before: a resend is the same bytes, same signer.

const OWNER = '0x1111111111111111111111111111111111111111';
const PRIVATE = `0x${'ab'.repeat(32)}` as const;
const AGENT = privateKeyToAccount(PRIVATE).address.toLowerCase();
const live: HeldKey = { address: AGENT, privateKey: PRIVATE, nextTicket: 1, pendingOrder: null };

const typedData = {
  domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: `0x${'0'.repeat(40)}` },
  types: {
    Agent: [
      { name: 'source', type: 'string' },
      { name: 'connectionId', type: 'bytes32' },
    ],
  },
  primaryType: 'Agent',
  message: { source: 'b', connectionId: `0x${'ef'.repeat(32)}` },
};
const answer = (actionKey: string, signer: { role: string; address: string }, over: Record<string, unknown> = {}) => ({
  ok: true,
  data: {
    actionKey,
    prepared: { venueId: 'hl', signer, nonce: '7', venueClientOrderId: '0xcloid', typedData, digest: `0x${'cd'.repeat(32)}` },
    reused: false,
    signed: false,
    lastOutcome: null,
    ...over,
  },
});
const accepted = { definite: true, accepted: true, venueRef: null, order: null, asOf: '2026-11-25T02:00:00.000Z' };

const venue = {
  prepare: vi.fn(async (input: { intent: { kind: string; clientOrderKey?: string }; signer: { role: string; address: string } }) =>
    answer(input.intent.clientOrderKey ?? 'k', input.signer),
  ),
  submit: vi.fn(async (_key: string, _signature: unknown) => ({ ok: true, data: { actionKey: 'k', outcome: accepted, readBack: null } })),
};
const wallet = { sign: vi.fn(async () => ({ status: 'signed', signature: '0xownersig' })) };
vi.mock('./venue-words', async (actual) => ({ ...(await actual<typeof import('./venue-words')>()), useVenueApi: () => venue }));
vi.mock('../../protocol', async (actual) => ({ ...(await actual<typeof import('../../protocol')>()), useWallet: () => wallet }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { useVenueActions, SESSION_NEEDED, SESSION_KEY_GONE } = await import('./VenueKit');

let host: HTMLDivElement;
let root: Root;
let actions: ReturnType<typeof useVenueActions>;
function Probe({ session }: { session: SessionSigning | null }) {
  actions = useVenueActions(OWNER, session);
  return null;
}
const mount = (session: SessionSigning | null) => act(async () => root.render(<Probe session={session} />));

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  venue.prepare.mockClear();
  venue.submit.mockClear();
  wallet.sign.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const order = (key: string) =>
  ({
    kind: 'place_order',
    symbol: 'BTC-PERP',
    side: 'buy',
    type: 'limit',
    amount: '0.001',
    price: '1000',
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: key,
    builderFee: null,
  }) as const;

describe('the desk signs with a live trading session key', () => {
  it('an order is prepared for the key, signed by it here with no wallet prompt, and its bytes recover to the key', async () => {
    await mount({ tradesSignedBy: 'session_key', live });
    const result = await act(() => actions.run(order('order:a')));
    expect(result).toMatchObject({ kind: 'outcome' });
    expect(venue.prepare.mock.calls[0]![0]).toMatchObject({ owner: OWNER, signer: { role: 'agent', address: AGENT } });
    expect(wallet.sign).not.toHaveBeenCalled();
    const signature = venue.submit.mock.calls[0]![1] as { signature: `0x${string}`; signedBy: string };
    expect(signature.signedBy).toBe(AGENT);
    const recovered = await recoverTypedDataAddress({
      ...typedData,
      signature: signature.signature,
    } as Parameters<typeof recoverTypedDataAddress>[0]);
    expect(recovered.toLowerCase()).toBe(AGENT);
  });

  it('a cancel and a close (a reduce-only order) take the key too', async () => {
    await mount({ tradesSignedBy: 'session_key', live });
    await act(() => actions.run({ kind: 'cancel_order', symbol: 'BTC-PERP', clientOrderKey: 'order:a' }));
    await act(() => actions.run({ ...order('close:a'), reduceOnly: true }));
    expect(venue.prepare.mock.calls.map((c) => c[0].signer.role)).toEqual(['agent', 'agent']);
    expect(wallet.sign).not.toHaveBeenCalled();
  });

  it('our builder-fee approval stays the wallet’s, session or not', async () => {
    await mount({ tradesSignedBy: 'session_key', live });
    await act(() => actions.run({ kind: 'approve_builder_fee', builder: OWNER, maxFeeBps: '0.5' }, { actionKey: 'builder-fee:x' }));
    expect(venue.prepare.mock.calls[0]![0].signer).toEqual({ role: 'owner', address: OWNER });
    expect(wallet.sign).toHaveBeenCalledTimes(1);
  });

  it('with no live key on a venue only a session key trades on, nothing is prepared or signed: the desk offers the session', async () => {
    await mount({ tradesSignedBy: 'session_key', live: null });
    const result = await act(() => actions.run(order('order:b')));
    expect(result).toMatchObject({ kind: 'refused', code: SESSION_NEEDED, beforeWallet: true });
    expect(venue.prepare).not.toHaveBeenCalled();
    expect(wallet.sign).not.toHaveBeenCalled();
  });

  it('on a venue the wallet signs, nothing changes: the owner signs in the wallet', async () => {
    await mount(null);
    await act(() => actions.run(order('order:c')));
    expect(venue.prepare.mock.calls[0]![0].signer).toEqual({ role: 'owner', address: OWNER });
    expect(wallet.sign).toHaveBeenCalledTimes(1);
  });

  it('a resend after an answer that was not definite is the same bytes under the same signer, never a new signature', async () => {
    await mount({ tradesSignedBy: 'session_key', live });
    venue.submit.mockResolvedValueOnce({ ok: false, reason: 'uncertain', message: 'lost' } as never);
    const first = await act(() => actions.run(order('order:f')));
    expect(first).toMatchObject({ kind: 'unknown' });
    const firstBytes = venue.submit.mock.calls[0]![1];
    await act(() => actions.resend(order('order:f')));
    expect(venue.prepare.mock.calls[1]![0].signer).toEqual({ role: 'agent', address: AGENT });
    expect(venue.submit.mock.calls[1]![1]).toEqual(firstBytes);
    expect(wallet.sign).not.toHaveBeenCalled();
  });

  it('a stored agent action whose key is no longer this tab’s live key is not signed', async () => {
    await mount({ tradesSignedBy: 'session_key', live });
    // First prepare of the key: the door stores it, but the page loses the race and the key goes before it signs.
    let release: () => void = () => {};
    venue.prepare.mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          release = () => resolve(answer(input.intent.clientOrderKey ?? 'k', input.signer));
        }) as never,
    );
    const pending = actions.run(order('order:g'));
    await mount({ tradesSignedBy: 'session_key', live: null });
    await act(async () => release());
    expect(await pending).toMatchObject({ kind: 'refused', code: SESSION_KEY_GONE, beforeWallet: true });
    expect(venue.submit).not.toHaveBeenCalled();
    expect(wallet.sign).not.toHaveBeenCalled();
  });
});
