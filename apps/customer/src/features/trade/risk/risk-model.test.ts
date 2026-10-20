import { describe, expect, it } from 'vitest';
import type { StatusFeed } from '../../developers/developers-api';
import type { Order } from '../trade-api';
import { judgeCancelEverything, openIncidents, summariseOpenOrders } from './risk-model';

// TEST orders only: a symbol, a status and the flags the model reads.
const order = (id: string, symbol: string, status: string): Order => ({ id, symbol, status, recoveryRequired: false }) as unknown as Order;
const three = [order('o1', 'TEST-A/USDT', 'open'), order('o2', 'TEST-A/USDT', 'open'), order('o3', 'TEST-B/USDT', 'open')];

describe('open orders summary', () => {
  it('counts open orders by market in first-seen order and leaves finished ones out', () => {
    const summary = summariseOpenOrders([...three, order('o4', 'TEST-B/USDT', 'canceled'), order('o5', 'TEST-C/USDT', 'closed')]);
    expect(summary).toEqual({
      total: 3,
      capped: false,
      markets: [
        { symbol: 'TEST-A/USDT', count: 2 },
        { symbol: 'TEST-B/USDT', count: 1 },
      ],
    });
  });

  it('keeps an order that needs recovery in the count even when its status looks finished', () => {
    const stuck = { ...order('o6', 'TEST-A/USDT', 'canceled'), recoveryRequired: true } as Order;
    expect(summariseOpenOrders([stuck]).total).toBe(1);
  });

  it('says "at least" when the read came back full', () => {
    expect(summariseOpenOrders(three, 3).capped).toBe(true);
    expect(summariseOpenOrders(three, 4).capped).toBe(false);
  });
});

describe('cancel everything verdict', () => {
  it('is done when as many orders came back finished as were confirmed', () => {
    const finished = three.map((entry) => ({ ...entry, status: 'canceled' }) as Order);
    expect(judgeCancelEverything(3, { ok: true, data: finished })).toEqual({ kind: 'done', cancelled: 3 });
  });

  it('is partial, with the count left, when fewer came back', () => {
    const one = [{ ...three[0], status: 'canceled' } as Order];
    expect(judgeCancelEverything(3, { ok: true, data: one })).toEqual({ kind: 'partial', cancelled: 1, left: 2 });
    expect(judgeCancelEverything(3, { ok: true, data: [] })).toEqual({ kind: 'partial', cancelled: 0, left: 3 });
  });

  it('is uncertain on any failure, never "nothing was cancelled"', () => {
    expect(judgeCancelEverything(3, { ok: false, reason: 'uncertain', message: 'lost' })).toEqual({ kind: 'uncertain' });
    expect(judgeCancelEverything(3, { ok: false, reason: 'unreachable', message: 'offline' })).toEqual({ kind: 'uncertain' });
  });
});

describe('open incidents', () => {
  it('lists only incidents with no resolution time', () => {
    const base = { impact: 'minor', components: ['api'], updates: [] } as const;
    const feed = {
      asOf: '2026-10-20T00:00:00Z',
      components: [],
      maintenance: [],
      history: { basis: 'incident_notices_only', days: [] },
      incidents: [
        { ...base, id: 'i1', title: 'TEST open', openedAt: '2026-10-20T01:00:00Z', resolvedAt: null },
        { ...base, id: 'i2', title: 'TEST done', openedAt: '2026-10-19T01:00:00Z', resolvedAt: '2026-10-19T02:00:00Z' },
      ],
    } as unknown as StatusFeed;
    expect(openIncidents(feed).map((incident) => incident.id)).toEqual(['i1']);
  });
});
