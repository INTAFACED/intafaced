import { describe, expect, it } from 'vitest';
import type { AdminOrderRow } from './reads';
import {
  cleanOrderId,
  csvCell,
  explainHold,
  filterOrders,
  findOrder,
  NO_FILTERS,
  ordersToCsv,
  parsePageSize,
  statusWord,
  summarize,
  truncationNotice,
} from './orders-model';

const row = (p: Partial<AdminOrderRow> = {}): AdminOrderRow => ({
  id: 'aaaaaaaa-1',
  userId: 'u1',
  symbol: 'BTC/USDT',
  side: 'buy',
  type: 'limit',
  timeInForce: 'GTC',
  price: '100.10',
  amount: '2',
  filled: '0',
  remaining: '2',
  cost: null,
  status: 'open',
  held: false,
  recoveryReason: null,
  reconciliationKey: null,
  seeded: false,
  datetime: '2026-10-17T00:00:00Z',
  clientOrderId: null,
  ...p,
});

describe('orders model', () => {
  it('page size is one of the allowed values', () => {
    expect(parsePageSize('100')).toBe(100);
    expect(parsePageSize('7')).toBe(200);
    expect(parsePageSize(undefined)).toBe(200);
    expect(parsePageSize(['500'])).toBe(500);
  });
  it('status words', () => {
    expect(statusWord(row()).label).toBe('Open');
    expect(statusWord(row({ filled: '1', remaining: '1' })).label).toBe('Partially filled');
    expect(statusWord(row({ held: true, filled: '1' })).key).toBe('held');
    expect(statusWord(row({ status: 'closed', filled: '2', remaining: '0' })).label).toBe('Filled');
  });
  it('filters combine', () => {
    const rows = [row(), row({ id: 'b', symbol: 'ETH/USDT', side: 'sell', seeded: true, userId: 'u2' })];
    expect(filterOrders(rows, { ...NO_FILTERS, market: 'ETH/USDT' })).toHaveLength(1);
    expect(filterOrders(rows, { ...NO_FILTERS, origin: 'seeded' })[0]?.id).toBe('b');
    expect(filterOrders(rows, { ...NO_FILTERS, origin: 'customer' })[0]?.id).toBe('aaaaaaaa-1');
    expect(filterOrders(rows, { ...NO_FILTERS, userId: 'U2' })).toHaveLength(1);
    expect(filterOrders(rows, { ...NO_FILTERS, idSearch: 'AAAA' })).toHaveLength(1);
  });
  it('summary counts held apart from open and never sums notional', () => {
    const s = summarize([row(), row({ held: true }), row({ seeded: true })]);
    expect(s).toEqual({ shown: 3, open: 2, seeded: 1, held: 1 });
  });
  it('truncation notice only when the limit is reached', () => {
    expect(truncationNotice(50, 50)).toContain('newest 50');
    expect(truncationNotice(49, 50)).toBeNull();
  });
  it('hold explanation', () => {
    expect(explainHold('SUBMIT_UNKNOWN').heading).toBe('Submit unknown');
    expect(explainHold('RECONCILING').heading).toBe('Reconciling');
    expect(explainHold('weird').stage).toContain('weird');
  });
  it('csv guards formulas and quotes', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
    const csv = ordersToCsv([row({ id: '=cmd' })]);
    expect(csv.split('\r\n')[1]?.startsWith("'=cmd,")).toBe(true);
  });
  it('id checks and lookup', () => {
    expect(cleanOrderId(' abc-1 ')).toBe('abc-1');
    expect(cleanOrderId('a/b')).toBeNull();
    expect(findOrder([row()], 'zzz')).toBeNull();
  });
});
