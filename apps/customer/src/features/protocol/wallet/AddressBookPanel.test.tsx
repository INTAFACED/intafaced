// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADDR = '0x1111111111111111111111111111111111111111';
const FRIEND = '0x52908400098527886E0F7030069857D2E4169EE7';
const later = new Date(Date.now() + 3_600_000).toISOString();
const now = new Date().toISOString();
const procedures: string[] = [];
const contacts: Array<{ id: string; address: string; label: string; createdAt: string; updatedAt: string }> = [];
const transport = {
  canWrite: () => true,
  query: () => new Promise(() => undefined),
  mutate: async (_module: string, procedure: string, input: Record<string, unknown>) => {
    procedures.push(procedure);
    if (procedure === 'walletSession.challenge') return { ok: true, data: { message: 'sign in', challenge: 'c', expiresAt: later } };
    if (procedure === 'walletSession.open') return { ok: true, data: { session: 's', address: ADDR, expiresAt: later } };
    if (procedure === 'addressBook.list') return { ok: true, data: { owner: ADDR, contacts: [...contacts], groups: [] } };
    if (procedure === 'addressBook.addContact') {
      if (contacts.some((c) => c.address === input.address))
        return { ok: false, reason: 'error', message: 'protocol.contact_duplicate: prose', code: 'protocol.contact_duplicate' };
      const row = {
        id: '00000000-0000-4000-8000-000000000001',
        address: String(input.address),
        label: String(input.label),
        createdAt: now,
        updatedAt: now,
      };
      contacts.push(row);
      return { ok: true, data: row };
    }
    throw new Error(`unexpected ${procedure}`);
  },
};
vi.mock('../../session/session', async (original) => {
  const real = await original<typeof import('../../session/session')>();
  return { ...real, useApi: () => transport as never };
});
import { resetWalletSessions } from './address-book-api';
import { AddressBookPanel } from './AddressBookPanel';
import type { DiscoveredWallet } from './eip1193';
import { SendPanel } from './SendPanel';
import { useWallet, WalletProvider, type WalletApi } from './WalletProvider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root, api: WalletApi;
const asked: string[] = [];
const wallet: DiscoveredWallet = {
  info: { uuid: 'u1', name: 'Test Wallet', icon: '', rdns: 'test.wallet' },
  provider: {
    request: async ({ method }) => {
      asked.push(method);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ADDR];
      if (method === 'eth_chainId') return '0x14a34';
      if (method === 'personal_sign') return `0x${'ab'.repeat(65)}`;
      throw new Error(`unexpected ${method}`);
    },
  },
};
function Probe() {
  api = useWallet();
  return null;
}
async function mount(panel: 'book' | 'send') {
  await act(async () => {
    root.render(
      <WalletProvider discovery={false}>
        <Probe />
      </WalletProvider>,
    );
  });
  await act(async () => api.connect(wallet));
  await act(async () => {
    root.render(
      <WalletProvider discovery={false}>
        <Probe />
        {panel === 'book' ? <AddressBookPanel /> : <SendPanel />}
      </WalletProvider>,
    );
  });
}
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
const input = (label: string) =>
  [...host.querySelectorAll('label.field')].find((l) => l.querySelector('span')?.textContent === label)!.querySelector('input')!;
function type(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  procedures.length = 0;
  asked.length = 0;
  contacts.length = 0;
  resetWalletSessions();
  sessionStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('address book section', () => {
  it('opens the book with one signature, reads it once, and saves a contact into the Contacts table', async () => {
    await mount('book');
    await settle();
    await settle();
    expect(asked.filter((m) => m === 'personal_sign')).toHaveLength(1);
    expect(procedures.filter((p) => p === 'addressBook.list')).toHaveLength(1);
    expect(host.querySelector('[role="region"][aria-label="Contacts"]')?.textContent).toContain('No contacts');

    await act(async () => {
      type(input('Label'), 'TEST friend');
      type(input('Address'), FRIEND);
    });
    await act(async () => host.querySelector<HTMLFormElement>('form[aria-label="Add a contact"]')!.requestSubmit());
    await settle();
    expect(host.querySelector('[role="region"][aria-label="Contacts"]')?.textContent).toContain('TEST friend');
    expect(asked.filter((m) => m === 'personal_sign')).toHaveLength(1);

    await act(async () => {
      type(input('Label'), 'Again');
      type(input('Address'), FRIEND);
    });
    await act(async () => host.querySelector<HTMLFormElement>('form[aria-label="Add a contact"]')!.requestSubmit());
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('This address is already in your address book.');
  });

  it('refuses a malformed address before asking anything', async () => {
    await mount('book');
    await settle();
    const before = procedures.length;
    await act(async () => {
      type(input('Label'), 'TEST');
      type(input('Address'), 'nobody.test');
    });
    await act(async () => host.querySelector<HTMLFormElement>('form[aria-label="Add a contact"]')!.requestSubmit());
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/not a wallet address/);
    expect(procedures.length).toBe(before);
  });

  it('opening Send asks the wallet for no signature and the address book service for nothing', async () => {
    await mount('send');
    await settle();
    expect(asked).not.toContain('personal_sign');
    expect(procedures).toEqual([]);
  });
});
