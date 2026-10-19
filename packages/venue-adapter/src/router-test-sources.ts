import { parseAmount } from '@intafaced/ledger-client/money';
import type { LiquiditySource } from './source.js';
export const NOW = new Date('2026-08-17T00:00:00Z');
export const src = (id: string, price: string, feeBps: number, amount = '1'): LiquiditySource =>
  ({
    id,
    kind: 'external-cex',
    capabilities: ['quote'],
    health: () => ({ healthy: true, latencyMs: 1, lastUpdate: NOW }),
    quote: async (r: any) => ({
      venueId: id,
      symbol: r.symbol,
      side: r.side,
      amount: parseAmount(amount),
      price: parseAmount(price),
      feeBps,
      expiresAt: new Date(NOW.getTime() + 60_000),
    }),
  }) as unknown as LiquiditySource;
export { parseAmount };
