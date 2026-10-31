// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredWallet, SignResult } from './eip1193';
import { useWallet, WalletProvider, type WalletApi } from './WalletProvider';

const ADDR = '0x1111111111111111111111111111111111111111';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root, api: WalletApi;
let chain = '0x14a34';
const calls: string[] = [];
let captured: unknown;
const listeners = new Map<string, (value: unknown) => void>();
const PERMIT = {
  types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }], Permit: [{ name: 'spender', type: 'address' }] },
  primaryType: 'Permit',
  domain: { chainId: 84532 },
  message: { spender: ADDR },
};
const wallet = (accounts: string[] = [ADDR]): DiscoveredWallet => ({
  info: { uuid: 'u1', name: 'Test Wallet', icon: '', rdns: 'test.wallet' },
  provider: {
    request: async ({ method, params }) => {
      calls.push(method);
      if (method === 'eth_sendTransaction' || method === 'eth_signTypedData_v4' || method === 'personal_sign') captured = params;
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return accounts;
      if (method === 'eth_chainId') return chain;
      if (method === 'wallet_switchEthereumChain') {
        chain = '0x14a34';
        return null;
      }
      if (method === 'eth_signTypedData_v4' || method === 'personal_sign') return '0xsigned';
      if (method === 'eth_sendTransaction') return `0x${'a'.repeat(64)}`;
      throw new Error(`unexpected ${method}`);
    },
    on: (event, listener) => void listeners.set(event, listener as never),
    removeListener: (event) => void listeners.delete(event),
  },
});
function Probe() {
  api = useWallet();
  return <span data-status={api.status} />;
}
const mount = async (discovered?: DiscoveredWallet) => {
  await act(async () => {
    root.render(
      <WalletProvider discovery={false}>
        <Probe />
      </WalletProvider>,
    );
  });
  if (discovered) {
    // discovery is switched off in the provider; announce through the DOM instead
    await act(async () => {
      root.render(
        <WalletProvider discovery>
          <Probe />
        </WalletProvider>,
      );
      window.addEventListener('eip6963:requestProvider', () =>
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', { detail: { info: discovered.info, provider: discovered.provider } }),
        ),
      );
    });
  }
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  chain = '0x14a34';
  calls.length = 0;
  listeners.clear();
  sessionStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function connected() {
  const found = wallet();
  await act(async () => {
    root.render(
      <WalletProvider discovery={false}>
        <Probe />
      </WalletProvider>,
    );
  });
  await act(async () => api.connect(found));
  return found;
}

describe('wallet provider', () => {
  it('is not connected outside a provider and says so when asked to sign', async () => {
    await act(async () => {
      root.render(<Probe />);
    });
    expect(api.status).toBe('disconnected');
    expect(await api.sign({ kind: 'message', message: 'x' })).toMatchObject({ status: 'failed', reason: 'not_connected' });
  });

  it('a move to another room keeps the connection and cancels an open sheet without asking the wallet', async () => {
    const found = wallet();
    const page = (room: string) => (
      <WalletProvider scope={room} discovery={false}>
        <Probe />
      </WalletProvider>
    );
    await act(async () => root.render(page('/dex')));
    await act(async () => api.connect(found));
    const result = await openSheet();
    expect(document.body.textContent).toContain('Check before you sign');
    await act(async () => root.render(page('/wallet')));
    expect(result()).toEqual({ status: 'rejected' });
    expect(document.body.textContent).not.toContain('Check before you sign');
    expect(calls).not.toContain('personal_sign');
    expect(api).toMatchObject({ status: 'connected', address: ADDR });
  });

  it('connects, reads the address and chain, and disconnects', async () => {
    await connected();
    expect(api).toMatchObject({ status: 'connected', address: ADDR, chainId: 84532, guard: { ok: true } });
    await act(async () => api.disconnect());
    expect(api).toMatchObject({ status: 'disconnected', address: null });
  });

  it('shows chain_mismatch on another chain, refuses to sign there, and recovers after the switch request', async () => {
    chain = '0x1';
    await connected();
    expect(api.guard).toMatchObject({ ok: false, code: 'chain_mismatch', observed: 1 });
    expect(await api.sign({ kind: 'message', message: 'x' })).toMatchObject({ status: 'failed', reason: 'chain_mismatch' });
    expect(calls).not.toContain('personal_sign');
    await act(async () => api.switchNetwork());
    expect(api.guard).toEqual({ ok: true });
  });

  it('follows account and chain changes made in the wallet', async () => {
    await connected();
    await act(async () => listeners.get('chainChanged')?.('0x1'));
    expect(api.guard).toMatchObject({ ok: false });
    await act(async () => listeners.get('accountsChanged')?.([]));
    expect(api.status).toBe('disconnected');
  });

  it('shows the sheet first; cancelling it is a rejection and the wallet is never asked', async () => {
    await connected();
    let result: SignResult | undefined;
    await act(async () => {
      void api.sign({ kind: 'typedData', typedData: PERMIT }).then((r) => (result = r));
    });
    expect(document.body.textContent).toContain('Check before you sign');
    expect(document.body.textContent).toContain(ADDR);
    const cancel = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!;
    await act(async () => cancel.click());
    expect(result).toEqual({ status: 'rejected' });
    expect(calls).not.toContain('eth_signTypedData_v4');
  });

  it('asks the wallet only after Continue and returns the signature', async () => {
    await connected();
    let result: SignResult | undefined;
    await act(async () => {
      void api.sign({ kind: 'typedData', typedData: PERMIT }).then((r) => (result = r));
    });
    const go = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === 'Continue in wallet')!;
    await act(async () => go.click());
    expect(result).toEqual({ status: 'signed', signature: '0xsigned' });
  });

  const openSheet = async (request: Parameters<WalletApi['sign']>[0] = { kind: 'message', message: 'hello' }) => {
    let result: SignResult | undefined;
    await act(async () => {
      void api.sign(request).then((r) => (result = r));
    });
    return () => result;
  };
  const press = (label: string) => Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === label)!;

  it('closes the open sheet as chain_mismatch when the wallet changes chain, and never asks the wallet', async () => {
    await connected();
    const result = await openSheet();
    await act(async () => listeners.get('chainChanged')?.('0x1'));
    expect(result()).toMatchObject({ status: 'failed', reason: 'chain_mismatch' });
    expect(document.body.textContent).not.toContain('Check before you sign');
    expect(calls).not.toContain('personal_sign');
  });

  it('closes the open sheet when the account changes', async () => {
    await connected();
    const result = await openSheet();
    await act(async () => listeners.get('accountsChanged')?.(['0x2222222222222222222222222222222222222222']));
    expect(result()).toEqual({ status: 'rejected' });
    expect(calls).not.toContain('personal_sign');
  });

  it('checks the chain again on Continue even if no event arrived', async () => {
    await connected();
    const result = await openSheet();
    chain = '0x1';
    await act(async () => press('Continue in wallet').click());
    expect(result()).toMatchObject({ status: 'failed', reason: 'chain_mismatch' });
    expect(calls).not.toContain('personal_sign');
  });

  it('shows the exact payload, the account and the chain, and says a permit-like signature can authorise spending', async () => {
    await connected();
    await openSheet({
      kind: 'typedData',
      typedData: { ...PERMIT, primaryType: 'Permit' },
    });
    const text = document.body.textContent ?? '';
    expect(text).toContain('Exact data');
    expect(text).toContain('Permit');
    expect(text).toContain('84532');
    expect(text).toContain('can let a contract or another address act on your behalf');
    expect(text).not.toContain('moves no funds');
  });

  it('a double press of Continue asks the wallet once', async () => {
    await connected();
    await openSheet();
    const go = press('Continue in wallet');
    await act(async () => {
      go.click();
      go.click();
    });
    expect(calls.filter((c) => c === 'personal_sign')).toHaveLength(1);
  });

  it('displays byte-for-byte what it then sends, for each kind of request', async () => {
    await connected();
    const payload = () => document.body.querySelector('[data-sheet-payload]')!.textContent;
    await openSheet({ kind: 'transaction', to: ADDR, value: '0x10', data: '0x095ea7b3' });
    expect(JSON.parse(payload()!)).toEqual(
      ((captured = undefined),
      await (async () => {
        await act(async () => press('Continue in wallet').click());
        return (captured as unknown[])[0];
      })()),
    );
    await openSheet({ kind: 'message', message: 'hello' });
    expect(payload()).toBe('hello');
    await act(async () => press('Continue in wallet').click());
    expect(JSON.stringify(captured)).toContain('0x68656c6c6f');
    await openSheet({ kind: 'typedData', typedData: PERMIT });
    const shown = payload()!;
    await act(async () => press('Continue in wallet').click());
    expect(JSON.parse((captured as string[])[1]!)).toEqual(JSON.parse(shown));
  });

  it('refuses a spoofed typed message before showing any sheet', async () => {
    await connected();
    const result = await openSheet({ kind: 'typedData', typedData: { ...PERMIT, message: { spender: ADDR, token: ADDR } } });
    expect(result()).toMatchObject({ status: 'failed', reason: 'invalid_request' });
    expect(document.body.textContent).not.toContain('Check before you sign');
  });

  it('cancel then Continue in one batch never asks the wallet', async () => {
    await connected();
    await openSheet();
    const go = press('Continue in wallet');
    await act(async () => {
      press('Cancel').click();
      go.click();
    });
    expect(calls).not.toContain('personal_sign');
  });

  it('restores a wallet that is still authorised without a prompt', async () => {
    sessionStorage.setItem('if.web3.wallet', 'test.wallet');
    await mount(wallet());
    await act(async () => undefined);
    expect(api.status).toBe('connected');
    expect(calls).toContain('eth_accounts');
    expect(calls).not.toContain('eth_requestAccounts');
  });

  it('works when storage is blocked', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await connected();
    expect(api.status).toBe('connected');
    spy.mockRestore();
  });
});
