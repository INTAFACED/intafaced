// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Destination, WithdrawAsset } from './contracts';

/**
 * J-wallet-04 #2 and #4 on the screen: a mistyped address is refused with its reason before any call or any code is
 * asked for; a good one asks for a fresh confirmation and sends exactly that entry with the one-use token as its bearer;
 * Remove asks for the same confirmation and sends a business key, so a retry is the same removal. J-wallet-04 #3: the
 * bank's check runs before any code is asked for; a changed character is refused at the field, and a look-alike of a
 * saved address shows a warning that must be ticked before the save, which then says the customer checked it.
 */

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
const mutate = vi.fn();
const query = vi.fn();
vi.mock('../session/session', () => ({ useSession: () => ({ userId: 'u1', api: { mutate, query } }) }));
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
  query.mockReset();
  query.mockResolvedValue({ ok: true, data: { address: 'ok', lookalike: null } });
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

describe('checking the address before the confirmation (W-withdraw-03)', () => {
  const LOOKALIKE = `0x5290${'1'.repeat(32)}9EE7`;
  const tick = () => document.querySelector('[data-testid="address-lookalike"] input[type="checkbox"]') as HTMLInputElement;

  it('asks the bank about the address first, and refuses a changed character at the field without asking for a code', async () => {
    query.mockResolvedValue({ ok: true, data: { address: 'checksum_mismatch', lookalike: null } });
    await mount();
    await type('Label', 'Cold wallet');
    await type('Asset', 'USDT');
    await type('Address', GOOD.replace('E0F7', 'e0F7'));
    await submit(addForm());
    expect(query.mock.calls[0]!.slice(0, 3)).toEqual([
      'bank',
      'ramps.destinations.check',
      { ref: GOOD.replace('E0F7', 'e0F7'), network: 'base' },
    ]);
    expect(document.body.textContent).toContain('a character may have been changed');
    expect(document.querySelector('input[name="withdraw-stepup-code"]')).toBeNull();
    expect(mint).not.toHaveBeenCalled();
  });

  it('warns about a look-alike of a saved address, waits for the tick, then saves saying the customer checked it', async () => {
    query.mockResolvedValue({
      ok: true,
      data: {
        address: 'ok',
        lookalike: { destinationId: '11111111-1111-4111-8111-111111111111', label: 'Old wallet', refMasked: '0x5290…9EE7' },
      },
    });
    mint.mockResolvedValue({ ok: true, data: { accessToken: 'one-use', expiresAt: '2026-10-23T01:10:00Z' } });
    mutate.mockResolvedValue({ ok: true, data: {} });
    await mount();
    await type('Label', 'New wallet');
    await type('Asset', 'USDT');
    await type('Address', LOOKALIKE);
    await submit(addForm());
    expect(document.querySelector('[data-testid="address-lookalike"]')!.textContent).toContain(
      'It starts and ends like your saved address Old wallet (0x5290…9EE7) but is a different address',
    );
    expect(document.querySelector('input[name="withdraw-stepup-code"]')).toBeNull();
    await submit(addForm());
    expect(document.body.textContent).toContain('Tick the box once you have checked the address');
    expect(document.querySelector('input[name="withdraw-stepup-code"]')).toBeNull();
    await act(async () => tick().click());
    await submit(addForm());
    expect(query).toHaveBeenCalledTimes(1);
    await confirmWithCode();
    expect(mutate.mock.calls[0]![2]).toEqual({
      assetId: 'USDT',
      network: 'base',
      ref: LOOKALIKE,
      label: 'New wallet',
      confirmLookalike: true,
    });
  });

  it('drops the warning and the tick when the address changes, and checks the new one', async () => {
    query.mockResolvedValueOnce({
      ok: true,
      data: { address: 'ok', lookalike: { destinationId: '11111111-1111-4111-8111-111111111111', label: null, refMasked: '0x5290…9EE7' } },
    });
    await mount();
    await type('Label', 'New wallet');
    await type('Asset', 'USDT');
    await type('Address', LOOKALIKE);
    await submit(addForm());
    expect(document.body.textContent).toContain('It starts and ends like your saved address 0x5290…9EE7 but');
    await act(async () => tick().click());
    await type('Address', GOOD);
    expect(document.querySelector('[data-testid="address-lookalike"]')).toBeNull();
    await submit(addForm());
    expect(query).toHaveBeenCalledTimes(2);
    expect(document.querySelector('input[name="withdraw-stepup-code"]')).not.toBeNull();
  });

  it('drops a check that answers after the address changed, and checks the new address instead', async () => {
    let answerFirst: (value: unknown) => void = () => undefined;
    query.mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)));
    await mount();
    await type('Label', 'New wallet');
    await type('Asset', 'USDT');
    await type('Address', LOOKALIKE);
    await submit(addForm());
    await type('Address', GOOD);
    await act(async () => answerFirst({ ok: true, data: { address: 'ok', lookalike: null } }));
    expect(document.querySelector('input[name="withdraw-stepup-code"]')).toBeNull();
    await submit(addForm());
    expect(query.mock.calls[1]![2]).toEqual({ ref: GOOD, network: 'base' });
    expect(document.querySelector('input[name="withdraw-stepup-code"]')).not.toBeNull();
  });

  it('puts a look-alike refusal on save in the customer’s words', async () => {
    mint.mockResolvedValue({ ok: true, data: { accessToken: 'one-use', expiresAt: '2026-10-23T01:10:00Z' } });
    mutate.mockResolvedValue({ ok: false, reason: 'error', message: 'This address starts and ends like', code: 'bank.address_lookalike' });
    await mount();
    await type('Label', 'Cold wallet');
    await type('Asset', 'USDT');
    await type('Address', GOOD);
    await submit(addForm());
    await confirmWithCode();
    expect(document.body.textContent).toContain('This address looks like one you saved, so it was not saved.');
  });

  it('refuses an address on the fraud list at the form, in words, before asking for a code (J-wallet-05 #2)', async () => {
    query.mockResolvedValue({ ok: true, data: { address: 'ok', lookalike: null, fraudListed: true } });
    await mount();
    await type('Label', 'TEST fraud-listed wallet');
    await type('Asset', 'USDT');
    await type('Address', GOOD);
    await submit(addForm());
    expect(addForm().querySelector('[role="alert"]')?.textContent).toBe(
      'This address is on our fraud list, so it can’t be saved. Nothing was saved.',
    );
    expect(document.querySelector('input[name="withdraw-stepup-code"]')).toBeNull();
    expect(mint).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('drops a look-alike tick when the network changes, and checks the address again on the new network', async () => {
    query.mockResolvedValueOnce({
      ok: true,
      data: { address: 'ok', lookalike: { destinationId: '11111111-1111-4111-8111-111111111111', label: null, refMasked: '0x5290…9EE7' } },
    });
    query.mockResolvedValueOnce({ ok: true, data: { address: 'ok', lookalike: null, fraudListed: true } });
    await mount();
    await type('Label', 'New wallet');
    await type('Asset', 'USDT');
    await type('Address', GOOD);
    await submit(addForm());
    await act(async () => tick().click());
    await type('Network', 'ethereum');
    expect(document.querySelector('[data-testid="address-lookalike"]')).toBeNull();
    await submit(addForm());
    expect(query.mock.calls[1]![2]).toEqual({ ref: GOOD, network: 'ethereum' });
    expect(addForm().querySelector('[role="alert"]')?.textContent).toContain('on our fraud list');
    expect(document.querySelector('input[name="withdraw-stepup-code"]')).toBeNull();
  });

  it('puts a fraud-list refusal on save in the customer’s words', async () => {
    mint.mockResolvedValue({ ok: true, data: { accessToken: 'one-use', expiresAt: '2026-10-23T01:10:00Z' } });
    mutate.mockResolvedValue({
      ok: false,
      reason: 'error',
      message: 'This address is on the fraud list',
      code: 'bank.destination_fraud_listed',
    });
    await mount();
    await type('Label', 'Cold wallet');
    await type('Asset', 'USDT');
    await type('Address', GOOD);
    await submit(addForm());
    await confirmWithCode();
    expect(document.body.textContent).toContain('This address is on our fraud list, so it can’t be saved. Nothing was saved.');
    expect(reloads.book).toBe(0);
  });

  it.each([
    ['bank.destination_sanctions_listed', 'This address is on the sanctions list, so it can’t be saved. Nothing was saved.'],
    [
      'bank.destination_sanctions_unset',
      'No address can be saved yet: the sanctions list for withdrawal addresses isn’t set. Nothing was saved.',
    ],
  ])('puts the sanctions refusal %s on save in the customer’s words', async (code, words) => {
    mint.mockResolvedValue({ ok: true, data: { accessToken: 'one-use', expiresAt: '2026-10-23T01:10:00Z' } });
    mutate.mockResolvedValue({ ok: false, reason: 'error', message: 'The bank refused', code });
    await mount();
    await type('Label', 'Cold wallet');
    await type('Asset', 'USDT');
    await type('Address', GOOD);
    await submit(addForm());
    await confirmWithCode();
    expect(document.body.textContent).toContain(words);
    expect(reloads.book).toBe(0);
  });

  it('saves nothing and asks for no code when the check itself fails', async () => {
    query.mockResolvedValue({ ok: false, reason: 'network', message: 'offline' });
    await mount();
    await type('Label', 'Cold wallet');
    await type('Asset', 'USDT');
    await type('Address', GOOD);
    await submit(addForm());
    expect(document.body.textContent).toContain('The address could not be checked');
    expect(document.querySelector('input[name="withdraw-stepup-code"]')).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
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
