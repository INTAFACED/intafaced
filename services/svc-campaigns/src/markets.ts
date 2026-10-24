/**
 * The listed symbol of the market a fill names. svc-trade puts the market's id on `trade.fill.settled`, while a task
 * step names the market as listed (`BTC/USDT`), so the id is read from svc-trade's public market list once and kept: a
 * market's id never changes. An id the list does not hold reads null; an unreachable list throws, so the fill is
 * delivered again rather than counted as a miss.
 */
export interface MarketNames {
  symbolOf(marketId: string): Promise<string | null>;
}

/** svc-trade's own cap on one market list read. */
const MAX_MARKETS = 500;

export function createMarketNames(options: {
  tradeUrl: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): MarketNames {
  const doFetch = options.fetch ?? fetch;
  const known = new Map<string, string>();
  const read = async () => {
    const res = await doFetch(new URL(`/api/v1/markets?limit=${MAX_MARKETS}`, options.tradeUrl), {
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    if (!res.ok) throw new Error(`market list read failed: HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!Array.isArray(body)) throw new Error('market list read failed: not a list');
    for (const m of body as { id?: unknown; symbol?: unknown }[]) {
      if (typeof m.id === 'string' && typeof m.symbol === 'string') known.set(m.id, m.symbol);
    }
  };
  return {
    async symbolOf(marketId) {
      if (!known.has(marketId)) await read();
      return known.get(marketId) ?? null;
    },
  };
}
