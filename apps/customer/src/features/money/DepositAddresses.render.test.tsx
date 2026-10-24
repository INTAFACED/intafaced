// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../session/session', () => ({ useSession: () => ({ userId: 'u1', api: {} }) }));
import { DepositAddressesView } from './DepositAddresses';
import type { DepositAddressItem, DepositAddressList, DepositNetworkView } from './deposit-reads';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
});

async function mount(node: React.ReactNode) {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(node));
}
const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === name)!;
const rowOf = (index: number) => host.querySelector(`li[data-address-index="${index}"]`)!;
const rowButton = (index: number, name: string) => [...rowOf(index).querySelectorAll('button')].find((b) => b.textContent === name)!;
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// TEST rows and a TEST clock, not published settings.
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const network: DepositNetworkView = {
  id: 'ethereum',
  label: 'TEST Ethereum',
  minimumDeposit: '10',
  confirmationsRequired: 6,
  estimatedArrivalMinutes: 5,
};
const item = (over: Partial<DepositAddressItem>): DepositAddressItem => ({
  assetId: 'USDT',
  networkId: 'ethereum',
  addressIndex: 0,
  address: '0xfirst',
  memo: null,
  qrPayload: null,
  label: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  expiresAt: null,
  state: 'active',
  ...over,
});
const ready = (data: Partial<DepositAddressList>) => ({
  status: 'ready' as const,
  data: {
    items: [
      item({}),
      item({ addressIndex: 1, address: '0xsavings', label: 'Savings', expiresAt: '2026-11-23T12:00:00.000Z' }),
      item({ addressIndex: 2, address: '0xold', expiresAt: '2026-10-20T12:00:00.000Z', state: 'expired' }),
    ],
    cap: 3,
    expiryDays: 30,
    ...data,
  },
});
const never = () => new Promise<never>(() => undefined);

describe('DepositAddressesView', () => {
  it('lists each address with its name and expiry, an expired one held for release, and the open count against the cap', async () => {
    await mount(
      <DepositAddressesView
        network={network}
        list={ready({})}
        reload={() => undefined}
        actions={{ create: never, rename: never }}
        now={NOW}
      />,
    );
    expect(host.querySelector('h4')!.textContent).toBe('Your addresses on TEST Ethereum');
    expect(rowOf(0).textContent).toContain('First address');
    expect(rowOf(0).textContent).toContain('Does not expire');
    expect(rowOf(1).textContent).toContain('Savings');
    expect(rowOf(1).textContent).toContain('Address 1');
    expect(rowOf(1).textContent).toContain('30 days left');
    expect(rowOf(2).getAttribute('data-state')).toBe('expired');
    expect(rowOf(2).textContent).toContain('Money sent to it now is held for release.');
    expect(host.querySelector('[data-testid="deposit-addresses-cap"]')!.textContent).toBe(
      'Open addresses here: 2 of 3 A new address lasts 30 days.',
    );
  });

  it('names an unset cap or expiry window instead of a number', async () => {
    await mount(
      <DepositAddressesView
        network={network}
        list={ready({ cap: null, expiryDays: null })}
        reload={() => undefined}
        actions={{ create: never, rename: never }}
        now={NOW}
      />,
    );
    expect(host.querySelector('[data-testid="deposit-addresses-cap"]')!.textContent).toContain('have not set how many addresses');
  });

  it('makes an address with its name and reloads; a refusal at the cap names the cap', async () => {
    const reload = vi.fn();
    const create = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: item({ addressIndex: 3, label: 'Payroll', expiresAt: '2026-11-23T12:00:00.000Z' }) })
      .mockResolvedValueOnce({ ok: false, code: 'bank.deposit_address_cap_reached' });
    await mount(<DepositAddressesView network={network} list={ready({})} reload={reload} actions={{ create, rename: never }} now={NOW} />);
    await type(host.querySelector('section > label input') as HTMLInputElement, ' Payroll ');
    await act(async () => button('Add another address').click());
    expect(create).toHaveBeenCalledWith('Payroll');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Address 3 is ready.');
    await act(async () => button('Add another address').click());
    expect(create).toHaveBeenLastCalledWith(null);
    expect(host.querySelector('[role="alert"]')!.textContent).toBe(
      'You already hold 3 open addresses here, the most allowed. One frees up when an address expires.',
    );
  });

  it('shows an extra address’s memo with its own copy, and starts each rename from the saved name', async () => {
    await mount(
      <DepositAddressesView
        network={network}
        list={ready({
          items: [item({}), item({ addressIndex: 1, label: 'Savings', memo: 'TEST-MEMO-7', expiresAt: '2026-11-23T12:00:00.000Z' })],
        })}
        reload={() => undefined}
        actions={{ create: never, rename: never }}
        now={NOW}
      />,
    );
    expect(rowOf(1).querySelector('[role="note"]')!.textContent).toContain('TEST-MEMO-7');
    expect(rowOf(0).querySelector('[role="note"]')).toBeNull();
    await act(async () => rowButton(1, 'Rename').click());
    await type(rowOf(1).querySelector('input') as HTMLInputElement, 'Abandoned');
    await act(async () => button('Cancel').click());
    await act(async () => rowButton(1, 'Rename').click());
    expect((rowOf(1).querySelector('input') as HTMLInputElement).value).toBe('Savings');
  });

  it('renames an address, or clears the name with an empty field', async () => {
    const reload = vi.fn();
    const rename = vi.fn().mockResolvedValue({ ok: true, data: item({}) });
    await mount(<DepositAddressesView network={network} list={ready({})} reload={reload} actions={{ create: never, rename }} now={NOW} />);
    await act(async () => rowButton(1, 'Rename').click());
    await type(rowOf(1).querySelector('input') as HTMLInputElement, '');
    await act(async () => button('Save name').click());
    expect(rename).toHaveBeenCalledWith(1, null);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('says so when the list cannot be read, with a retry', async () => {
    const reload = vi.fn();
    await mount(
      <DepositAddressesView
        network={network}
        list={{ status: 'failed', failure: { ok: false, reason: 'http', code: 'bank.deposit_custody_unset', message: 'x' } as never }}
        reload={reload}
        actions={{ create: never, rename: never }}
      />,
    );
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('Your addresses could not be loaded.');
    await act(async () => button('Try again').click());
    expect(reload).toHaveBeenCalled();
  });
});
