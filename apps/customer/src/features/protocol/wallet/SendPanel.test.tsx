// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SendPanel } from './SendPanel';

const ME = '0x1111111111111111111111111111111111111111';
const FRIEND = '0x52908400098527886E0F7030069857D2E4169EE7';
const wallet = {
  status: 'connected',
  address: ME as string | null,
  guard: { ok: true },
  code: vi.fn(),
  sign: vi.fn(),
};
const representationStatus = vi.fn();
vi.mock('./WalletProvider', () => ({ useWallet: () => wallet }));
vi.mock('../api', () => ({ createProtocolApi: () => ({ representationStatus, representationAccept: vi.fn() }) }));
vi.mock('../../session/session', () => ({ useApi: () => ({}) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;

const field = (label: RegExp) => {
  const span = [...host.ownerDocument.querySelectorAll('label span')].find((node) => label.test(node.textContent ?? ''));
  return span?.parentElement?.querySelector('input, select') as HTMLInputElement | HTMLSelectElement;
};
const type = async (element: HTMLInputElement | HTMLSelectElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
};
const button = (name: string) =>
  [...host.ownerDocument.querySelectorAll('button')].find((node) => node.textContent?.trim() === name) as HTMLButtonElement;
const click = async (name: string) => {
  await act(async () => {
    button(name).click();
  });
};
const text = () => host.ownerDocument.body.textContent ?? '';

const fill = async (to: string, amount = '1') => {
  await type(field(/^Token$/), 'native');
  await type(field(/^Amount$/), amount);
  await type(field(/^To$/), to);
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  wallet.status = 'connected';
  wallet.address = ME;
  wallet.code.mockReset().mockResolvedValue('0x');
  wallet.sign.mockReset().mockResolvedValue({ status: 'sent', hash: `0x${'a'.repeat(64)}` });
  representationStatus.mockReset().mockResolvedValue({ ok: true, data: { accepted: true } });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mount = async (props: { to?: string; token?: string } = {}) => {
  await act(async () => {
    root.render(<SendPanel {...props} />);
  });
};

describe('Send', () => {
  it('needs the last four characters before it sends exactly the reviewed amount to the reviewed address', async () => {
    await mount();
    await fill(FRIEND, '1.5');
    await click('Review');
    expect(text()).toContain('Review the send');
    expect(button('Send').disabled).toBe(true);
    await type(field(/^Last four characters/), '0000');
    expect(button('Send').disabled).toBe(true);
    await type(field(/^Last four characters/), '9EE7');
    expect(button('Send').disabled).toBe(false);
    await click('Send');
    expect(wallet.sign).toHaveBeenCalledTimes(1);
    expect(wallet.sign).toHaveBeenCalledWith({ kind: 'transaction', to: FRIEND, value: '0x14d1120d7b160000' });
    expect(text()).toContain(`Transaction 0x${'a'.repeat(64)}`);
  });

  it('asks for a tick before sending to a contract', async () => {
    wallet.code.mockResolvedValue('0x6080');
    await mount();
    await fill(FRIEND);
    await click('Review');
    expect(text()).toContain('This address is a contract.');
    await type(field(/^Last four characters/), '9ee7');
    expect(button('Send').disabled).toBe(true);
    await act(async () => {
      host.ownerDocument.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')!.click();
    });
    expect(button('Send').disabled).toBe(false);
  });

  it('says so when the wallet cannot check for a contract, and still lets the person confirm', async () => {
    wallet.code.mockResolvedValue(null);
    await mount();
    await fill(FRIEND);
    await click('Review');
    expect(text()).toContain('Your wallet could not say whether this address is a contract.');
    await type(field(/^Last four characters/), '9ee7');
    expect(button('Send').disabled).toBe(false);
  });

  it('refuses a send to the wallet itself, an unresolved name and a bad amount, before any review', async () => {
    await mount();
    await fill(ME.toUpperCase().replace('0X', '0x'));
    await click('Review');
    expect(text()).toContain('You cannot send to your own wallet.');
    await type(field(/^To$/), 'nobody-here.test');
    expect(text()).toContain('Name not resolved');
    expect(button('Review').disabled).toBe(true);
    await type(field(/^To$/), FRIEND);
    await type(field(/^Amount$/), '0.0000000000000000001');
    await click('Review');
    expect(text()).toContain('at most 18 decimal places');
    expect(text()).not.toContain('Review the send');
    expect(wallet.code).not.toHaveBeenCalled();
    expect(wallet.sign).not.toHaveBeenCalled();
  });

  it('never fails open on the representation: refused or unread stops before the wallet is asked', async () => {
    for (const answer of [
      { ok: false, code: 'compliance.representation_unset' },
      { ok: false, code: 'internal' },
      { ok: true, data: { accepted: false, version: 'TEST-1', text: 'TEST', message: 'sign me', acceptedAt: null } },
    ]) {
      representationStatus.mockResolvedValueOnce(answer);
      await mount();
      await fill(FRIEND);
      await click('Review');
      await type(field(/^Last four characters/), '9ee7');
      await click('Send');
      expect(wallet.sign).not.toHaveBeenCalled();
      act(() => root.unmount());
      root = createRoot(host);
    }
  });

  it('does not let a token request be paid in the network currency', async () => {
    await mount({ to: FRIEND, token: '0x00000000000000000000000000000000000a11ce' });
    expect(field(/^To$/).value).toBe(FRIEND);
    expect(text()).toContain('it cannot be paid from here');
    await type(field(/^Token$/), 'native');
    await type(field(/^Amount$/), '1');
    expect(button('Review').disabled).toBe(true);
  });

  it('closes an open review when a new address is filled in', async () => {
    await mount();
    await fill(FRIEND);
    await click('Review');
    expect(text()).toContain('Review the send');
    await mount({ to: '0x0000000000000000000000000000000000c0ffee' });
    expect(text()).not.toContain('Review the send');
  });

  it('cannot review without a connected wallet', async () => {
    wallet.status = 'disconnected';
    wallet.address = null;
    await mount();
    await fill(FRIEND);
    expect(button('Review').disabled).toBe(true);
  });
});
