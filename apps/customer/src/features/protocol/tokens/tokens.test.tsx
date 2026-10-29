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
import { STABLECOINS_UNSET, STOCKS_BLOCKER, TokensRoom } from './TokensRoom';

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
  it('opens on Trending with every tab, the formula link and a token table that names its blocker, with no rows', () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() });
    const html = renderToStaticMarkup(<TokensRoom />);
    expect(html).toContain('<h1>Tokens</h1>');
    for (const tab of ['Trending', 'Top traded', 'New listings', 'Market brief', 'Stablecoins', 'Leaderboard', 'Stocks'])
      expect(html).toMatch(new RegExp(`role="tab"[^>]*>${tab}</button>`));
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('How trending is worked out');
    expect(html).toContain('aria-label="Tokens"');
    expect(html).toContain('data-blocker="indexer"');
    expect(html).not.toContain('data-testid="token-growth"');
    expect(html).not.toMatch(/\$\d/);
    expect(html).toMatch(/<label[^>]*><span>Window<\/span><select/);
    expect(html).toMatch(/<th scope="col">Growth \(1 hour\)<\/th>/);
    expect(STABLECOINS_UNSET).toBe('indexer.stablecoins_unset');
    expect(STOCKS_BLOCKER).toBe('licence');
  });
});

describe('Token page', () => {
  it('shows facts as Not available, the trust tier unknown and the score Not scored, and the three detail tabs', () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() });
    const html = renderToStaticMarkup(<TokenPage address={TOKEN} />);
    expect(html).toContain(`<h1>Token ${TOKEN}</h1>`);
    expect(html).toContain('aria-label="Token facts"');
    expect(html.match(/>Not available</g)).toHaveLength(5);
    expect(html).toMatch(/data-testid="token-trust-tier"[^>]*>unknown</);
    expect(html).toMatch(/data-testid="token-organic-score"[^>]*>Not scored</);
    for (const tab of ['Pairs', 'Holders', 'Trades']) expect(html).toMatch(new RegExp(`role="tab"[^>]*>${tab}</button>`));
    expect(html).toContain('Add to watchlist');
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
