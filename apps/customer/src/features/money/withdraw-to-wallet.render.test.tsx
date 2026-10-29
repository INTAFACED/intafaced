// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Destination, WithdrawAsset } from './contracts';

/**
 * J-dex-protocol-04 #9 and J-dex-protocol-05 #3 on the screen (D-bridge-chain-02): `/uc/withdraw?to=wallet` fills the
 * destination from the connected browser wallet, read-only until Edit, and the network from the person's saved entry for
 * that address. It is still a send out: "Confirm and send" appears only for a saved address that is ready, and it asks for
 * the same fresh step-up. No wallet: "Connect a wallet to use it" and nothing is filled. A wallet that goes away clears it.
 */

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
const mutate = vi.fn();
const noRewards = { ok: true, data: { rewards: [], totals: [], more: false } };
const LIMITS = {
  tier: 'full',
  assetId: 'USDT',
  perTx: '100',
  rolling24h: '200',
  used24h: '0',
  remaining: { perTx: '100', rolling24h: '200' },
  maxNow: '100',
};
const RULES = { assetId: 'USDT', networkId: 'base', minimum: '1', maximum: '1000', step: '0.5', tag: 'none' };
const query = vi.fn(async (module: string, procedure: string) =>
  module === 'campaigns'
    ? noRewards
    : procedure === 'withdrawal.networkRules'
      ? { ok: true, data: RULES }
      : procedure === 'withdrawal.destination'
        ? { ok: true, data: { kind: 'external' } }
        : { ok: true, data: LIMITS },
);
vi.mock('../session/session', () => ({ useSession: () => ({ userId: 'u1', api: { mutate, query } }) }));
vi.mock('./holdings', () => ({
  useHoldings: () => ({
    resource: { status: 'ready', data: { assets: [{ assetId: 'USDT', available: '10' }], spaces: [], holdings: [] } },
    reload: () => undefined,
  }),
}));
// The wallet connection as WalletProvider gives it; each test sets what the wallet holds.
const WALLET = '0x52908400098527886e0f7030069857d2e4169ee7';
const connect = vi.fn();
let wallet: { status: 'disconnected' | 'connecting' | 'connected'; address: string | null; chainId: number | null } = {
  status: 'connected',
  address: WALLET,
  chainId: 84532,
};
vi.mock('../protocol/wallet/WalletProvider', () => ({
  useWallet: () => ({
    ...wallet,
    wallets: [{ info: { name: 'TEST Wallet', rdns: 'test.wallet', icon: '', uuid: 'u' }, provider: {} }],
    connected: null,
    problem: null,
    connect,
  }),
}));
const ASSETS: WithdrawAsset[] = [
  {
    assetId: 'USDT',
    precision: 6,
    networks: [
      { networkId: 'ethereum', label: 'TEST Ethereum' },
      { networkId: 'base', label: 'TEST Base' },
    ],
    defaultNetworkId: 'ethereum',
  },
];
const SAVED: Destination = {
  destinationId: '22222222-2222-4222-8222-222222222222',
  label: 'TEST my wallet',
  kind: 'crypto',
  ref: '0x52908400098527886E0F7030069857D2E4169EE7',
  addedAt: '2026-10-01T10:00:00Z',
  coolingOffEndsAt: '2026-10-02T10:00:00Z',
  coolingBlocker: null,
  assetId: 'USDT',
  network: 'base',
  state: 'active',
};
let book: Destination[] = [];
vi.mock('./components', async (original) => {
  const real = await original<typeof import('./components')>();
  return {
    ...real,
    useBankRead: (procedure: string) =>
      procedure === 'ramps.destinations.networks'
        ? { resource: { status: 'ready', data: ASSETS }, reload: () => undefined }
        : { resource: { status: 'ready', data: book }, reload: () => undefined },
  };
});
import { WithdrawForm } from './WithdrawForm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const quote = (networkId: string) => ({
  quoteRef: 'q',
  assetId: 'USDT',
  networkId,
  amount: '1',
  feeMode: 'on_top',
  fees: [{ kind: 'network', amount: '0.5' }],
  feeTotal: '0.5',
  netAmount: '1',
  totalDebit: '1.5',
  feeSource: 'fixed',
  quotedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  expired: false,
  acceptedBy: null,
});
let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  mutate.mockReset();
  connect.mockReset();
  book = [];
  wallet = { status: 'connected', address: WALLET, chainId: 84532 };
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
  sessionStorage.clear();
});

async function render(toWallet = true) {
  root ??= createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<WithdrawForm toWallet={toWallet} />));
}
function field(label: string): HTMLInputElement | HTMLSelectElement {
  const found = [...document.querySelectorAll('label.field')].find((l) => l.querySelector('span')?.textContent === label);
  if (!found) throw new Error(`no field labelled ${label}`);
  return found.querySelector('input, select') as HTMLInputElement | HTMLSelectElement;
}
async function type(label: string, value: string) {
  const input = field(label);
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
const button = (name: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === name) as HTMLButtonElement | undefined;
async function press(name: string) {
  await act(async () => void button(name)!.click());
}
const chip = () => document.querySelector('[data-testid="withdraw-wallet"]');

describe('Withdraw to my Web3 wallet (D-bridge-chain-02)', () => {
  it('fills the destination with the connected account, read-only until Edit, and names the wallet’s chain', async () => {
    await render();
    const destination = field('Your wallet') as HTMLInputElement;
    expect(destination.value).toBe(WALLET);
    expect(destination.readOnly).toBe(true);
    expect(chip()?.getAttribute('data-state')).toBe('filled');
    expect(chip()?.textContent).toContain('Your wallet is on Base Sepolia test network.');
    // Not saved: the network is not guessed from the chain, and the only way on is the address book.
    expect(chip()?.textContent).toContain('the network is not filled from your wallet');
    expect((field('Network') as HTMLSelectElement).disabled).toBe(false);
    expect(document.querySelector('a[href="/uc/withdraw/address"]')?.textContent).toContain('Manage saved addresses');
    expect([...document.querySelectorAll('a')].some((a) => a.textContent === 'Save this wallet in your address book')).toBe(true);
    await press('Edit');
    expect((field('Your wallet') as HTMLInputElement).readOnly).toBe(false);
    expect((field('Your wallet') as HTMLInputElement).value).toBe(WALLET);
    expect(chip()?.getAttribute('data-state')).toBe('edited');
    expect(button('Edit')).toBeUndefined();
  });

  it('never sends to the wallet’s address while it is not a saved, ready address: no confirm after the fee', async () => {
    mutate.mockResolvedValue({ ok: true, data: quote('ethereum') });
    await render();
    await type('Amount', '1');
    await press('Get the fee');
    expect(button('Confirm and send')).toBeUndefined();
    expect(button('Review withdrawal')?.disabled).toBe(true);
    expect(mutate.mock.calls.map(([, procedure]) => procedure)).toEqual(['withdrawal.quote']);
  });

  it('a saved wallet still cooling off is not chosen, and nothing can be confirmed', async () => {
    book = [{ ...SAVED, state: 'cooling', coolingOffEndsAt: new Date(Date.now() + 86_400_000).toISOString() }];
    mutate.mockResolvedValue({ ok: true, data: quote('base') });
    await render();
    expect((field('Network') as HTMLSelectElement).value).toBe('base');
    await type('Amount', '1');
    await press('Get the fee');
    expect(button('Confirm and send')).toBeUndefined();
  });

  it('a saved, ready wallet fills its network and saved entry, and confirming still asks for the step-up', async () => {
    book = [SAVED];
    mutate.mockResolvedValue({ ok: true, data: quote('base') });
    await render();
    const network = field('Network') as HTMLSelectElement;
    expect(network.value).toBe('base');
    expect(network.disabled).toBe(true);
    expect(chip()?.textContent).toContain('The network is the one you saved this wallet on.');
    const saved = field('Saved address') as HTMLSelectElement;
    expect(saved.value).toBe(SAVED.destinationId);
    expect(saved.disabled).toBe(true);
    await type('Amount', '1');
    await press('Get the fee');
    expect(button('Confirm and send')?.disabled).toBe(false);
    await press('Confirm and send');
    expect(document.body.textContent).toContain('Sending money out needs a fresh confirmation.');
    expect(document.querySelector('input[name="withdraw-stepup-code"]')).not.toBeNull();
    // Nothing is sent before the step-up answers.
    expect(mutate.mock.calls.map(([, procedure]) => procedure)).toEqual(['withdrawal.quote']);
  });

  it('Edit keeps the network and the saved entry the wallet chose, now the person’s to change', async () => {
    book = [SAVED];
    await render();
    await press('Edit');
    expect((field('Network') as HTMLSelectElement).value).toBe('base');
    expect((field('Network') as HTMLSelectElement).disabled).toBe(false);
    expect((field('Saved address') as HTMLSelectElement).value).toBe(SAVED.destinationId);
    expect((field('Saved address') as HTMLSelectElement).disabled).toBe(false);
  });

  it('with no wallet, says "Connect a wallet to use it", fills nothing and offers the wallets it sees', async () => {
    wallet = { status: 'disconnected', address: null, chainId: null };
    await render();
    expect(chip()?.textContent).toContain('Connect a wallet to use it');
    expect(chip()?.getAttribute('data-code')).toBe('wallet.not_connected');
    expect((field('Or enter a new address') as HTMLInputElement).value).toBe('');
    expect((field('Or enter a new address') as HTMLInputElement).readOnly).toBe(false);
    expect(button('Edit')).toBeUndefined();
    await press('Connect TEST Wallet');
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('a wallet that disconnects after the fill clears the destination and refuses wallet.not_connected, closing the confirmation', async () => {
    book = [SAVED];
    mutate.mockResolvedValue({ ok: true, data: quote('base') });
    await render();
    await type('Amount', '1');
    await press('Get the fee');
    await press('Confirm and send');
    expect(document.querySelector('input[name="withdraw-stepup-code"]')).not.toBeNull();
    wallet = { status: 'disconnected', address: null, chainId: null };
    await render();
    expect(document.querySelector('input[name="withdraw-stepup-code"]')).toBeNull();
    expect((field('Or enter a new address') as HTMLInputElement).value).toBe('');
    expect(chip()?.getAttribute('role')).toBe('alert');
    expect(chip()?.textContent).toContain('Your wallet disconnected, so its address was cleared and nothing was sent.');
    expect(chip()?.textContent).toContain('Reference: wallet.not_connected');
    expect(button('Confirm and send')).toBeUndefined();
    expect(mutate.mock.calls.map(([, procedure]) => procedure)).toEqual(['withdrawal.quote']);
  });

  it('without to=wallet the form is the normal one, wallet or not', async () => {
    await render(false);
    expect(chip()).toBeNull();
    expect((field('Or enter a new address') as HTMLInputElement).value).toBe('');
  });
});
