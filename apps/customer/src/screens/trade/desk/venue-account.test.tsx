// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WalletProvider } from '../../../features/protocol/wallet/WalletProvider';
import type { DiscoveredWallet } from '../../../features/protocol/wallet/eip1193';
import type { AsOf, VenueBalance, VenueMarket, VenueUp } from '../../../features/trade/venue-api';
import { VenueAccountPanel } from './VenueAccountPanel';

// The venue account panel sits in the 18.75rem desk ticket column: the connected wallet address wraps anywhere via
// `lt-mono` (unlike `lt-num`, which keeps figures on one line with `white-space: nowrap`), and Flatten stacks below
// the key/value list so long symbols stay inside the panel.

const WIDE_ADDR = '0x0000000000000000000000000000000000000000';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STATUS: VenueUp = {
  enabled: true,
  available: true,
  venue: { id: 'test-venue', displayName: 'TEST venue', proofLevel: 'simulator' },
  test: true,
  chainId: 84532,
  builder: null,
};

const MARKET: VenueMarket = {
  symbol: 'JSEAA4026C-USDC',
  kind: 'spot',
  baseAsset: 'JSEAA4026C',
  quoteAsset: 'USDC',
  orderTypes: ['limit', 'market'],
  timeInForce: ['GTC', 'IOC'],
  marginModes: [],
  maxLeverageBps: null,
  tickSize: '0.1',
  lotSize: '0.001',
  minOrderNotional: '1',
  priceBandBps: '9500',
  maxOpenOrders: 1000,
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
};

const BALANCES: AsOf<VenueBalance[]> = {
  venueId: 'test-venue',
  asOf: '2026-11-24T16:52:30.000Z',
  value: [
    { asset: 'USDC', free: '5947.88062', locked: '0', total: '5947.88062' },
    { asset: 'JSEAA4026C', free: '9.5', locked: '0', total: '9.5' },
  ],
};

let host: HTMLDivElement;
let root: Root;
let announce: (() => void) | null = null;

function installConnectedWallet(address: string) {
  const found: DiscoveredWallet = {
    info: { uuid: 'u-acct', name: 'Test Wallet', icon: '', rdns: 'test.wallet' },
    provider: {
      request: ({ method }) => {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return Promise.resolve([address]);
        if (method === 'eth_chainId') return Promise.resolve('0x14a34');
        return Promise.reject(new Error(`unexpected ${method}`));
      },
    },
  };
  sessionStorage.setItem('if.web3.wallet', 'test.wallet');
  announce = () =>
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: found.info, provider: found.provider } }));
  window.addEventListener('eip6963:requestProvider', announce);
}

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

describe('VenueAccountPanel stays inside the narrow desk ticket column', () => {
  it('renders the connected wallet address with wrapping monospace (`lt-mono`), never non-wrapping `lt-num`', async () => {
    installConnectedWallet(WIDE_ADDR);
    await act(async () => {
      root.render(
        <WalletProvider>
          <VenueAccountPanel
            status={STATUS}
            market={MARKET}
            balances={BALANCES}
            onDeposit={() => undefined}
            onWithdraw={() => undefined}
            onFlatten={() => undefined}
            withdrawal={null}
          />
        </WalletProvider>,
      );
    });
    const addr = host.querySelector('[data-testid="venue-wallet-address"]');
    expect(addr?.textContent).toBe(WIDE_ADDR);
    expect(addr?.classList.contains('lt-mono')).toBe(true);
    expect(addr?.classList.contains('lt-num')).toBe(false);

    // Confirm the kit rule `lt-mono` breaks anywhere and does not set `white-space: nowrap`.
    const templatesCss = readFileSync(resolve(process.cwd(), '../../packages/ui/src/lit/templates/templates.css'), 'utf8');
    const monoBlock = templatesCss.match(/\.lt-mono\s*\{[^}]*\}/)?.[0] ?? '';
    expect(monoBlock).toContain('overflow-wrap: anywhere');
    expect(monoBlock).not.toContain('white-space: nowrap');
  });

  it('stacks the Flatten note and button outside the two-column `.lt-kv` row so a long symbol never spills past the panel', async () => {
    installConnectedWallet(WIDE_ADDR);
    await act(async () => {
      root.render(
        <WalletProvider>
          <VenueAccountPanel
            status={STATUS}
            market={MARKET}
            balances={BALANCES}
            onDeposit={() => undefined}
            onWithdraw={() => undefined}
            onFlatten={() => undefined}
            withdrawal={null}
          />
        </WalletProvider>,
      );
    });
    const account = host.querySelector('[data-testid="venue-account"]');
    const flatten = [...(account?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === 'Flatten JSEAA4026C');
    expect(flatten).toBeDefined();
    expect(flatten?.closest('dl.lt-kv')).toBeNull();
  });
});
