import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import { latencyGradeWire } from './oms-plan.js';
import {
  FEED_MARKET_NOT_CONNECTED,
  FEED_MARKET_NOT_CONNECTED_MESSAGE,
  readArbOpportunities,
  type ArbOpportunityFeed,
  type ArbOpportunityFeedRead,
} from './arb-opportunities.js';
import { createExecutionRouter } from './router.js';

const SECRET = 'a-execution-arb-opportunities-test-edge-secret';
const USER = '44444444-4444-4444-8444-444444444444';
const NOW = 1_000_000;
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-execution' });

function signed(scopes: string[]) {
  const p = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-opps',
  });
}

const terms = (venueId: string) => ({ feeBps: 5, expectedImpactBps: 0, transferCostBps: 0, latencyGrade: latencyGradeWire(venueId) });

/** TEST books: two venues one unit apart. */
function testRead(asOfMs: number, overrides: Partial<ArbOpportunityFeedRead> = {}): ArbOpportunityFeedRead {
  return {
    quotes: [
      { venueId: 'binance', kind: 'external-cex', price: '100', amount: '1', asOfMs },
      { venueId: 'bybit', kind: 'external-cex', price: '101', amount: '1', asOfMs },
    ],
    costTermsByVenue: { binance: terms('binance'), bybit: terms('bybit') },
    inventory: { prePositionedByVenue: { binance: true, bybit: true } },
    maxQuoteAgeMs: 5_000,
    fundingRate: null,
    ...overrides,
  };
}

const feedOf = (read: ArbOpportunityFeedRead): ArbOpportunityFeed => ({ read: async () => read });

describe('readArbOpportunities (CB-execution-06)', () => {
  it('answers NotConnected feed.market with no rows when no feed is attached', async () => {
    const out = await readArbOpportunities({ feed: undefined, symbol: 'BTC/USDT', amount: '1', nowMs: NOW });
    expect(out).toEqual({ status: 'not_connected', code: FEED_MARKET_NOT_CONNECTED, message: FEED_MARKET_NOT_CONNECTED_MESSAGE });
    expect(FEED_MARKET_NOT_CONNECTED_MESSAGE).toBe('Needs a market feed. It is switched off in this build.');
  });

  it('lists a positive spread with both legs, and refuses the funding row when the rate is blank', async () => {
    const out = await readArbOpportunities({ feed: feedOf(testRead(NOW)), symbol: 'BTC/USDT', amount: '1', nowMs: NOW });
    if (out.status !== 'ok') throw new Error('expected ok');
    const spread = out.rows.find((r) => r.scanClass === 'spread')!;
    expect(spread.opportunities).toHaveLength(1);
    expect(spread.opportunities[0]).toMatchObject({ buyVenueId: 'binance', sellVenueId: 'bybit', buyAllIn: '100.05' });
    const funding = out.rows.find((r) => r.scanClass === 'funding')!;
    expect(funding.opportunities).toEqual([]);
    expect(funding.refused[0]?.detail).toMatch(/funding class needs a caller-supplied rate/);
  });

  it('treats a whitespace funding rate as blank', async () => {
    const out = await readArbOpportunities({
      feed: feedOf(testRead(NOW, { fundingRate: '  ' })),
      symbol: 'BTC/USDT',
      amount: '1',
      nowMs: NOW,
    });
    if (out.status !== 'ok') throw new Error('expected ok');
    expect(out.rows.find((r) => r.scanClass === 'funding')!.opportunities).toEqual([]);
  });

  it('refuses every row on an empty book and lists nothing', async () => {
    const out = await readArbOpportunities({ feed: feedOf(testRead(NOW, { quotes: [] })), symbol: 'BTC/USDT', amount: '1', nowMs: NOW });
    if (out.status !== 'ok') throw new Error('expected ok');
    for (const row of out.rows) {
      expect(row.opportunities).toEqual([]);
      expect(row.refused[0]?.detail).toMatch(/empty book/);
    }
  });

  it('lists nothing when the owner freshness window is blank (every quote stale)', async () => {
    const out = await readArbOpportunities({
      feed: feedOf(testRead(NOW, { maxQuoteAgeMs: null })),
      symbol: 'BTC/USDT',
      amount: '1',
      nowMs: NOW,
    });
    if (out.status !== 'ok') throw new Error('expected ok');
    expect(out.rows.every((r) => r.opportunities.length === 0 && r.refused.length > 0)).toBe(true);
  });
});

function routerWith(feed: ArbOpportunityFeed | undefined) {
  const u = undefined;
  return createExecutionRouter(
    new SealedHouseTenantRegistry(),
    u,
    u,
    u,
    u,
    u,
    u,
    u,
    u,
    u,
    u,
    u,
    u,
    u,
    u,
    u,
    u,
    u,
    u,
    u,
    u,
    u,
    u,
    u,
    u,
    u,
    u,
    feed,
  );
}

describe('execution.arb.opportunities tRPC', () => {
  it('answers feed.market in this build (no feed wired)', async () => {
    const out = await routerWith(undefined)
      .createCaller(signed(['trade:read']))
      .execution.arb.opportunities({ symbol: 'BTC/USDT', amount: '1' });
    expect(out).toMatchObject({ status: 'not_connected', code: 'feed.market' });
  });

  it('reads through an attached feed', async () => {
    const out = await routerWith(feedOf(testRead(Date.now())))
      .createCaller(signed(['trade:read']))
      .execution.arb.opportunities({ symbol: 'BTC/USDT', amount: '1' });
    expect(out.status).toBe('ok');
  });

  it('refuses anonymous callers, callers without trade:read, and a non-decimal amount', async () => {
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(
      routerWith(undefined).createCaller(anon).execution.arb.opportunities({ symbol: 'BTC/USDT', amount: '1' }),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      routerWith(undefined)
        .createCaller(signed(['wallet:read']))
        .execution.arb.opportunities({ symbol: 'BTC/USDT', amount: '1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      routerWith(undefined)
        .createCaller(signed(['trade:read']))
        .execution.arb.opportunities({ symbol: 'BTC/USDT', amount: '1e3' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
