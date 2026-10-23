// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Destination, WithdrawAsset } from './contracts';

/**
 * J-wallet-04 #2 and #4 on the screen: a mistyped address is refused with its reason before any call or any code is
 * asked for; a good one asks for a fresh confirmation and sends exactly that entry with the one-use token as its bearer;
 * Remove asks for the same confirmation and sends a business key, so a retry is the same removal.
 */

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
const mutate = vi.fn();
vi.mock('../session/session', () => ({ useSession: () => ({ userId: 'u1', api: { mutate } }) }));
const mint = vi.fn();
vi.mock('./withdraw-step-up', async (original) => ({
  ...(await original<typeof import('./withdraw-step-up')>()),
  mintWithdrawToken: (...args: unknown[]) => mint(...args),
}));
const reloads = { book: 0 };
let rows: Destination[] = [];
const ASSETS: WithdrawAsset[] = [
  {
    assetId: 'USDT',
    precision: 6,
    networks: [
      { networkId: 'ethereum', label: 'TEST Ethereum' },
      { networkId: 'base', label: 'TEST Base' },
    ],
    defaultNetworkId: 'base',
  },
];
vi.mock('./components', async (original) => {
  const real = await original<typeof import('./components')>();
  return {
    ...real,
    useBankRead: (procedure: string) =>
      procedure === 'ramps.destinations.networks'
        ? { resource: { status: 'ready', data: ASSETS }, reload: () => undefined }
        : { resource: { status: 'ready', data: rows }, reload: () => void (reloads.book += 1) },
  };
});
import { WithdrawalAddresses } from './WithdrawalAddresses';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const GOOD = '0x52908400098527886E0F7030069857D2E4169EE7';
let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(async () => {
  mutate.mockReset();
  mint.mockReset();
  reloads.book = 0;
  rows = [];
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
});

async function mount() {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<WithdrawalAddresses />));
}
function field(label: string): HTMLInputElement | HTMLSelectElement {
  const found = [...document.querySelectorAll('label.field')].find((l) => l.querySelector('span')?.textContent === label);
  return found!.querySelector('input, select') as HTMLInputElement | HTMLSelectElement;
}
async function type(label: string, value: string) {
  const input = field(label);
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
async function submit(form: HTMLFormElement) {
  await act(async () => void form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}
async function confirmWithCode() {
  const code = document.querySelector('input[name="withdraw-stepup-code"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(code, '123456');
    code.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await submit(code.closest('form')!);
}
const addForm = () => document.querySelector('form[aria-label="Add an address"]') as HTMLFormElement;

describe('saving a withdrawal address', () => {
  it('refuses a mistyped address with its reason, before any call and before asking for a code', async () => {
    await mount();
    await type('Label', 'Cold wallet');
    await type('Asset', 'USDT');
    await type('Address', '0x1234');
    await submit(addForm());
    expect(document.body.textContent).toContain('This is not a valid address');
    expect(document.querySelector('input[name="withdraw-stepup-code"]')).toBeNull();
    expect(mint).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('picks the asset’s default network, asks for a confirmation, and saves exactly that entry with the one-use token', async () => {
    mint.mockResolvedValue({ ok: true, data: { accessToken: 'one-use', expiresAt: '2026-10-23T01:10:00Z' } });
    mutate.mockResolvedValue({ ok: true, data: {} });
    await mount();
    await type('Label', ' Cold wallet ');
    await type('Asset', 'USDT');
    expect((field('Network') as HTMLSelectElement).value).toBe('base');
    await type('Address', GOOD);
    await submit(addForm());
    expect(mutate).not.toHaveBeenCalled();
    await confirmWithCode();
    expect(mutate).toHaveBeenCalledTimes(1);
    const [module, procedure, input, , options] = mutate.mock.calls[0]!;
    expect([module, procedure]).toEqual(['bank', 'ramps.destinations.save']);
    expect(input).toEqual({ assetId: 'USDT', network: 'base', ref: GOOD, label: 'Cold wallet' });
    expect(options).toEqual({ bearer: 'one-use' });
    expect(document.body.textContent).toContain('Cold wallet was saved to your address book.');
    expect(reloads.book).toBe(1);
  });

  it('keeps the confirmation open with the bank’s words when the bank refuses the entry', async () => {
    mint.mockResolvedValue({ ok: true, data: { accessToken: 'one-use', expiresAt: '2026-10-23T01:10:00Z' } });
    mutate.mockResolvedValue({
      ok: false,
      reason: 'error',
      message: 'You already have a saved address with this name',
      code: 'bank.destination_label_taken',
    });
    await mount();
    await type('Label', 'Cold wallet');
    await type('Asset', 'USDT');
    await type('Address', GOOD);
    await submit(addForm());
    await confirmWithCode();
    expect(document.body.textContent).toContain('You already have a saved address with this name');
    expect(document.querySelector('input[name="withdraw-stepup-code"]')).not.toBeNull();
    expect(reloads.book).toBe(0);
  });
});

describe('removing a withdrawal address', () => {
  it('asks for a confirmation and removes with a business key, so a retry is the same removal', async () => {
    rows = [
      {
        destinationId: '11111111-1111-4111-8111-111111111111',
        label: 'Old wallet',
        kind: 'crypto',
        ref: GOOD,
        addedAt: '2026-10-17T10:00:00Z',
        coolingOffEndsAt: '2026-10-19T10:00:00Z',
        coolingBlocker: null,
        state: 'active',
      },
    ];
    mint.mockResolvedValue({ ok: true, data: { accessToken: 'one-use', expiresAt: '2026-10-23T01:10:00Z' } });
    mutate.mockResolvedValue({ ok: true, data: { destinationId: rows[0]!.destinationId, removed: true } });
    await mount();
    const remove = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!;
    await act(async () => remove.click());
    expect(mutate).not.toHaveBeenCalled();
    await confirmWithCode();
    const [, procedure, input, , options] = mutate.mock.calls[0]!;
    expect(procedure).toBe('ramps.destinations.remove');
    expect(input).toEqual({
      destinationId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: 'destination-remove:11111111-1111-4111-8111-111111111111',
    });
    expect(options).toEqual({ bearer: 'one-use' });
    expect(document.body.textContent).toContain('Old wallet was removed from your address book.');
    expect(reloads.book).toBe(1);
  });
});
