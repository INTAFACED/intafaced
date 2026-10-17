export type LibraryStrategy = {
  id: string;
  name: string;
  environment: 'paper' | 'backtest' | 'shadow';
  claimLabel: string;
  cash: string;
  blocks: { side: 'buy' | 'sell'; symbol: string; qty: string }[];
  risk: { maxDrawdown: string; maxNotional: string; kill: string };
};
export type LibraryFilter = {
  query: string;
  environment: LibraryStrategy['environment'] | 'all';
  sort: 'name' | 'blocks';
};

/** Search by name, id or traded symbol; filter by environment; sort. Pure. */
export function filterLibrary(list: readonly LibraryStrategy[], filter: LibraryFilter): LibraryStrategy[] {
  const query = filter.query.trim().toLowerCase();
  const kept = list.filter(
    (s) =>
      (filter.environment === 'all' || s.environment === filter.environment) &&
      (!query ||
        s.name.toLowerCase().includes(query) ||
        s.id.toLowerCase().includes(query) ||
        s.blocks.some((b) => b.symbol.toLowerCase().includes(query))),
  );
  return [...kept].sort((a, b) =>
    filter.sort === 'blocks' ? b.blocks.length - a.blocks.length || a.name.localeCompare(b.name) : a.name.localeCompare(b.name),
  );
}

/** Counts shown on a strategy card: traded symbols and the buy/sell split. */
export function strategySummary(s: LibraryStrategy): { symbols: string[]; buys: number; sells: number } {
  return {
    symbols: [...new Set(s.blocks.map((b) => b.symbol))],
    buys: s.blocks.filter((b) => b.side === 'buy').length,
    sells: s.blocks.filter((b) => b.side === 'sell').length,
  };
}

export const LIBRARY_CSV_HEADER = [
  'id',
  'name',
  'environment',
  'claim_label',
  'cash',
  'symbols',
  'blocks',
  'max_drawdown',
  'max_notional',
  'kill',
] as const;
export function libraryRows(list: readonly LibraryStrategy[]): string[][] {
  return list.map((s) => [
    s.id,
    s.name,
    s.environment,
    s.claimLabel,
    s.cash,
    strategySummary(s).symbols.join(' '),
    String(s.blocks.length),
    s.risk.maxDrawdown,
    s.risk.maxNotional,
    s.risk.kill,
  ]);
}
