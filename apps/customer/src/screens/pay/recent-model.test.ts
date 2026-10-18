import { describe, expect, it } from 'vitest';
import type { ActivityItem } from './deps';
import { isPersonalTransfer, paymentsEmpty, receiptHref, recentPayments, recentRecipients, unnamedSends } from './recent-model';

const row = (id: string, patch: Partial<ActivityItem> = {}): ActivityItem => ({
  id,
  kind: 'transfer_out',
  direction: 'out',
  asset: 'USDT',
  amount: '12.5',
  postedAt: '2026-10-17T08:00:00.000Z',
  txId: `tx-${id}`,
  counterparty: { handle: 'maya_test' },
  spaceName: null,
  ...patch,
});

describe('recent payments', () => {
  it('keeps only transfers between people, newest first as the bank sent them', () => {
    const items = [
      row('a'),
      row('b', { kind: 'trade' }),
      row('c', { kind: 'transfer_in', direction: 'in' }),
      row('d', { kind: 'deposit', direction: 'in', counterparty: null }),
      row('e', { kind: 'space_move' }),
    ];
    expect(recentPayments(items).map((item) => item.id)).toEqual(['a', 'c']);
    expect(isPersonalTransfer(items[4]!)).toBe(false);
  });

  it('stops at the limit and never repeats a line', () => {
    const items = [row('a'), row('a'), ...['b', 'c', 'd', 'e', 'f', 'g'].map((id) => row(id))];
    expect(recentPayments(items).map((item) => item.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(recentPayments(items, 2)).toHaveLength(2);
  });

  it('returns nothing, not a placeholder, when there are no transfers', () => {
    expect(recentPayments([])).toEqual([]);
    expect(recentPayments([row('x', { kind: 'trade' })])).toEqual([]);
  });

  it('links each payment to its receipt page, escaping the id', () => {
    expect(receiptHref({ id: 'abc' })).toBe('/money/activity/abc');
    expect(receiptHref({ id: 'a/b c' })).toBe('/money/activity/a%2Fb%20c');
  });

  it('says "older" only when older entries exist', () => {
    expect(paymentsEmpty(true)).toBe('older');
    expect(paymentsEmpty(false)).toBe('none');
  });
});

describe('recent recipients', () => {
  it('lists people the bank shows as paid, once each, then people only this device remembers', () => {
    const items = [
      row('a', { counterparty: { handle: 'Maya_Test' } }),
      row('b', { counterparty: { handle: 'maya_test' } }),
      row('c', { counterparty: { handle: 'sam' } }),
      row('d', { kind: 'transfer_in', direction: 'in', counterparty: { handle: 'paid_me' } }),
    ];
    const remembered = [
      { userId: '3f9c1d2e-0000-4000-8000-000000000001', handle: 'sam', lastAt: '2026-10-01T00:00:00Z', times: 2 },
      { userId: '3f9c1d2e-0000-4000-8000-000000000002', handle: null, lastAt: '2026-09-01T00:00:00Z', times: 1 },
    ];
    expect(recentRecipients(items, remembered)).toEqual([
      { label: '@Maya_Test', to: 'Maya_Test' },
      { label: '@sam', to: 'sam' },
      { label: '3f9c1d2e…', to: '3f9c1d2e-0000-4000-8000-000000000002' },
    ]);
  });

  it('never invents a recipient from money received', () => {
    expect(recentRecipients([row('d', { kind: 'transfer_in', direction: 'in' })], [])).toEqual([]);
  });

  it('respects the limit', () => {
    const items = ['a', 'b', 'c', 'd'].map((id) => row(id, { counterparty: { handle: `user_${id}` } }));
    expect(recentRecipients(items, [], 2)).toHaveLength(2);
  });
});

describe('sends nobody can name', () => {
  it('picks completed sends with no recipient from the bank, never received money or named sends', () => {
    const items = [
      row('a', { counterparty: null }),
      row('b'),
      row('c', { kind: 'transfer_in', direction: 'in', counterparty: null }),
      row('a', { counterparty: null }),
      row('d', { counterparty: null }),
    ];
    expect(unnamedSends(items).map((item) => item.id)).toEqual(['a', 'd']);
    expect(unnamedSends(items, 1)).toHaveLength(1);
    expect(unnamedSends([])).toEqual([]);
  });
});
