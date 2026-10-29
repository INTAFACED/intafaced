// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenPageData } from '@intafaced/contracts/protocol-tokens';
import { QuickTicket } from './QuickTicket';
import { tokensCopy } from './copy';

const ME = '0x1111111111111111111111111111111111111111';
const POOL = '0x2222222222222222222222222222222222222222';
const A = { address: '0x00000000000000000000000000000000000a11ce', name: 'TEST Token A', symbol: 'TESTA', decimals: 6 };
const B = { address: '0x00000000000000000000000000000000000b0b00', name: 'TEST Token B', symbol: 'TESTB', decimals: 18 };
const HASH = `0x${'a'.repeat(64)}`;
const word = (units: bigint) => `0x${units.toString(16).padStart(64, '0')}`;

const wallet = {
  status: 'connected' as 'connected' | 'disconnected',
  address: ME as string | null,
  guard: { ok: true } as { ok: boolean },
  wallets: [] as unknown[],
  problem: null as string | null,
  call: vi.fn(),
  read: vi.fn(),
  sendSequence: vi.fn(),
  connect: vi.fn(),
  switchNetwork: vi.fn(),
};
vi.mock('../wallet/WalletProvider', () => ({ useWallet: () => wallet }));
vi.mock('../wallet/RepresentationPanel', () => ({ RepresentationPanel: () => <div data-panel="representation" /> }));
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

const api = {
  swapSettings: vi.fn(),
  poolQuote: vi.fn(),
  checkApproval: vi.fn(),
  buildSwap: vi.fn(),
  representationStatus: vi.fn(),
};
const data = {
  token: A,
  pairs: [{ pool: POOL, other: B, feeBps: 30, reserve: '1000000000', reserveOther: '1000000000000000000000', volume: '0', candles: [] }],
} as unknown as TokenPageData;
const { t } = tokensCopy.forLocale('en');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const button = (name: string) =>
  [...host.ownerDocument.querySelectorAll('button')].find((node) => node.textContent?.trim() === name) as HTMLButtonElement;
const click = async (name: string) => {
  await act(async () => {
    button(name).click();
  });
};
const text = () => host.textContent ?? '';
const alert = () => host.querySelector('[role="alert"]')?.textContent ?? null;
const amount = () => host.querySelector('input') as HTMLInputElement;
const mount = async () => {
  await act(async () => {
    root.render(<QuickTicket data={data} api={api as never} t={t} />);
  });
};
const review = async () => {
  await click('50%');
  await act(async () => {
    host.querySelector('form')!.requestSubmit();
  });
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  Object.assign(wallet, { status: 'connected', address: ME, guard: { ok: true }, problem: null });
  wallet.call.mockReset().mockResolvedValue(word(10_000n * 10n ** 18n));
  wallet.read.mockReset().mockResolvedValue(null);
  wallet.sendSequence.mockReset().mockResolvedValue({ status: 'sent', hashes: [HASH] });
  api.swapSettings.mockReset().mockResolvedValue({ ok: true, data: { slippageCeilingBps: 100, quoteTtlSeconds: 30, confirmations: 1 } });
  api.poolQuote.mockReset().mockResolvedValue({ ok: true, data: { amountOut: '4000000', priceImpactBps: 10 } });
  api.checkApproval.mockReset().mockResolvedValue({ ok: true, data: { calls: [{ to: B.address, data: '0x01' }], resetFirst: false } });
  api.buildSwap.mockReset().mockResolvedValue({ ok: true, data: { to: POOL, data: '0x02' } });
  api.representationStatus.mockReset().mockResolvedValue({ ok: true, data: { accepted: true } });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('Quick ticket', () => {
  it('fills exactly half the balance and sends one approve then the swap at the minimum from a fresh read', async () => {
    await mount();
    await click('50%');
    expect(amount().value).toBe('5000');
    expect(host.querySelector('[data-testid="quick-quote"]')?.textContent).toBe('You receive about 4 TESTA, and at least 3.96 TESTA.');
    await act(async () => host.querySelector('form')!.requestSubmit());
    expect(amount().value).toBe('');
    expect(api.poolQuote).toHaveBeenLastCalledWith({ pool: POOL, tokenIn: B.address, amountIn: (5_000n * 10n ** 18n).toString() });
    expect(api.buildSwap).toHaveBeenCalledWith({
      pool: POOL,
      tokenIn: B.address,
      amountIn: (5_000n * 10n ** 18n).toString(),
      minAmountOut: '3960000',
      to: ME,
    });
    const sequence = wallet.sendSequence.mock.calls[0]![0];
    expect(sequence.title).toBe('Swap steps');
    expect(sequence.steps.map((step: { label: string }) => step.label)).toEqual([
      'Approve exactly 5000 TEST Token B',
      'Swap 5000 TEST Token B for at least 3.96 TEST Token A',
    ]);
    expect(text()).toContain(`Sent: ${HASH}`);
    expect(button('Review').disabled).toBe(true);
  });

  it('offers no trade above the balance and refuses an unread balance with a way to read it again', async () => {
    await mount();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(amount(), '10000.1');
      amount().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(text()).toContain(t('quickOverBalance'));
    expect(button('Review').disabled).toBe(true);
    wallet.call.mockResolvedValue(null);
    await click('Sell TESTA');
    expect(text()).toContain(t('quickBalanceUnread'));
    wallet.call.mockResolvedValue(word(2_000_000n));
    await click(t('quickReadAgain'));
    expect(host.querySelector('[data-testid="quick-balance"]')?.getAttribute('data-units')).toBe('2000000');
  });

  it('never signs when the representation gate cannot be read, and opens the representation when it is not accepted', async () => {
    api.representationStatus.mockResolvedValue({ ok: false, code: 'compliance.representation_unset' });
    await mount();
    await review();
    expect(alert()).toContain('not published');
    expect(wallet.sendSequence).not.toHaveBeenCalled();
    api.representationStatus.mockResolvedValue({ ok: false, code: 'edge.geo_blocked' });
    await review();
    expect(alert()).toContain('not available in your region');
    api.representationStatus.mockResolvedValue({ ok: true, data: { accepted: false } });
    await review();
    expect(host.querySelector('[data-panel="representation"]')).not.toBeNull();
    expect(wallet.sendSequence).not.toHaveBeenCalled();
  });

  it('sends nothing when the fresh quote, the allowance or the build is refused', async () => {
    await mount();
    await click('50%');
    api.poolQuote.mockResolvedValueOnce({ ok: false, code: 'protocol.pool_unreadable' });
    await act(async () => host.querySelector('form')!.requestSubmit());
    expect(alert()).toContain('no quote');
    api.checkApproval.mockResolvedValueOnce({ ok: false, code: 'protocol.chain_unreadable' });
    await act(async () => host.querySelector('form')!.requestSubmit());
    expect(alert()).toContain('allowance');
    api.buildSwap.mockResolvedValueOnce({ ok: false, code: 'protocol.swap_min_out_below_bound' });
    await act(async () => host.querySelector('form')!.requestSubmit());
    expect(alert()).toContain('no longer safe');
    expect(wallet.sendSequence).not.toHaveBeenCalled();
  });

  it('says an approve already sent stays sent when the person cancels the swap step', async () => {
    wallet.sendSequence.mockResolvedValue({ status: 'rejected', sent: [HASH] });
    await mount();
    await review();
    expect(alert()).toBe(`You cancelled the rest of the steps. Already sent before that, and not undone: ${HASH}.`);
  });

  it('follows the swap until it is mined, then reads the balance again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await mount();
      await review();
      const reads = wallet.call.mock.calls.length;
      wallet.read.mockResolvedValue({ status: '0x1', blockNumber: '0x5' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      expect(text()).toContain(`Mined: ${HASH}`);
      expect(wallet.call.mock.calls.length).toBeGreaterThan(reads);
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers the network switch, not a reconnect, on the wrong network', async () => {
    Object.assign(wallet, { guard: { ok: false } });
    await mount();
    expect(button(t('quickSwitch'))).toBeDefined();
    expect(text()).toContain('Connect a wallet on the app’s network');
    await click(t('quickSwitch'));
    expect(wallet.switchNetwork).toHaveBeenCalled();
  });
});
