/**
 * The listed symbol of the market a fill names. svc-trade puts the market's id on `trade.fill.settled`, while a task
 * step names the market as listed (`BTC/USDT`), so the id is read from svc-trade's public market list once and kept: a
 * market's id never changes. An id the list does not hold reads null, and the list is read again for an unknown id at
 * most once a minute (one read at a time); an unreachable list throws, so the fill is delivered again rather than
 * counted as a miss. svc-trade lists at most 500 markets in one read; a market past that never names a step's market.
 */
export interface MarketNames {
  symbolOf(marketId: string): Promise<string | null>;
}

/** svc-trade's own cap on one market list read. */
const MAX_MARKETS = 500;
const REREAD_MS = 60_000;

export function createMarketNames(options: {
  tradeUrl: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}): MarketNames {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const known = new Map<string, string>();
  let lastRead = -Infinity;
  let reading: Promise<void> | null = null;
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
    lastRead = now();
  };
  return {
    async symbolOf(marketId) {
      if (!known.has(marketId) && now() - lastRead >= REREAD_MS) {
        reading ??= read().finally(() => {
          reading = null;
        });
        await reading;
      }
      return known.get(marketId) ?? null;
    },
  };
}
