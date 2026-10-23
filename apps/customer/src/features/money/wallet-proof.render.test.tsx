// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Destination, WithdrawAsset } from './contracts';

/**
 * J-wallet-04 #6 on the screen (W-withdraw-17): Prove ownership asks the bank for a message once, shows it to copy and
 * sign, sends the pasted signature for that proof, and says the result in the customer's words: a different wallet, a
 * lapsed message and an unset owner window each refuse, and a verified proof reloads the book. No confirmation code is
 * asked for, because proving a wallet cannot change where money goes.
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

const WALLET = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const ROW: Destination = {
  destinationId: '33333333-3333-4333-8333-333333333333',
  label: 'TEST private wallet',
  kind: 'crypto',
  ref: WALLET,
  addedAt: '2026-10-23T00:00:00.000Z',
  coolingOffEndsAt: '2026-10-24T00:00:00.000Z',
  coolingBlocker: null,
  assetId: 'USDT',
  network: 'ethereum',
  tag: null,
  state: 'active',
  origin: 'customer',
  ownership: { state: 'none', verifiedAt: null, validUntil: null, offerExpiresAt: null },
};
const OFFER = {
  proofId: '44444444-4444-4444-8444-444444444444',
  destinationId: ROW.destinationId,
  message: `INTAFACED wallet ownership proof\nAddress: ${WALLET}`,
  expiresAt: '2026-10-23T10:30:00.000Z',
};
const SIGNATURE = `0x${'ab'.repeat(65)}`;

function button(text: string) {
  return [...document.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined;
}
async function click(text: string) {
  await act(async () => button(text)!.click());
}
async function paste(value: string) {
  const area = document.querySelector('[data-testid="wallet-proof"] textarea:not([readonly])') as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const proofForm = () => document.querySelector('[data-testid="wallet-proof"] form') as HTMLFormElement;

describe('proving a saved wallet', () => {
  it('asks for the message once, shows it, sends the signature for that proof, and reloads the book when proved', async () => {
    rows = [ROW];
    mutate.mockResolvedValueOnce({ ok: true, data: OFFER }).mockResolvedValueOnce({
      ok: true,
      data: {
        proofId: OFFER.proofId,
        destinationId: ROW.destinationId,
        state: 'verified',
        verifiedAt: '2026-10-23T10:01:00.000Z',
        validUntil: '2027-04-21T10:01:00.000Z',
      },
    });
    await mount();
    await click('Prove ownership');
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]!.slice(0, 3)).toEqual(['bank', 'ramps.destinations.ownership.start', { destinationId: ROW.destinationId }]);
    expect((document.querySelector('[data-testid="wallet-proof-message"]') as HTMLTextAreaElement).value).toBe(OFFER.message);
    expect(document.body.textContent).toContain('Signing moves no funds');
    await paste(` ${SIGNATURE} `);
    await submit(proofForm());
    expect(mutate).toHaveBeenCalledTimes(2);
    const [module, procedure, input, , options] = mutate.mock.calls[1]!;
    expect([module, procedure, input]).toEqual([
      'bank',
      'ramps.destinations.ownership.verify',
      { proofId: OFFER.proofId, signature: SIGNATURE },
    ]);
    expect(options).toBeUndefined();
    expect(document.body.textContent).toContain('Ownership proved. It holds until');
    expect(document.body.textContent).toContain('Withdrawals do not check this proof yet.');
    expect(reloads.book).toBe(1);
    expect(mint).not.toHaveBeenCalled();
  });

  it('says a different wallet signed, keeps the message, and lets the right signature through', async () => {
    rows = [ROW];
    mutate
      .mockResolvedValueOnce({ ok: true, data: OFFER })
      .mockResolvedValueOnce({ ok: false, code: 'bank.wallet_proof_wrong_signer', message: 'signed by another address' })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          proofId: OFFER.proofId,
          destinationId: ROW.destinationId,
          state: 'verified',
          verifiedAt: 'x',
          validUntil: '2027-04-21T10:01:00.000Z',
        },
      });
    await mount();
    await click('Prove ownership');
    await paste(SIGNATURE);
    await submit(proofForm());
    expect(document.querySelector('[data-testid="wallet-proof"] [role="alert"]')?.textContent).toBe(
      'This was signed by a different wallet. Sign the message with the wallet that holds 0xf39f…2266.',
    );
    expect(document.querySelector('[data-testid="wallet-proof-message"]')).not.toBeNull();
    await submit(proofForm());
    expect(mutate).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).toContain('Ownership proved.');
  });

  it('on a lapsed message, drops the form and asks for a new message with Start again', async () => {
    rows = [ROW];
    const fresh = { ...OFFER, proofId: '88888888-8888-4888-8888-888888888888', message: 'new message' };
    mutate
      .mockResolvedValueOnce({ ok: true, data: OFFER })
      .mockResolvedValueOnce({ ok: false, code: 'bank.wallet_proof_expired', message: 'x' })
      .mockResolvedValueOnce({ ok: true, data: fresh });
    await mount();
    await click('Prove ownership');
    await paste(SIGNATURE);
    await submit(proofForm());
    expect(document.body.textContent).toContain('This message expired before it was signed. Start again for a new one.');
    expect(proofForm()).toBeNull();
    await click('Start again');
    expect(mutate.mock.calls[2]!.slice(0, 3)).toEqual(['bank', 'ramps.destinations.ownership.start', { destinationId: ROW.destinationId }]);
    expect((document.querySelector('[data-testid="wallet-proof-message"]') as HTMLTextAreaElement).value).toBe('new message');
    expect(document.querySelector('[data-testid="wallet-proof"] [role="alert"]')).toBeNull();
  });

  it.each([
    ['bank.wallet_proof_signature_invalid', 'That is not a signature of this message.'],
  ])('refuses %s in plain words', async (code, words) => {
    rows = [ROW];
    mutate.mockResolvedValueOnce({ ok: true, data: OFFER }).mockResolvedValueOnce({ ok: false, code, message: 'x' });
    await mount();
    await click('Prove ownership');
    await paste(SIGNATURE);
    await submit(proofForm());
    expect(document.body.textContent).toContain(words);
    expect(reloads.book).toBe(0);
  });

  it('says proofs are not open while the owner window is unset, and shows no message', async () => {
    rows = [ROW];
    mutate.mockResolvedValueOnce({ ok: false, code: 'bank.wallet_proof_window_unset', message: 'x' });
    await mount();
    await click('Prove ownership');
    expect(document.body.textContent).toContain('Wallet proofs are not open yet');
    expect(document.querySelector('[data-testid="wallet-proof-message"]')).toBeNull();
  });

  it('shows the proof state on the row, and offers no proof for a proved wallet or a bank account', async () => {
    rows = [
      {
        ...ROW,
        ownership: {
          state: 'verified',
          verifiedAt: '2026-10-23T10:01:00.000Z',
          validUntil: '2027-04-21T10:01:00.000Z',
          offerExpiresAt: null,
        },
      },
      {
        ...ROW,
        destinationId: '55555555-5555-4555-8555-555555555555',
        label: 'TEST waiting',
        ownership: { state: 'pending', verifiedAt: null, validUntil: null, offerExpiresAt: OFFER.expiresAt },
      },
      { ...ROW, destinationId: '66666666-6666-4666-8666-666666666666', label: 'TEST bank', kind: 'bank', ref: 'DE89370400440532013000' },
      { ...ROW, destinationId: '99999999-9999-4999-8999-999999999999', label: 'TEST legacy', origin: 'legacy' },
    ];
    await mount();
    const notes = [...document.querySelectorAll('[data-testid="address-ownership"]')].map((n) => n.textContent);
    expect(notes[0]).toMatch(/^Ownership proved · until /);
    expect(notes[1]).toBe('Ownership proof waiting for a signature');
    expect([...document.querySelectorAll('button')].filter((b) => b.textContent === 'Prove ownership')).toHaveLength(1);
  });
});
