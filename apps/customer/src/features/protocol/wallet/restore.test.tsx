// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WalletBar } from '../../trade/venue/VenueKit';
import type { DiscoveredWallet } from './eip1193';
import { RESTORE_TIMEOUT_MS, WalletProvider } from './WalletProvider';

const ADDR = '0x2222222222222222222222222222222222222222';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
let announce: (() => void) | null = null;
let answer: (accounts: string[]) => void = () => undefined;

/** A wallet that announces itself at once and answers `eth_accounts` only when the test says so. */
const slowWallet = (): DiscoveredWallet => ({
  info: { uuid: 'u-restore', name: 'Test Wallet', icon: '', rdns: 'test.wallet' },
  provider: {
    request: ({ method }) => {
      if (method === 'eth_accounts') return new Promise((resolve) => (answer = resolve));
      if (method === 'eth_requestAccounts') return Promise.resolve([ADDR]);
      if (method === 'eth_chainId') return Promise.resolve('0x14a34');
      return Promise.reject(new Error(`unexpected ${method}`));
    },
  },
});
const installed = (found: DiscoveredWallet) => {
  announce = () =>
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: found.info, provider: found.provider } }));
  window.addEventListener('eip6963:requestProvider', announce);
};
const render = async () => {
  await act(async () => {
    root.render(
      <WalletProvider>
        <WalletBar />
      </WalletProvider>,
    );
  });
};
const connectButton = () => [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Connect'));
const shownAddress = () => host.querySelector('[data-testid="venue-wallet-address"]')?.textContent ?? null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  sessionStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  if (announce) window.removeEventListener('eip6963:requestProvider', announce);
  announce = null;
});

describe('a remembered wallet', () => {
  it('is never offered Connect before its restore has answered, and comes back connected', async () => {
    sessionStorage.setItem('if.web3.wallet', 'test.wallet');
    installed(slowWallet());
    await render();
    expect(connectButton()).toBeUndefined();
    await act(async () => answer([ADDR]));
    expect(shownAddress()).toBe(ADDR);
    expect(connectButton()).toBeUndefined();
  });

  it('that is no longer authorised is offered Connect once the wallet has said so, and forgotten', async () => {
    sessionStorage.setItem('if.web3.wallet', 'test.wallet');
    installed(slowWallet());
    await render();
    expect(connectButton()).toBeUndefined();
    await act(async () => answer([]));
    expect(connectButton()?.textContent).toBe('Connect Test Wallet');
    expect(shownAddress()).toBeNull();
    expect(sessionStorage.getItem('if.web3.wallet')).toBeNull();
  });

  it('whose wallet never answers is shown disconnected once the restore has had its time, and a late answer is not adopted', async () => {
    vi.useFakeTimers();
    try {
      sessionStorage.setItem('if.web3.wallet', 'test.wallet');
      installed(slowWallet());
      await render();
      expect(connectButton()).toBeUndefined();
      await act(async () => vi.advanceTimersByTime(RESTORE_TIMEOUT_MS));
      expect(connectButton()?.textContent).toBe('Connect Test Wallet');
      await act(async () => answer([ADDR]));
      expect(shownAddress()).toBeNull();
      expect(connectButton()?.textContent).toBe('Connect Test Wallet');
    } finally {
      vi.useRealTimers();
    }
  });

  it('whose wallet is not in this browser any more shows the room as disconnected', async () => {
    sessionStorage.setItem('if.web3.wallet', 'gone.wallet');
    installed(slowWallet());
    await render();
    expect(connectButton()?.textContent).toBe('Connect Test Wallet');
  });
});

describe('a wallet that is not remembered', () => {
  it('is offered Connect at first render, and connects when pressed', async () => {
    installed(slowWallet());
    await render();
    const button = connectButton();
    expect(button?.textContent).toBe('Connect Test Wallet');
    await act(async () => button?.click());
    expect(shownAddress()).toBe(ADDR);
  });
});
