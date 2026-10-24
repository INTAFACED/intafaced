// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
const address = vi.fn();
vi.mock('../session/session', () => ({ useSession: () => ({ userId: 'u1', api: {} }) }));
vi.mock('./deposit-reads', async (original) => ({
  ...(await original<typeof import('./deposit-reads')>()),
  // The address list under an issued address loads on its own; DepositAddresses.render.test.tsx covers it.
  createDepositReads: () => ({ address, addresses: () => new Promise(() => undefined) }),
}));
import { DepositAddressPanel, DepositNetworkPicker } from './DepositFunding';
import type { DepositCatalogue } from './deposit-reads';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  address.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
});

// TEST figures, not published settings.
const catalogue: DepositCatalogue = {
  assets: [
    {
      assetId: 'USDT',
      networks: [
        { id: 'ethereum', label: 'Ethereum', minimumDeposit: '10', confirmationsRequired: 12, estimatedArrivalMinutes: 5 },
        { id: 'tron', label: 'Tron', minimumDeposit: '5.5', confirmationsRequired: 20, estimatedArrivalMinutes: 3 },
      ],
    },
  ],
};
const ready = { status: 'ready', data: catalogue } as const;
const unset = { status: 'failed', failure: { ok: false, reason: 'error', message: 'x', code: 'bank.deposit_custody_unset' } } as const;
const issued = (over: object = {}) => ({
  ok: true,
  data: {
    assetId: 'USDT',
    networkId: 'ethereum',
    address: '0xTEST000000000000000000000000000000000001',
    memo: null,
    qrPayload: null,
    ...over,
  },
});

async function mount(node: React.ReactNode) {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(node));
}
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined;

describe('deposit address panel', () => {
  it('with custody unset names the blocker, shows no address and no way to ask for one', async () => {
    await mount(<DepositAddressPanel asset="USDT" catalogue={unset as never} networkId="" />);
    expect(host.textContent).toContain('Deposit addresses are not available');
    expect(host.textContent).toContain('Not published');
    expect(button('Show my deposit address')).toBeUndefined();
    expect(address).not.toHaveBeenCalled();
  });

  it('with no network chosen asks for one first and requests nothing', async () => {
    await mount(<DepositAddressPanel asset="USDT" catalogue={ready as never} networkId="" />);
    expect(host.textContent).toContain('Choose an asset and a network');
    expect(button('Show my deposit address')).toBeUndefined();
    expect(address).not.toHaveBeenCalled();
  });

  it('keeps the address hidden until the loss warning is confirmed, then asks once and shows the address, copy and QR', async () => {
    address.mockResolvedValue(issued());
    await mount(<DepositAddressPanel asset="USDT" catalogue={ready as never} networkId="ethereum" />);
    expect(host.textContent).toContain('10 USDT');
    expect(host.textContent).toContain('12');
    expect(host.textContent).toContain('About 5 minutes');
    const show = button('Show my deposit address')!;
    expect(show.disabled).toBe(true);
    await act(async () => show.click());
    expect(address).not.toHaveBeenCalled();
    const box = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => box.click());
    expect(show.disabled).toBe(false);
    await act(async () => show.click());
    expect(address).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('0xTEST000000000000000000000000000000000001');
    expect(host.textContent).toContain('Send only USDT on Ethereum to this address.');
    expect(button('Copy')).toBeDefined();
    expect(document.querySelector('[data-testid="pay-qr"]')).not.toBeNull();
    // Under it, the person's other addresses for this pair (W-deposit-02).
    expect(document.querySelector('[data-testid="deposit-addresses"]')).not.toBeNull();
    expect(host.textContent).not.toContain('Memo or tag');
  });

  it('shows a memo block with its own copy when the bank returns a memo', async () => {
    address.mockResolvedValue(issued({ memo: 'TEST-MEMO-77' }));
    await mount(<DepositAddressPanel asset="USDT" catalogue={ready as never} networkId="ethereum" />);
    await act(async () => (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await act(async () => button('Show my deposit address')!.click());
    expect(host.textContent).toContain('Memo or tag (required)');
    expect(host.textContent).toContain('TEST-MEMO-77');
  });

  it('says nothing was issued when the request fails, and lets the person try again', async () => {
    address.mockResolvedValueOnce({ ok: false, reason: 'error', message: 'x', code: 'bank.deposit_custody_unset' });
    await mount(<DepositAddressPanel asset="USDT" catalogue={ready as never} networkId="ethereum" />);
    await act(async () => (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await act(async () => button('Show my deposit address')!.click());
    expect(host.textContent).toContain('Nothing was issued');
    expect(host.textContent).not.toContain('0xTEST');
    address.mockResolvedValueOnce(issued());
    await act(async () => button('Show my deposit address')!.click());
    expect(host.textContent).toContain('0xTEST');
  });

  it('starts again for another network: the address for one network is never shown under another', async () => {
    address.mockResolvedValue(issued());
    await mount(<DepositAddressPanel asset="USDT" catalogue={ready as never} networkId="ethereum" />);
    await act(async () => (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await act(async () => button('Show my deposit address')!.click());
    expect(host.textContent).toContain('0xTEST');
    await act(async () => root!.render(<DepositAddressPanel asset="USDT" catalogue={ready as never} networkId="tron" />));
    expect(host.textContent).not.toContain('0xTEST');
    expect(host.textContent).toContain('5.5 USDT');
  });
});

describe('deposit network picker', () => {
  it('lists the published networks with none chosen, and is off with the reason when none are published', async () => {
    await mount(
      <DepositNetworkPicker asset="USDT" catalogue={ready as never} networkId="" onNetwork={() => undefined} reload={() => undefined} />,
    );
    const select = host.querySelector('select')!;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Choose a network', 'Ethereum', 'Tron']);
    await act(async () =>
      root!.render(
        <DepositNetworkPicker asset="BTC" catalogue={ready as never} networkId="" onNetwork={() => undefined} reload={() => undefined} />,
      ),
    );
    expect(host.querySelector('select')!.disabled).toBe(true);
    expect(host.textContent).toContain('No networks are published for BTC.');
  });

  it('with custody unset keeps the old blocker reason and offers no retry; a failed read offers one', async () => {
    await mount(
      <DepositNetworkPicker asset="USDT" catalogue={unset as never} networkId="" onNetwork={() => undefined} reload={() => undefined} />,
    );
    expect(host.textContent).toContain('crypto custody');
    expect(button('Try again')).toBeUndefined();
    const failed = { status: 'failed', failure: { ok: false, reason: 'unreachable', message: 'x' } };
    await act(async () =>
      root!.render(
        <DepositNetworkPicker asset="USDT" catalogue={failed as never} networkId="" onNetwork={() => undefined} reload={() => undefined} />,
      ),
    );
    expect(host.textContent).toContain('We could not load the networks');
    expect(button('Try again')).toBeDefined();
  });

  it('a pair the supported asset list does not allow is listed switched off with that reason, and no address is asked for', async () => {
    const off = (assetState: 'retired' | 'halted' | 'active' | null) => ({
      status: 'ready',
      data: {
        assets: [],
        halted: [{ assetId: 'USDT', networkId: 'tron', label: 'Tron', haltNote: null, blockedBy: 'registry', assetState }],
      },
    });
    await mount(<DepositAddressPanel asset="USDT" catalogue={off('retired') as never} networkId="tron" />);
    expect(host.textContent).toContain('Deposits of USDT on Tron are switched off');
    expect(host.querySelector('[data-testid="deposit-registry-off"]')!.textContent).toContain(
      'USDT is retired from the supported asset list',
    );
    expect(host.querySelector('a[href="/uc/assets"]')).not.toBeNull();
    // The owner's "switched back on" promise is not made for a registry closure.
    expect(host.textContent).not.toContain('credited after deposits are switched back on');
    expect(button('Show my deposit address')).toBeUndefined();
    await act(async () => root!.render(<DepositAddressPanel asset="USDT" catalogue={off('halted') as never} networkId="tron" />));
    expect(host.textContent).toContain('Deposits of USDT are paused in the supported asset list');
    await act(async () => root!.render(<DepositAddressPanel asset="USDT" catalogue={off(null) as never} networkId="tron" />));
    expect(host.textContent).toContain('The supported asset list does not take deposits of USDT on Tron');
    expect(address).not.toHaveBeenCalled();
  });

  it('an unreadable supported asset list is named in the picker, with a retry', async () => {
    const failed = { status: 'failed', failure: { ok: false, reason: 'error', message: 'x', code: 'bank.asset_registry_unavailable' } };
    await mount(
      <DepositNetworkPicker asset="USDT" catalogue={failed as never} networkId="" onNetwork={() => undefined} reload={() => undefined} />,
    );
    expect(host.textContent).toContain('The list of supported assets and networks could not be read');
    expect(host.querySelector('select')!.disabled).toBe(true);
  });
});
