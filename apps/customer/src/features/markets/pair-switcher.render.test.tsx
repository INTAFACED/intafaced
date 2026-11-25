// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { SessionProvider } from '../session';
import { createPoller, setDefaultPoller } from '../../data/poll';
import { PairSwitcher, usePairSwitcherHotkey } from './index';
import { RECENT_KEY } from './switcher-rows';

// The switcher against the beta's three responses, as Markets reads them (markets-beta.test.tsx):
// - GET /api/v1/markets: spot BTC/USDC, BTC/USDT, ETH/USDC, ETH/USDT, SOL/USDT
// - GET /api/v1/tickers: prices for BTC/USDC, ETH/USDC (volume 420k) and ETH/USDT (volume 4.1M)
// - GET /api/v1/venue/market-states: BTC-PERP, ETH-PERP, BTC-USDC (spot), all open
// Illustrative TEST prices matching the wire shapes.

const SPOT = [
  ['BTC', 'USDC'],
  ['BTC', 'USDT'],
  ['ETH', 'USDC'],
  ['ETH', 'USDT'],
  ['SOL', 'USDT'],
] as const;

function wireMarket(base: string, quote: string) {
  return {
    id: `${base}/${quote}`,
    symbol: `${base}/${quote}`,
    base,
    quote,
    settle: null,
    baseId: base,
    quoteId: quote,
    type: 'spot',
    spot: true,
    swap: false,
    future: false,
    option: false,
    contract: false,
    linear: null,
    inverse: null,
    active: true,
    orderable: true,
    paper: false,
    status: null,
    lifecycle: null,
    schedule: 'crypto-24x7',
    sessionOpen: true,
    nextSessionChange: null,
    hours: { kind: 'continuous' },
    taker: '0.001',
    maker: '0.001',
    contractSize: null,
    expiry: null,
    expiryDatetime: null,
    strike: null,
    optionType: null,
    precisionMode: 'TICK_SIZE',
    precision: { amount: '0.0001', price: '0.01' },
    limits: {
      amount: { min: null, max: null },
      price: { min: null, max: null },
      cost: { min: null, max: null },
      leverage: { min: null, max: null },
    },
  };
}

function wireTicker(symbol: string, last: string, open: string, quoteVolume: string) {
  const now = Date.now();
  return {
    symbol,
    timestamp: now,
    datetime: new Date(now).toISOString(),
    high: last,
    low: open,
    bid: null,
    bidVolume: null,
    ask: null,
    askVolume: null,
    vwap: null,
    open,
    close: last,
    last,
    previousClose: null,
    change: null,
    percentage: null,
    average: null,
    baseVolume: '10',
    quoteVolume,
  };
}

const TICKERS = {
  'BTC/USDC': wireTicker('BTC/USDC', '65213.84', '64000.00', '1250000.00'),
  'ETH/USDC': wireTicker('ETH/USDC', '3210.50', '3150.00', '420000.00'),
  'ETH/USDT': wireTicker('ETH/USDT', '3211.00', '3260.00', '4100000.00'),
};

function venueStates() {
  const listing = { opensAt: '2026-11-20T00:00:00.000Z', delistsAt: null, routing: 'show' as const, open: true, delisted: false };
  const market = (symbol: string, kind: string, base: string, tickSize: string) => ({
    symbol,
    kind,
    baseAsset: base,
    quoteAsset: 'USDC',
    tickSize,
    lotSize: '0.001',
    status: null,
    session: { known: false },
    listing,
  });
  return {
    venueId: 'hyperliquid-testnet',
    asOf: new Date().toISOString(),
    value: {
      venue: { id: 'hyperliquid-testnet', displayName: 'TEST venue (testnet)' },
      markets: [
        market('BTC-PERP', 'perpetual', 'BTC', '0.1'),
        market('ETH-PERP', 'perpetual', 'ETH', '0.01'),
        market('BTC-USDC', 'spot', 'BTC', '0.01'),
      ],
      test: true,
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubBetaFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const pathname = new URL(raw, 'http://localhost').pathname;
      if (pathname === '/api/v1/markets') return json(SPOT.map(([base, quote]) => wireMarket(base, quote)));
      if (pathname === '/api/v1/tickers') return json(TICKERS);
      if (pathname === '/api/v1/venue/market-states') return json(venueStates());
      if (pathname.startsWith('/api/v1/ohlcv/')) return json([]);
      if (pathname.includes('/api/identity/trpc/auth.refresh')) return json({ error: { message: 'signed out' } }, 401);
      return json({ error: { message: `unexpected ${pathname}` } }, 404);
    }),
  );
}

/** What the shell does: hold the open state, toggle it on Cmd/Ctrl-K, draw the switcher. */
function Shell() {
  const [open, setOpen] = useState(false);
  usePairSwitcherHotkey(() => setOpen((was) => !was));
  return (
    <>
      <button type="button" data-testid="opener">
        page
      </button>
      <PairSwitcher open={open} onClose={() => setOpen(false)} />
    </>
  );
}

let host: HTMLDivElement;
let root: Root;

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

async function mount() {
  await act(async () => {
    root.render(
      <SessionProvider>
        <Shell />
      </SessionProvider>,
    );
  });
  await flush();
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
const input = () => document.querySelector<HTMLInputElement>('[data-switcher-input]')!;
const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
const activeOption = () => document.getElementById(input().getAttribute('aria-activedescendant') ?? '');
const pairOf = (option: Element | null) => option?.querySelector('[data-testid="psw-pair"]')?.textContent;

async function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = input()) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}

async function type(text: string) {
  await act(async () => {
    const box = input();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

async function openWithHotkey() {
  await press('k', { ctrlKey: true }, window);
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  setDefaultPoller(createPoller());
  history.replaceState(null, '', '/trade');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setDefaultPoller(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('pair switcher (Cmd/Ctrl-K)', () => {
  it('opens on Ctrl-K as a labelled modal with focus in its search, and Escape closes it', async () => {
    stubBetaFetch();
    await mount();
    expect(dialog()).toBeNull();

    await openWithHotkey();
    const pane = dialog();
    expect(pane, 'the switcher opened').toBeTruthy();
    expect(document.getElementById(pane!.getAttribute('aria-labelledby')!)?.textContent).toBe('Switch market');
    expect(document.activeElement).toBe(input());
    // Perpetuals first, then spot: 2 perps and the 5 spot pairs Markets lists.
    expect(options().map(pairOf)).toEqual(['BTC-PERP', 'ETH-PERP', 'ETH/USDT', 'BTC/USDC', 'ETH/USDC', 'BTC/USDT', 'SOL/USDT']);

    await press('Escape');
    await flush();
    expect(dialog()).toBeNull();
  });

  it('filters on "eth", moves the active row with the arrow keys, and Enter opens that market’s desk', async () => {
    stubBetaFetch();
    await mount();
    await openWithHotkey();
    await type('eth');

    expect(options().map(pairOf)).toEqual(['ETH-PERP', 'ETH/USDT', 'ETH/USDC']);
    const groups = Array.from(document.querySelectorAll('[role="listbox"] [role="group"]')).map((g) => g.getAttribute('aria-label'));
    expect(groups).toEqual(['Perps', 'Spot']);
    // A perpetual has no price on the beta yet: a dash, never a made-up figure. Spot shows its own.
    expect(options()[0]!.querySelector('.psw-px')?.textContent).toBe('—');
    expect(options()[1]!.querySelector('.psw-px')?.textContent).toBe('$3,211.00');
    expect(options()[1]!.querySelector('.psw-ch')?.getAttribute('data-dir')).toBe('down');

    expect(pairOf(activeOption())).toBe('ETH-PERP');
    await press('ArrowDown');
    expect(pairOf(activeOption())).toBe('ETH/USDT');
    await press('ArrowDown');
    expect(pairOf(activeOption())).toBe('ETH/USDC');
    await press('ArrowDown');
    expect(pairOf(activeOption()), 'stops at the last row').toBe('ETH/USDC');
    await press('ArrowUp');
    expect(pairOf(activeOption())).toBe('ETH/USDT');
    expect(activeOption()?.getAttribute('aria-selected')).toBe('true');

    await press('Enter');
    await flush();
    expect(location.pathname).toBe('/trade/spot/ETH-USDT');
    expect(dialog(), 'closes once it has gone').toBeNull();
    expect(JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')).toEqual([{ symbol: 'ETH/USDT', kind: 'spot' }]);
  });

  it('opens a perpetual on the futures desk, and shows what was opened as a Recent chip next time', async () => {
    stubBetaFetch();
    await mount();
    await openWithHotkey();
    await type('eth');
    await press('Enter');
    await flush();
    expect(location.pathname).toBe('/trade/futures/ETH-PERP');

    await openWithHotkey();
    const chips = Array.from(document.querySelectorAll('[data-testid="psw-recent"]')).map((chip) => chip.textContent?.trim());
    expect(chips).toEqual(['ETH-PERP']);
  });

  it('says so when nothing matches, and still opens when the device store refuses to remember', async () => {
    stubBetaFetch();
    const refusing = new Storage();
    refusing.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    vi.stubGlobal('localStorage', refusing);
    await mount();
    await openWithHotkey();
    await type('zzz');
    expect(document.querySelector('[data-testid="psw-empty"]')?.textContent).toContain('No market matches “zzz”');

    await type('sol');
    await press('Enter');
    await flush();
    expect(location.pathname).toBe('/trade/spot/SOL-USDT');
  });
});
