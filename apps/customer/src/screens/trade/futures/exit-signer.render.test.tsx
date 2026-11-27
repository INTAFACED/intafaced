// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { DeskSigningContext } from '../../../features/trade/venue/VenueKit';
import type { SessionSigning } from '../../../features/trade/venue/session-signer';
import { useExitSigner, useSignPrepared } from './VenueProtect';

// On a venue whose trades only a session key signs (Hyperliquid: its orders name chain 1337, which a wallet
// refuses), a position's exit order is prepared for the desk's live session key and signed by it, never by the wallet.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const submit = vi.fn();
const walletSign = vi.fn();
vi.mock('../../../features/trade/venue/VenueKit', async (original) => {
  const real = await original<typeof import('../../../features/trade/venue/VenueKit')>();
  return { ...real, useVenueApi: () => ({ submit }) };
});
vi.mock('../../../features/protocol/wallet/WalletProvider', async (original) => {
  const real = await original<typeof import('../../../features/protocol/wallet/WalletProvider')>();
  return { ...real, useWallet: () => ({ sign: walletSign }) };
});

const OWNER = '0x1111111111111111111111111111111111111111';
const KEY = `0x${'5a'.repeat(32)}` as const;
const session = privateKeyToAccount(KEY);
const AGENT = session.address.toLowerCase();
const live: NonNullable<SessionSigning['live']> = { privateKey: KEY, address: session.address, nextTicket: 0, pendingOrder: null };

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
const prepared = (signer: { role: 'owner' | 'agent'; address: string }) =>
  ({
    actionKey: 'protection:k',
    prepared: { digest: `0x${'cd'.repeat(32)}`, typedData, signer, venueClientOrderId: '0x01', nonce: 1 },
  }) as never;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  submit.mockReset().mockResolvedValue({
    ok: true,
    data: { outcome: { definite: true, accepted: true, order: { status: 'open' } } },
  });
  walletSign.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

type Hooks = { choose: ReturnType<typeof useExitSigner>; sign: ReturnType<typeof useSignPrepared> };
function render(signing: SessionSigning | null): Hooks {
  const out = {} as Hooks;
  function Probe() {
    out.choose = useExitSigner(OWNER);
    out.sign = useSignPrepared(OWNER);
    return null;
  }
  act(() =>
    root.render(
      <DeskSigningContext.Provider value={signing}>
        <Probe />
      </DeskSigningContext.Provider>,
    ),
  );
  return out;
}

describe("a position's exit order on a session-key venue", () => {
  it('is prepared for the live session key, which signs it with no wallet prompt', async () => {
    const h = render({ tradesSignedBy: 'session_key', live });
    expect(h.choose()).toEqual({ signer: { role: 'agent', address: AGENT } });
    const result = await h.sign(prepared({ role: 'agent', address: AGENT }));
    expect(result).toMatchObject({ kind: 'outcome', outcome: { accepted: true } });
    expect(walletSign).not.toHaveBeenCalled();
    const [key, signature] = submit.mock.calls[0]!;
    expect(key).toBe('protection:k');
    expect(signature.signedBy.toLowerCase()).toBe(AGENT);
    expect(signature.signature).toBe(await session.signTypedData(typedData as never));
  });

  it('with no session on such a venue, is refused before anything is prepared, naming the session', () => {
    const h = render({ tradesSignedBy: 'session_key', live: null });
    expect(h.choose()).toMatchObject({ refusal: { code: 'trade.venue_session_needed' } });
  });

  it('prepared for a key that is no longer the live one, signs nothing and sends nothing', async () => {
    const h = render({ tradesSignedBy: 'session_key', live });
    const other = '0x2222222222222222222222222222222222222222';
    expect(await h.sign(prepared({ role: 'agent', address: other }))).toMatchObject({
      kind: 'refused',
      code: 'trade.venue_session_key_gone',
    });
    expect(submit).not.toHaveBeenCalled();
    expect(walletSign).not.toHaveBeenCalled();
  });

  it("where the wallet signs trades, or no desk provides a session, the owner's wallet signs it as before", async () => {
    expect(render({ tradesSignedBy: 'owner_wallet', live: null }).choose()).toEqual({ signer: { role: 'owner', address: OWNER } });
    const h = render(null);
    expect(h.choose()).toEqual({ signer: { role: 'owner', address: OWNER } });
    walletSign.mockResolvedValue({ status: 'signed', signature: '0xsig' });
    await h.sign(prepared({ role: 'owner', address: OWNER }));
    expect(walletSign).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]![1]).toEqual({ digest: `0x${'cd'.repeat(32)}`, signature: '0xsig', signedBy: OWNER });
  });
});
