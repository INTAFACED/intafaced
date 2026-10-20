/**
 * SP-lifecycle-history-01 — order state reference and the history window.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { fakeMarket, registerPublicRest, type PublicRestDeps } from '../public-rest.js';
import { toCcxtOrderStatus } from '../private-rest.js';
import { ORDER_STATE_REFERENCE, parseOrderHistoryWindow, referenceCovers } from './order-state-reference.js';
import type { OrderStatus } from './types.js';

const STORED: readonly OrderStatus[] = [
  'pending',
  'open',
  'filled',
  'cancelled',
  'rejected',
  'expired',
  'recovery_required',
  'hold_unknown',
];

function deps(overrides: Partial<PublicRestDeps> = {}): PublicRestDeps {
  const market = fakeMarket({ id: 'm-btc', symbol: 'BTC/USDT' });
  return {
    markets: async () => [market],
    marketBySymbol: async () => market,
    depth: async () => ({ bids: [], asks: [], sequence: 0 }),
    publicTape: async () => [],
    candles: async () => [],
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

async function read(overrides: Partial<PublicRestDeps> = {}) {
  const app = Fastify({ logger: false });
  registerPublicRest(app, deps(overrides));
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/api/v1/order-states' });
  await app.close();
  return { status: res.statusCode, body: res.json() as { states: unknown[]; historyWindow: Record<string, unknown> } };
}

describe('order state reference', () => {
  it('covers every stored order status with a row for the API value it arrives as', () => {
    for (const status of STORED) expect(referenceCovers(status, toCcxtOrderStatus)).toBe(true);
  });

  it('gives each row a label and never shows an internal state name', () => {
    const internal = /recovery_required|hold_unknown|emulated|cancel_pending|leg_rejected|released|pending|held/i;
    for (const row of ORDER_STATE_REFERENCE) {
      expect(row.customerLabel.length).toBeGreaterThan(0);
      expect(row.customerLabel).not.toMatch(internal);
      expect(row.meaning).not.toMatch(internal);
    }
  });

  it('keeps the unresolved state visible as its own label, not as plain open', () => {
    const rows = ORDER_STATE_REFERENCE.filter((r) => r.apiStatus === 'open');
    expect(rows.map((r) => r.customerLabel)).toEqual(['Open', 'Partly filled', 'Being confirmed']);
  });
});

describe('ORDER_HISTORY_WINDOW', () => {
  it('blank reads as not set and is never a cut-off', () => {
    expect(parseOrderHistoryWindow(undefined)).toEqual({ status: 'not_set' });
    expect(parseOrderHistoryWindow('')).toEqual({ status: 'not_set' });
    expect(parseOrderHistoryWindow('   ')).toEqual({ status: 'not_set' });
  });

  it('a whole number of days is published as stated', () => {
    expect(parseOrderHistoryWindow('365')).toEqual({ status: 'published', days: 365 });
  });

  it('anything else is invalid, not guessed', () => {
    for (const raw of ['0', '-5', '1.5', '90d', 'forever', '100000']) {
      expect(parseOrderHistoryWindow(raw).status).toBe('invalid');
    }
  });
});

describe('GET /api/v1/order-states', () => {
  it('serves the states and "not_set" when the owner has not published a window', async () => {
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body.states).toHaveLength(ORDER_STATE_REFERENCE.length);
    expect(body.historyWindow).toEqual({ status: 'not_set' });
  });

  it('serves the published window', async () => {
    const { body } = await read({ orderHistoryWindow: '180' });
    expect(body.historyWindow).toEqual({ status: 'published', days: 180 });
  });
});
