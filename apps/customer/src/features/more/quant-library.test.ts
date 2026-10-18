import { describe, expect, it } from 'vitest';
import { filterLibrary, libraryRows, strategySummary, type LibraryStrategy } from './quant-library';

const make = (id: string, name: string, environment: LibraryStrategy['environment'], symbols: string[]): LibraryStrategy => ({
  id,
  name,
  environment,
  claimLabel: 'label',
  cash: '1000',
  blocks: symbols.map((symbol, i) => ({ side: i % 2 ? 'sell' : 'buy', symbol, qty: '1' })),
  risk: { maxDrawdown: '0.1', maxNotional: '500', kill: '0.2' },
});
const list = [
  make('s_2', 'Beta', 'paper', ['BTC-USD']),
  make('s_1', 'alpha', 'backtest', ['ETH-USD', 'BTC-USD', 'SOL-USD']),
  make('s_3', 'Gamma', 'shadow', []),
];

describe('quant strategy library', () => {
  it('searches name, id and symbol', () => {
    const f = { environment: 'all', sort: 'name' } as const;
    expect(filterLibrary(list, { ...f, query: 'ALPH' }).map((s) => s.id)).toEqual(['s_1']);
    expect(filterLibrary(list, { ...f, query: 's_3' }).map((s) => s.id)).toEqual(['s_3']);
    expect(filterLibrary(list, { ...f, query: 'sol' }).map((s) => s.id)).toEqual(['s_1']);
  });
  it('filters by environment and sorts', () => {
    expect(filterLibrary(list, { query: '', environment: 'paper', sort: 'name' }).map((s) => s.id)).toEqual(['s_2']);
    expect(filterLibrary(list, { query: '', environment: 'all', sort: 'name' }).map((s) => s.id)).toEqual(['s_1', 's_2', 's_3']);
    expect(filterLibrary(list, { query: '', environment: 'all', sort: 'blocks' }).map((s) => s.id)).toEqual(['s_1', 's_2', 's_3']);
  });
  it('does not mutate the loaded list', () => {
    const before = list.map((s) => s.id);
    filterLibrary(list, { query: '', environment: 'all', sort: 'blocks' });
    expect(list.map((s) => s.id)).toEqual(before);
  });
  it('summarises symbols and sides, and exports rows', () => {
    expect(strategySummary(list[1]!)).toEqual({ symbols: ['ETH-USD', 'BTC-USD', 'SOL-USD'], buys: 2, sells: 1 });
    expect(libraryRows(list)[0]).toEqual(['s_2', 'Beta', 'paper', 'label', '1000', 'BTC-USD', '1', '0.1', '500', '0.2']);
  });
});
