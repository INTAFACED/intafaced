// @vitest-environment happy-dom
/**
 * CB-otc-12 — a large conversion at the desk price. The pair, sizes, prices and ids are TEST fixtures; the API is a
 * stub that answers exactly what each test names, so every shown value is traced to the answer it came from.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConvertBounds, OtcConvertQuote } from '../rooms/api';

type Loadable<T> = { status: 'ready'; data: T } | { status: 'loading' };
const state = vi.hoisted(() => ({
  bounds: null as Loadable<ConvertBounds> | null,
  api: {} as Record<string, ReturnType<typeof vi.fn>>,
  runs: [] as { kind: string; id: string; symbol: string }[],
  note: { state: 'none' } as { state: 'none' } | { state: 'pending'; pending: { id: string; kind: string; symbol: string } },
  resolved: [] as string[],
}));

vi.mock('../rooms/read', async (real) => ({
  ...(await real<typeof import('../rooms/read')>()),
  useRoomApi: () => state.api,
  usePrivateRead: () => state.bounds,
}));
vi.mock('../otc/data', () => ({
  useDeskStatus: () => ({ status: 'ready', data: { assets: ['BTC'] } }),
  usePairs: () => ({
    status: 'ready',
    data: [
      { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', lot: '0.0001' },
      { symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', lot: '0.001' },
    ],
  }),
}));
vi.mock('../rooms/write', () => ({
  useRoomWriter: () => ({
    busy: false,
    outcome: { kind: 'idle' },
    get note() {
      return state.note;
    },
    signedIn: true,
    resolve: (id: string) => void state.resolved.push(id),
    dismiss: () => undefined,
    run: async (intent: { kind: string; id: string; symbol: string; call: () => Promise<{ ok: boolean; data?: unknown }> }) => {
      state.runs.push({ kind: intent.kind, id: intent.id, symbol: intent.symbol });
      const r = await intent.call();
      return r.ok ? { kind: 'done', data: r.data } : { kind: 'refused', words: { title: 'refused' } };
    },
  }),
}));

const { OtcConvert } = await import('./OtcConvert');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

const QUOTE: OtcConvertQuote = {
  quoteId: 'q-test-1',
  side: 'buy',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  qty: '0.5',
  midPrice: '200',
  spreadBps: 25,
  quotedPrice: '200.5',
  userNotional: '100.25',
  // Firm for a minute from the test's start, so the price can be confirmed.
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  flow: 'convert',
  settleWindowMs: 45_000,
} as OtcConvertQuote;

async function show() {
  await act(async () => root.render(<OtcConvert />));
}
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;
async function typeQty(value: string) {
  const input = host.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(name: string) {
  await act(async () => button(name).click());
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  state.runs = [];
  state.note = { state: 'none' };
  state.resolved = [];
  state.bounds = { status: 'ready', data: { convert: { minQty: '0.1', maxQty: '5' }, oneClickBuy: null } };
  state.api = {
    otcConvertQuote: vi.fn(async () => ({ ok: true, data: QUOTE })),
    rfqAccept: vi.fn(async () => ({ ok: true, data: { ...QUOTE } })),
    otcSettle: vi.fn(async () => ({
      ok: true,
      data: { qty: '0.5', baseAsset: 'BTC', quoteAsset: 'USDT', fillPrice: '200.5', fillNotional: '100.25' },
    })),
    rfqGet: vi.fn(),
  };
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the desk size range on the Convert page (CB-otc-12)', () => {
  it('shows the published range with the chosen pair’s base asset', async () => {
    await show();
    expect(byId('convert-otc-range')).toBe('Desk size range:0.1 to 5 BTC');
  });

  it('reads "Not set" with the refusal it causes when the owner has published none', async () => {
    state.bounds = { status: 'ready', data: { convert: null, oneClickBuy: null } };
    await show();
    expect(byId('convert-otc-range')).toBe('Desk size range:Not setThe desk has no size range for conversions, so a request refuses.');
  });

  it('offers only pairs whose base asset the desk lists', async () => {
    await show();
    expect(host.textContent).toContain('BTC/USDT');
    expect(host.textContent).not.toContain('ETH/USDT');
  });
});

describe('asking and confirming at the desk price (CB-otc-12)', () => {
  it('asks the convert flow for the typed size and shows the quoted price and the settle window', async () => {
    await show();
    await typeQty('0.5');
    await click('Get desk price');
    expect(state.api.otcConvertQuote).toHaveBeenCalledWith({
      flow: 'convert',
      side: 'buy',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      qty: '0.5',
    });
    expect(byId('convert-otc-quoted')).toBe('200.5 USDT');
    expect(byId('convert-otc-settles')).toBe('Settles within 45 s of confirming.');
  });

  it('with no settle window published, names the quote expiry instead of a time it does not have', async () => {
    state.api.otcConvertQuote = vi.fn(async () => ({ ok: true, data: { ...QUOTE, settleWindowMs: null } }));
    await show();
    await typeQty('0.5');
    await click('Get desk price');
    expect(byId('convert-otc-settles')).toMatch(/^Settles when you confirm, before the price expires at \d{2} [A-Z][a-z]{2}, \d{2}:\d{2}/);
  });

  it('an answer for a different size is never shown as this request’s price', async () => {
    state.api.otcConvertQuote = vi.fn(async () => ({ ok: true, data: { ...QUOTE, qty: '5' } }));
    await show();
    await typeQty('0.5');
    await click('Get desk price');
    expect(byId('convert-otc-price')).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'The desk answered for a different request, so it is not shown. Ask again.',
    );
  });

  it('confirm binds the quoted price, then settles, both keyed by the quote id', async () => {
    await show();
    await typeQty('0.5');
    await click('Get desk price');
    await click('Convert at this price');
    expect(state.api.rfqAccept).toHaveBeenCalledWith('q-test-1', '200.5');
    expect(state.api.otcSettle).toHaveBeenCalledWith('q-test-1');
    // Noted as the quote desk notes its own steps, so either room can check an unconfirmed one.
    expect(state.runs.slice(1)).toEqual([
      { kind: 'rfq', id: 'q-test-1', symbol: 'accept:BTC/USDT' },
      { kind: 'rfq', id: 'q-test-1', symbol: 'settle:BTC/USDT' },
    ]);
    expect(byId('convert-otc-price')).toBeNull();
  });

  it('a refused accept never settles', async () => {
    state.api.rfqAccept = vi.fn(async () => ({ ok: false }));
    await show();
    await typeQty('0.5');
    await click('Get desk price');
    await click('Convert at this price');
    expect(state.api.otcSettle).not.toHaveBeenCalled();
    expect(byId('convert-otc-quoted')).toBe('200.5 USDT');
  });

  it('changing the amount takes a shown price off the page', async () => {
    await show();
    await typeQty('0.5');
    await click('Get desk price');
    expect(byId('convert-otc-quoted')).toBe('200.5 USDT');
    await typeQty('2');
    expect(byId('convert-otc-price')).toBeNull();
  });

  it('an expired price cannot be confirmed', async () => {
    state.api.otcConvertQuote = vi.fn(async () => ({
      ok: true,
      data: { ...QUOTE, expiresAt: new Date(Date.now() - 1_000).toISOString() },
    }));
    await show();
    await typeQty('0.5');
    await click('Get desk price');
    expect(byId('convert-otc-price')).toContain('This price has expired. Ask again for a new one.');
    expect(button('Convert at this price').disabled).toBe(true);
    expect(state.api.rfqAccept).not.toHaveBeenCalled();
  });
});

describe('an unconfirmed step (CB-otc-12)', () => {
  it('another room’s note is left to that room: not shown here, and no check here can release it', async () => {
    state.note = { state: 'pending', pending: { id: 'cvt-other-1', kind: 'convert', symbol: 'BTC/USDT' } };
    await show();
    expect(host.textContent).not.toContain('cvt-other-1');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Check status')).toBe(false);
  });

  it('a settle still bound on re-read keeps the lock; once settled it is released', async () => {
    state.note = { state: 'pending', pending: { id: 'q-test-1', kind: 'rfq', symbol: 'settle:BTC/USDT' } };
    state.api.rfqGet = vi.fn(async () => ({ ok: true, data: { ...QUOTE, lifecycle: 'bound', status: 'bound' } }));
    await show();
    await click('Check status');
    expect(state.api.rfqGet).toHaveBeenCalledWith('q-test-1');
    expect(state.resolved).toEqual([]);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('still in the same stage');
    state.api.rfqGet = vi.fn(async () => ({ ok: true, data: { ...QUOTE, lifecycle: 'settled', status: 'settled' } }));
    await click('Check status');
    expect(state.resolved).toEqual(['q-test-1']);
  });
});
