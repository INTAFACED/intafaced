import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
const session = {
  userId: null as string | null,
  api: { query: () => new Promise(() => undefined), mutate: () => new Promise(() => undefined) },
};
vi.mock('../../session/session', () => ({ useSession: () => session, useApi: () => session.api }));
import { addToWatchlist, DEFAULT_WINDOW, readWatchlist, readWindow, removeFromWatchlist, saveWindow } from './storage';
import { TokenPage } from './TokenPage';
import type { TokenListRow } from '@intafaced/contracts/protocol-tokens';
import { exactUnits, isoTime, percentFromBps, shortAddress } from './format';
import { compareDecimal, rowsFor, STABLECOINS_UNSET, STOCKS_BLOCKER, TokensRoom } from './TokensRoom';

const TOKEN = '0x4200000000000000000000000000000000000006';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Tokens room storage', () => {
  it('keeps the window and the watchlist once each, by lower-case address', () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() });
    expect(readWindow()).toBe(DEFAULT_WINDOW);
    saveWindow('24h');
    expect(readWindow()).toBe('24h');
    expect(addToWatchlist(TOKEN.toUpperCase().replace('0X', '0x'))).toEqual({ ok: true, list: [TOKEN] });
    expect(addToWatchlist(TOKEN)).toEqual({ ok: true, list: [TOKEN] });
    expect(readWatchlist()).toEqual([TOKEN]);
    expect(removeFromWatchlist(TOKEN)).toEqual({ ok: true, list: [] });
  });
  it('reads a damaged saved list as empty, not as blocked storage, so a token can still be added', () => {
    const storage = memoryStorage();
    storage.setItem('intafaced.tokens.watchlist', '{not json');
    vi.stubGlobal('window', { localStorage: storage });
    expect(readWatchlist()).toEqual([]);
    expect(addToWatchlist(TOKEN)).toEqual({ ok: true, list: [TOKEN] });
  });
  it('tells a failed write apart from blocked storage, and keeps the list as it was', () => {
    const storage = memoryStorage();
    storage.setItem('intafaced.tokens.watchlist', JSON.stringify([TOKEN]));
    storage.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    vi.stubGlobal('window', { localStorage: storage });
    expect(addToWatchlist('0x' + '1'.repeat(40))).toEqual({ ok: false, reason: 'not_saved' });
    expect(readWatchlist()).toEqual([TOKEN]);
  });
  it('works with blocked storage: the default window, and a watchlist that says it cannot be kept', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    expect(readWindow()).toBe(DEFAULT_WINDOW);
    expect(() => saveWindow('6h')).not.toThrow();
    expect(readWatchlist()).toBeNull();
    expect(addToWatchlist(TOKEN)).toEqual({ ok: false, reason: 'blocked' });
  });
});

describe('Tokens room', () => {
  it('opens on Trending with every tab, the window, the formula and a token table that is reading, with no figure before data', () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() });
    const html = renderToStaticMarkup(<TokensRoom />);
    expect(html).toContain('<h1>Tokens</h1>');
    for (const tab of ['Trending', 'Top traded', 'New listings', 'Market brief', 'Stablecoins', 'Leaderboard', 'Stocks'])
      expect(html).toMatch(new RegExp(`role="tab"[^>]*>${tab}</button>`));
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('href="#how-trending"');
    expect(html).toMatch(/id="how-trending"[\s\S]*data-testid="trending-formula"/);
    expect(html).toContain('aria-label="Tokens"');
    expect(html).toContain('Reading the pools');
    expect(html).not.toContain('data-testid="token-growth"');
    expect(html).not.toMatch(/\$\d/);
    expect(html).toMatch(/<label[^>]*><span>Window<\/span><select/);
    expect(html).toMatch(/<th scope="col">Growth \(1 hour\)<\/th>/);
    expect(STABLECOINS_UNSET).toBe('indexer.stablecoins_unset');
    expect(STOCKS_BLOCKER).toBe('licence');
  });
});

const row = (address: string, name: string, symbol: string, fields: Partial<TokenListRow>): TokenListRow => ({
  token: { address, name, symbol, decimals: 18 } as TokenListRow['token'],
  price: null,
  growthBps: null,
  volume: '0',
  trades: 0,
  listedAt: 0,
  lookalikeOf: null,
  ...fields,
});

describe('Token lists', () => {
  const one = row('0x' + '1'.repeat(40), 'Alpha', 'ALP', { price: '2', growthBps: 500, volume: '10.5', listedAt: 30 });
  const two = row('0x' + '2'.repeat(40), 'Beta', 'BET', { price: '1', growthBps: -200, volume: '100', listedAt: 10 });
  const three = row('0x' + 'a'.repeat(40), 'Gamma', '', { volume: '10.49', listedAt: 20 });
  const all = [three, two, one];

  it('ranks Trending by growth, high first, and leaves out a token with no growth', () => {
    expect(rowsFor('trending', all, '').map((r) => r.token.name)).toEqual(['Alpha', 'Beta']);
  });
  it('ranks Top traded by volume as decimals and New listings by listing time, newest first', () => {
    expect(rowsFor('top', all, '').map((r) => r.token.name)).toEqual(['Beta', 'Alpha', 'Gamma']);
    expect(rowsFor('new', all, '').map((r) => r.token.name)).toEqual(['Alpha', 'Gamma', 'Beta']);
  });
  it('finds a token by name, symbol or address, ignoring case', () => {
    expect(rowsFor('new', all, 'gam').map((r) => r.token.name)).toEqual(['Gamma']);
    expect(rowsFor('new', all, 'bet').map((r) => r.token.name)).toEqual(['Beta']);
    expect(rowsFor('new', all, 'AAAA').map((r) => r.token.name)).toEqual(['Gamma']);
    expect(rowsFor('new', all, 'nothing')).toEqual([]);
  });
  it('compares decimal strings exactly, with signs and unequal fractions', () => {
    expect(compareDecimal('10.5', '10.49')).toBe(1);
    expect(compareDecimal('100', '99.999999999999999999')).toBe(1);
    expect(compareDecimal('-1', '0')).toBe(-1);
    expect(compareDecimal('-2', '-1.5')).toBe(-1);
    expect(compareDecimal('1.50', '1.5')).toBe(0);
  });
});

describe('Token figures', () => {
  it("shows base units in full at the token's decimals", () => {
    expect(exactUnits('40000000', 6)).toBe('40');
    expect(exactUnits('1', 18)).toBe('0.000000000000000001');
    expect(exactUnits('123456789012345678901', 18)).toBe('123.456789012345678901');
    expect(exactUnits('-1500', 3)).toBe('-1.5');
    expect(exactUnits('7', 0)).toBe('7');
  });
  it('shows basis points as a signed percent and a chain time as an ISO instant', () => {
    expect(percentFromBps(5000)).toBe('+50.00%');
    expect(percentFromBps(-7)).toBe('-0.07%');
    expect(percentFromBps(0)).toBe('0.00%');
    expect(isoTime(60)).toBe('1970-01-01T00:01:00.000Z');
    expect(shortAddress(TOKEN)).toBe('0x4200…0006');
  });
});

describe('Token page', () => {
  it('reads the token before it shows any fact, with no figure before data', () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() });
    const html = renderToStaticMarkup(<TokenPage address={TOKEN} />);
    expect(html).toContain(`<h1>Token ${TOKEN}</h1>`);
    expect(html).toContain('Reading the pools');
    expect(html).toContain('Add to watchlist');
    expect(html).not.toContain('data-testid="token-price"');
    expect(html).not.toMatch(/\$\d/);
  });
  it('answers a malformed address with not found and looks nothing up', () => {
    const html = renderToStaticMarkup(<TokenPage address="0x1234" />);
    expect(html).toContain('data-code="protocol.not_found"');
    expect(html).not.toContain('Token facts');
  });
  it('says the watchlist cannot be kept when the browser keeps no site data', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    const html = renderToStaticMarkup(<TokenPage address={TOKEN} />);
    expect(html).toContain('cannot be kept here');
    expect(html).not.toContain('Add to watchlist');
  });
});
