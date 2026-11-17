// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionKeysPanel, toWei, utcTime } from './SessionKeysPanel';

const ME = '0x1111111111111111111111111111111111111111';
const SMART = '0x2222222222222222222222222222222222222222';
const KEY_A = '0x000000000000000000000000000000000005E001';
const KEY_B = '0x000000000000000000000000000000000005e003';
const HASH = `0x${'c'.repeat(64)}`;
const key = (over: object) => ({
  key: KEY_A,
  targets: ['0x3333333333333333333333333333333333333333'],
  selectors: ['0x38ed1739'],
  spendLimitWei: '50000000000000000',
  spentWei: '0',
  validAfter: 0,
  validUntil: 1_800_000_000,
  status: 'active',
  grantedBlock: '10',
  lastUsedAt: null,
  ...over,
});
const list = (keys: object[], blockNumber = '40') => ({
  ok: true,
  data: { account: SMART, chainId: 84532, deployed: true, blockNumber, blockTime: '2026-11-07T08:00:00.000Z', logsFromBlock: '0', keys },
});
const wallet = { status: 'connected', address: ME as string | null, guard: { ok: true }, sendSequence: vi.fn(), read: vi.fn() };
const api = {
  predictAccount: vi.fn(),
  sessionsList: vi.fn(),
  buildSessionRevoke: vi.fn(),
  buildRevokeAllSessions: vi.fn(),
  buildSessionGrant: vi.fn(),
  representationStatus: vi.fn(),
  representationAccept: vi.fn(),
};
vi.mock('./WalletProvider', async (actual) => ({ ...(await actual<typeof import('./WalletProvider')>()), useWallet: () => wallet }));
vi.mock('../api', () => ({ createProtocolApi: () => api }));
vi.mock('../../session/session', () => ({ useApi: () => ({}) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false;
};
let host: HTMLDivElement, root: Root;
const doc = () => host.ownerDocument;
const text = () => doc().body.textContent ?? '';
const rows = () => [...host.querySelectorAll('tbody tr')].map((row) => row.textContent ?? '');
const button = (name: string) =>
  [...doc().querySelectorAll('button')].find((node) => node.textContent?.trim() === name) as HTMLButtonElement;
const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const mount = async () => {
  await act(async () => {
    root.render(<SessionKeysPanel />);
  });
  await flush();
};

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  api.predictAccount
    .mockReset()
    .mockResolvedValue({ ok: true, data: { address: SMART, chainId: 84532, factory: ME, implementation: ME, deployed: true } });
  api.sessionsList.mockReset().mockResolvedValue(list([key({}), key({ key: KEY_B, status: 'expired', validUntil: 1_700_000_000 })]));
  api.representationStatus.mockReset().mockResolvedValue({ ok: true, data: { accepted: true } });
  api.buildSessionRevoke.mockReset().mockResolvedValue({ ok: true, data: { to: SMART, data: '0xdeadbeef', value: '0', summary: 's' } });
  api.buildRevokeAllSessions.mockReset().mockResolvedValue({ ok: true, data: { to: SMART, data: '0xfeedface', value: '0', summary: 's' } });
  api.buildSessionGrant.mockReset();
  wallet.sendSequence.mockReset().mockResolvedValue({ status: 'sent', hashes: [HASH] });
  wallet.read.mockReset().mockResolvedValue({ status: '0x1', blockNumber: '0x29' });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('Session keys (D-portfolio-wallet-02)', () => {
  it('lists each key with scope, cap, expiry, last use and status, and says a key can never move tokens', async () => {
    await mount();
    expect(api.sessionsList).toHaveBeenCalledWith(SMART, expect.anything());
    const [active, expired] = rows();
    expect(active).toContain('Calls 0x38ed1739 on');
    expect(active).toContain('0.05 ETH, 0 used');
    expect(active).toContain(utcTime(new Date(1_800_000_000 * 1000).toISOString()));
    expect(active).toContain('Never');
    expect(active).toContain('Active');
    expect(expired).toContain('Expired');
    expect(expired).not.toContain('Revoke');
    expect(text()).toContain('A session key can never move tokens out of your account');
  });

  it('a revoke is built, sent by the wallet, and reads Revoking until the chain shows it revoked', async () => {
    await mount();
    await act(async () => button('Revoke').click());
    await flush();
    expect(api.buildSessionRevoke).toHaveBeenCalledWith({ account: SMART, sessionKey: KEY_A });
    expect(wallet.sendSequence.mock.calls[0]![0].steps[0].request).toEqual({ kind: 'transaction', to: SMART, data: '0xdeadbeef' });
    api.sessionsList.mockResolvedValue(list([key({ status: 'revoked' })], '41'));
    await flush(1_000);
    expect(rows()[0]).toContain('Revoked');
  });

  it('Revoke all is one call', async () => {
    await mount();
    await act(async () => button('Revoke all').click());
    await flush();
    expect(api.buildRevokeAllSessions).toHaveBeenCalledWith({ account: SMART });
    expect(wallet.sendSequence).toHaveBeenCalledTimes(1);
    expect(wallet.sendSequence.mock.calls[0]![0].steps).toHaveLength(1);
  });

  it('a scope with withdrawal power is refused before anything is signed', async () => {
    api.buildSessionGrant.mockResolvedValue({
      ok: false,
      reason: 'refused',
      message: 'A session key may never be granted "transfer(address,uint256)" (0xa9059cbb).',
    });
    await mount();
    await act(async () => button('New session key').click());
    const set = async (label: string, value: string) => {
      const field = [...doc().querySelectorAll('label')].find((node) => node.textContent?.startsWith(label))!;
      const input = field.querySelector('input') ?? doc().getElementById(field.htmlFor)!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    await set('Session key address', '0x000000000000000000000000000000000005e0ff');
    await set('Contract it may call', '0x00000000000000000000000000000000000a11ce');
    await set('Functions it may call', '0xa9059cbb');
    await act(async () => {
      doc()
        .querySelector('dialog form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(api.buildSessionGrant).toHaveBeenCalledTimes(1);
    expect(api.representationStatus).not.toHaveBeenCalled();
    expect(wallet.sendSequence).not.toHaveBeenCalled();
    expect(doc().querySelector('dialog [role="alert"]')?.textContent).toContain(
      'a session key can never call a function that moves tokens',
    );
  });

  it('converts a cap to wei exactly and refuses anything that is not a plain number', () => {
    expect(toWei('0.05')).toBe('50000000000000000');
    expect(toWei('1')).toBe('1000000000000000000');
    expect(toWei('1e18')).toBeNull();
    expect(toWei('0.0000000000000000001')).toBeNull();
  });

  it('with the factory not deployed, says session keys need it', async () => {
    api.predictAccount.mockResolvedValue({
      ok: false,
      reason: 'refused',
      message: 'Smart account factory/implementation is not configured',
    });
    await mount();
    expect(text()).toContain('the smart account factory is not deployed on this network');
  });
});
