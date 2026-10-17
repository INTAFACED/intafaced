import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { marketLifecycleStateSchema, marketStateSnapshotSchema, type MarketLifecycleState } from '@intafaced/exchange-contract';
import { fakeMarket, presentCcxtMarket, registerPublicRest, type PublicRestDeps } from './public-rest.js';

function actions(state: MarketLifecycleState): MarketLifecycleState extends never ? never : string[] {
  if (state === 'HALTED' || state === 'REDUCE_ONLY' || state === 'EXPIRING' || state === 'DELISTING') return ['CANCEL', 'REDUCE', 'CLOSE'];
  if (state === 'CANCEL_ONLY') return ['CANCEL'];
  if (state === 'POST_ONLY') return ['PLACE_POST_ONLY', 'AMEND', 'CANCEL', 'REDUCE', 'CLOSE', 'QUOTE'];
  if (state === 'OPEN') return ['PLACE', 'PLACE_POST_ONLY', 'AMEND', 'CANCEL', 'REDUCE', 'CLOSE', 'TRIGGER', 'QUOTE', 'RFQ'];
  return [];
}

function snapshot(state: MarketLifecycleState) {
  return marketStateSnapshotSchema.parse({
    marketId: `00000000-0000-4000-8000-${state.toLowerCase().padEnd(12, '0').slice(0, 12)}`,
    ruleVersion: 'rules:v1',
    instrumentId: `instrument-${state}`,
    instrumentVersion: 'instrument:v1',
    state,
    reasonCategory: 'TECHNICAL',
    reasonCode: `trade.market_${state.toLowerCase()}`,
    effectiveAt: '2026-08-24T12:00:00.000Z',
    observedAt: '2026-08-24T12:00:00.000Z',
    lastGoodState: 'OPEN',
    allowedActions: actions(state),
    transitionId: `transition:${state}`,
    evidenceRefs: ['evidence:1'],
  });
}

describe('public markets row keeps the named lifecycle state', () => {
  it('returns each stored state on the row and in the list, and leaves active on the listing', async () => {
    const markets = marketLifecycleStateSchema.options.map((state) =>
      fakeMarket({ id: `id-${state}`, symbol: `SYM-${state}`, status: 'active' }),
    );
    const unpublished = fakeMarket({ id: 'id-none', symbol: 'SYM-NONE', status: 'active' });
    const bySymbol = new Map([...markets, unpublished].map((market) => [market.symbol, market]));
    const deps = {
      markets: async () => [...markets, unpublished],
      marketBySymbol: async (symbol: string) => bySymbol.get(symbol) ?? null,
      lifecycleForMarket: async (market: { symbol: string }) => {
        if (market.symbol === 'SYM-NONE') return null;
        const state = market.symbol.slice('SYM-'.length) as MarketLifecycleState;
        return { ...snapshot(state), operator: 'alice', note: 'operator-note', actorId: 'actor-secret' };
      },
      depth: async () => ({ bids: [], asks: [], sequence: 1 }),
      publicTape: async () => [],
      candles: async () => [],
      now: () => Date.parse('2026-08-24T12:00:00.000Z'),
    } as PublicRestDeps;

    for (const state of marketLifecycleStateSchema.options) {
      const row = presentCcxtMarket(bySymbol.get(`SYM-${state}`)!, Date.parse('2026-08-24T12:00:00.000Z'), {
        lifecycle: { ...snapshot(state), operator: 'alice', note: 'operator-note', actorId: 'actor-secret' } as never,
      });
      expect(row.lifecycle?.state).toBe(state);
      expect(row.lifecycleReasonCode).toBe(`trade.market_${state.toLowerCase()}`);
      expect(row.active).toBe(true);
      expect(row).not.toHaveProperty('operator');
      expect(row.lifecycle).not.toHaveProperty('operator');
      expect(row.lifecycle).not.toHaveProperty('note');
      expect(row.lifecycle).not.toHaveProperty('actorId');
      expect(JSON.stringify(row)).not.toContain('alice');
      expect(JSON.stringify(row)).not.toContain('operator-note');
      expect(JSON.stringify(row)).not.toContain('actor-secret');
    }

    const missing = presentCcxtMarket(unpublished, Date.parse('2026-08-24T12:00:00.000Z'));
    expect(missing.lifecycle).toBeNull();
    expect(missing.active).toBe(true);

    const app = Fastify();
    registerPublicRest(app, deps);
    await app.ready();
    const listed = await app.inject({ method: 'GET', url: '/api/v1/markets?limit=50' });
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as Array<{ symbol: string; active: boolean; lifecycle: { state: string } | null; operator?: string }>;
    for (const state of marketLifecycleStateSchema.options) {
      const row = body.find((item) => item.symbol === `SYM-${state}`);
      expect(row?.lifecycle?.state).toBe(state);
      expect(row?.active).toBe(true);
      expect(row).not.toHaveProperty('operator');
    }
    const none = body.find((item) => item.symbol === 'SYM-NONE');
    expect(none?.lifecycle).toBeNull();
    expect(none?.active).toBe(true);
    expect(JSON.stringify(body)).not.toContain('actor-secret');
    await app.close();

    const bare = Fastify();
    registerPublicRest(bare, { ...deps, lifecycleForMarket: undefined });
    await bare.ready();
    const withoutPublisher = await bare.inject({ method: 'GET', url: '/api/v1/markets?limit=50' });
    expect(withoutPublisher.statusCode).toBe(200);
    for (const row of withoutPublisher.json() as Array<{ lifecycle: unknown }>) expect(row.lifecycle).toBeNull();
    await bare.close();
  });
});
