import { describe, expect, it } from 'vitest';
import {
  applyAddress,
  clearView,
  DEFAULT_VIEW,
  isDefaultView,
  parseView,
  queryFromAddress,
  readView,
  viewKey,
  writeView,
  type ViewState,
  type ViewStorage,
} from './view-state';

function memory(initial: Record<string, string> = {}): ViewStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => void (data[key] = value),
    removeItem: (key) => void delete data[key],
  };
}
const throwing: ViewStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('quota');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

const saved: ViewState = {
  tab: 'favorites',
  chip: 'gainers',
  quote: 'USDC',
  status: 'all',
  sort: { columnId: 'spread', direction: 'asc' },
  density: 'compact',
};

describe('viewKey', () => {
  it('is per signed-in user, guest otherwise', () => {
    expect(viewKey('u1')).toBe('markets-view:u1');
    expect(viewKey(null)).toBe('markets-view:guest');
  });
});

describe('saved view', () => {
  it('round trips every field', () => {
    const storage = memory();
    expect(writeView(storage, viewKey('u1'), saved)).toBe(true);
    expect(readView(storage, viewKey('u1'))).toEqual(saved);
  });
  it('keeps users apart', () => {
    const storage = memory();
    writeView(storage, viewKey('u1'), saved);
    expect(readView(storage, viewKey('u2'))).toEqual(DEFAULT_VIEW);
  });
  it('gives the default when nothing is saved, or storage is missing', () => {
    expect(readView(memory(), 'k')).toEqual(DEFAULT_VIEW);
    expect(readView(null, 'k')).toEqual(DEFAULT_VIEW);
  });
  it('falls back to the default on corrupt JSON', () => {
    expect(readView(memory({ k: '{not json' }), 'k')).toEqual(DEFAULT_VIEW);
    expect(readView(memory({ k: 'null' }), 'k')).toEqual(DEFAULT_VIEW);
    expect(readView(memory({ k: '42' }), 'k')).toEqual(DEFAULT_VIEW);
  });
  it('drops an unknown sort key but keeps the valid fields', () => {
    const view = parseView({ ...saved, sort: { columnId: 'marketcap', direction: 'asc' } });
    expect(view.sort).toBeNull();
    expect(view.tab).toBe('favorites');
    expect(parseView({ ...saved, sort: { columnId: 'last', direction: 'sideways' } }).sort).toBeNull();
  });
  it('ignores unknown tab, chip, status, density and a malformed quote', () => {
    const view = parseView({ tab: 'margin', chip: 'hot', status: 'closed', density: 'tiny', quote: 'usdt; drop' });
    expect(view).toEqual(DEFAULT_VIEW);
  });
  it('never throws when storage throws', () => {
    expect(readView(throwing, 'k')).toEqual(DEFAULT_VIEW);
    expect(writeView(throwing, 'k', saved)).toBe(false);
    expect(() => clearView(throwing, 'k')).not.toThrow();
  });
  it('clears the saved view', () => {
    const storage = memory({ k: JSON.stringify(saved) });
    clearView(storage, 'k');
    expect(readView(storage, 'k')).toEqual(DEFAULT_VIEW);
  });
});

describe('address parameters', () => {
  it('win over the saved view', () => {
    const view = applyAddress(saved, '?tab=spot&filter=losers&quote=usdt');
    expect(view).toMatchObject({ tab: 'spot', chip: 'losers', quote: 'USDT' });
  });
  it('leave the saved view alone when absent or unknown', () => {
    expect(applyAddress(saved, '')).toEqual(saved);
    expect(applyAddress(saved, '?tab=margin&filter=hot&quote=%20')).toEqual(saved);
  });
  it('reads the search text, which is never saved', () => {
    expect(queryFromAddress('?q=btc%2Fusdt')).toBe('btc/usdt');
    expect(queryFromAddress('')).toBe('');
  });
});

describe('isDefaultView', () => {
  it('is true for the default in either layout mode', () => {
    expect(isDefaultView(DEFAULT_VIEW, 'comfortable')).toBe(true);
    expect(isDefaultView({ ...DEFAULT_VIEW, density: 'compact' }, 'compact')).toBe(true);
  });
  it('is false once anything differs', () => {
    expect(isDefaultView({ ...DEFAULT_VIEW, density: 'compact' }, 'comfortable')).toBe(false);
    expect(isDefaultView({ ...DEFAULT_VIEW, status: 'all' }, 'comfortable')).toBe(false);
    expect(isDefaultView({ ...DEFAULT_VIEW, sort: { columnId: 'name', direction: 'asc' } }, 'comfortable')).toBe(false);
  });
});
