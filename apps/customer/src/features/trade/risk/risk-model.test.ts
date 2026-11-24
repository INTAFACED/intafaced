import { describe, expect, it } from 'vitest';
import type { StatusFeed } from '../../../shared/notify-reads';
import type { Order } from '../trade-api';
import type { VenueLegOutcome, VenueOrder, VenuePosition } from '../venue-api';
import type { ActionResult } from '../venue/VenueKit';
import {
  cancelBatches,
  judgeCancelEverything,
  judgeVenueCancel,
  openIncidents,
  openVenuePositions,
  summariseOpenOrders,
  summariseVenueOrders,
} from './risk-model';

// TEST orders only: a symbol, a status and the flags the model reads.
const order = (id: string, symbol: string, status: string): Order => ({ id, symbol, status, recoveryRequired: false }) as Order;
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

// TEST venue orders and answers: only the fields the model reads.
const venueOrder = (id: string | null, symbol: string, status: VenueOrder['status']): VenueOrder =>
  ({ venueClientOrderId: id, symbol, status }) as VenueOrder;
const asOf = '2026-11-24T00:00:00Z';
const accepted = (legs: boolean[]): ActionResult => ({
  kind: 'outcome',
  reused: false,
  clientOrderId: null,
  nonce: 'n1',
  outcome: {
    definite: true,
    accepted: true,
    venueRef: null,
    order: null,
    asOf,
    legs: legs.map((ok): VenueLegOutcome =>
      ok
        ? { definite: true, accepted: true, venueRef: null, order: null, asOf }
        : { definite: true, accepted: false, refusal: { venueId: 'test', code: 'unknown_order', detail: 'TEST no such order' }, asOf },
    ),
  },
});

describe('venue open orders', () => {
  it('counts only resting orders with a client id, by market, never cut', () => {
    const summary = summariseVenueOrders([
      venueOrder('c1', 'BTC-USDC', 'open'),
      venueOrder('c2', 'BTC-USDC', 'partially_filled'),
      venueOrder('c3', 'BTC-PERP', 'open'),
      venueOrder('c4', 'BTC-PERP', 'canceled'),
      venueOrder(null, 'BTC-PERP', 'open'),
    ]);
    expect(summary).toEqual({
      total: 3,
      capped: false,
      markets: [
        { symbol: 'BTC-USDC', count: 2 },
        { symbol: 'BTC-PERP', count: 1 },
      ],
    });
  });
  it('drops a position of size zero', () => {
    const p = (size: string) => ({ symbol: 'BTC-PERP', side: 'long', size }) as VenuePosition;
    expect(openVenuePositions([p('0'), p('0.000'), p('0.01')]).map((x) => x.size)).toEqual(['0.01']);
  });
  it('batches ids by what the venue takes in one action, and none where it takes no batch', () => {
    expect(cancelBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(cancelBatches([1, 2, 3], 20)).toEqual([[1, 2, 3]]);
    expect(cancelBatches([1, 2], 0)).toEqual([]);
  });
});

describe('venue cancel verdict', () => {
  it('is done only when every confirmed order was accepted as cancelled', () => {
    expect(judgeVenueCancel(3, [accepted([true, true, true])])).toEqual({ kind: 'done', cancelled: 3 });
    expect(judgeVenueCancel(3, [accepted([true, true]), accepted([true])])).toEqual({ kind: 'done', cancelled: 3 });
  });
  it('is partial, leg by leg, when the venue refused some', () => {
    expect(judgeVenueCancel(3, [accepted([true, false, true])])).toEqual({ kind: 'partial', cancelled: 2, left: 1 });
  });
  it('is partial when a later batch was refused after an earlier one cancelled', () => {
    const refused: ActionResult = { kind: 'refused', code: 'x', message: 'TEST refused', beforeWallet: true };
    expect(judgeVenueCancel(3, [accepted([true, true]), refused])).toEqual({ kind: 'partial', cancelled: 2, left: 1 });
  });
  it('is uncertain on an answer with no definite outcome, never done or nothing', () => {
    expect(judgeVenueCancel(3, [{ kind: 'unknown', clientOrderId: null, nonce: 'n1' }])).toEqual({ kind: 'uncertain' });
    expect(judgeVenueCancel(3, [accepted([true, true]), { kind: 'unknown', clientOrderId: null, nonce: 'n2' }])).toEqual({
      kind: 'uncertain',
    });
  });
  it('says who refused when nothing was cancelled', () => {
    expect(judgeVenueCancel(3, [{ kind: 'rejected' }])).toEqual({ kind: 'refused', reason: 'wallet_rejected', detail: '' });
    expect(judgeVenueCancel(3, [{ kind: 'refused', code: 'x', message: 'TEST no', beforeWallet: true }])).toEqual({
      kind: 'refused',
      reason: 'venue',
      detail: 'TEST no',
    });
    expect(
      judgeVenueCancel(3, [
        {
          kind: 'outcome',
          reused: false,
          clientOrderId: null,
          nonce: 'n1',
          outcome: { definite: true, accepted: false, refusal: { venueId: 'test', code: 'venue_down', detail: 'TEST down' }, asOf },
        },
      ]),
    ).toEqual({ kind: 'refused', reason: 'venue', detail: 'TEST down' });
  });
});
