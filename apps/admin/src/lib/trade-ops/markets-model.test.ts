import { describe, expect, it } from 'vitest';
import type { AdminOrderRow, MarketRow } from './reads';
import {
  clockUtc,
  countMarkets,
  filterMarkets,
  lifecycleLook,
  NO_FILTER,
  oldestAsOf,
  seededPercent,
  tallyOrders,
  validateMarketAction,
  type MarketRowView,
} from './markets-model';

const market = (symbol: string, over: Partial<MarketRow> = {}): MarketRow => ({
  id: symbol,
  symbol,
  base: symbol.split('/')[0] ?? '',
  quote: 'USD',
  kind: 'spot',
  status: 'active',
  tickSize: '0.01',
  lotSize: '1',
  minQty: '1',
  maxQty: null,
  minNotional: '10',
  makerBps: 5,
  takerBps: 10,
  listedAt: null,
  ...over,
});
const order = (symbol: string, over: Partial<AdminOrderRow> = {}): AdminOrderRow => ({
  id: Math.random().toString(),
  userId: 'u',
  symbol,
  side: 'buy',
  type: 'limit',
  timeInForce: 'GTC',
  price: '1',
  amount: '1',
  filled: '0',
  remaining: '1',
  cost: null,
  status: 'open',
  held: false,
  recoveryReason: null,
  reconciliationKey: null,
  seeded: false,
  datetime: '2026-10-17T00:00:00Z',
  clientOrderId: null,
  ...over,
});
const view = (m: MarketRow): MarketRowView => ({ market: m, lifecycle: null, orders: null, fee: { kind: 'unread' } });
const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const good = {
  action: 'delist',
  symbol: 'AUD/USD',
  reason: 'market is being retired',
  confirmOperatorId: OTHER,
  approvalId: 'approval-12345',
  typedSymbol: 'AUD/USD',
};

describe('orders per market', () => {
  it('counts open, seeded and held per symbol and ignores non-open', () => {
    const t = tallyOrders([
      order('A/USD'),
      order('A/USD', { seeded: true }),
      order('A/USD', { held: true }),
      order('A/USD', { status: 'canceled' }),
      order('B/USD'),
    ]);
    expect(t.get('A/USD')).toEqual({ open: 3, seeded: 1, held: 1 });
    expect(t.get('B/USD')).toEqual({ open: 1, seeded: 0, held: 0 });
  });
  it('seeded share is unknown, not 0, when nothing is open', () => {
    expect(seededPercent({ open: 0, seeded: 0, held: 0 })).toBeNull();
    expect(seededPercent(null)).toBeNull();
    expect(seededPercent({ open: 3, seeded: 1, held: 0 })).toBe(33);
  });
});

describe('filters and counts', () => {
  const rows = [view(market('AUD/USD')), view(market('BRENT/USD', { status: 'halted' })), view(market('BTC-F', { kind: 'futures' }))];
  it('filters by status, kind and search', () => {
    expect(filterMarkets(rows, { ...NO_FILTER, status: 'halted' }).map((r) => r.market.symbol)).toEqual(['BRENT/USD']);
    expect(filterMarkets(rows, { ...NO_FILTER, kind: 'futures' })).toHaveLength(1);
    expect(filterMarkets(rows, { ...NO_FILTER, search: ' aud' }).map((r) => r.market.symbol)).toEqual(['AUD/USD']);
  });
  it('counts unread lifecycles as unknown and names the problem', () => {
    const c = countMarkets(rows);
    expect(c.byGroup.unknown).toBe(3);
    expect(c.byRecord.halted).toBe(1);
    expect(c.lifecycleProblems).toEqual(['not read (limit)']);
  });
  it('words every state with a shape', () => {
    expect(lifecycleLook('HALTED')).toMatchObject({ word: 'Halted', group: 'halted' });
    expect(lifecycleLook(null).group).toBe('unknown');
  });
  it('finds the oldest as-of', () => {
    expect(oldestAsOf(['2026-10-17T10:00:05Z', null, '2026-10-17T10:00:01Z'])).toBe('2026-10-17T10:00:01Z');
    expect(oldestAsOf([null])).toBeNull();
    expect(clockUtc('2026-10-17T10:00:05.123Z')).toBe('10:00:05 UTC');
    expect(clockUtc(null)).toBe('—');
  });
});

describe('validateMarketAction', () => {
  it('accepts a complete delist', () => {
    const r = validateMarketAction(good, ME);
    expect(r.ok).toBe(true);
  });
  it('refuses a short reason', () => {
    expect(validateMarketAction({ ...good, reason: 'short' }, ME)).toMatchObject({ ok: false, code: 'trade_ops.reason_too_short' });
  });
  it('refuses the requester as second operator', () => {
    expect(validateMarketAction({ ...good, confirmOperatorId: ME.toUpperCase() }, ME)).toMatchObject({
      ok: false,
      code: 'trade_ops.same_person',
    });
  });
  it('requires a second operator and approval for halt, resume and delist, but not reduce-only', () => {
    for (const action of ['halt', 'resume', 'delist'])
      expect(validateMarketAction({ ...good, action, confirmOperatorId: '' }, ME)).toMatchObject({
        ok: false,
        code: 'trade_ops.second_operator_required',
      });
    expect(validateMarketAction({ ...good, action: 'halt', approvalId: '' }, ME)).toMatchObject({
      ok: false,
      code: 'trade_ops.approval_required',
    });
    expect(validateMarketAction({ ...good, action: 'reduce_only', confirmOperatorId: '', approvalId: '' }, ME).ok).toBe(true);
  });
  it('requires the symbol typed back for delist only', () => {
    expect(validateMarketAction({ ...good, typedSymbol: 'AUD' }, ME)).toMatchObject({ ok: false, code: 'trade_ops.symbol_mismatch' });
    expect(validateMarketAction({ ...good, action: 'halt', typedSymbol: '' }, ME).ok).toBe(true);
  });
  it('refuses unknown actions and a second id that is not an id', () => {
    expect(validateMarketAction({ ...good, action: 'nuke' }, ME)).toMatchObject({ code: 'trade_ops.bad_action' });
    expect(validateMarketAction({ ...good, confirmOperatorId: 'x y' }, ME)).toMatchObject({ code: 'trade_ops.second_operator_invalid' });
  });
});
