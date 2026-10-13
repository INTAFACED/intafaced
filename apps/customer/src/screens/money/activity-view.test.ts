import { describe, expect, it } from 'vitest';
import { inTab, tabFromSearch, tabHref, titleOf } from './activity-view';
import type { ActivityItem } from './deps';

const item = (over: Partial<ActivityItem>): ActivityItem => ({
  id: 'x',
  kind: 'deposit',
  direction: 'in',
  asset: 'USDT',
  amount: '1',
  postedAt: '2026-10-14T00:00:00.000Z',
  txId: 't',
  counterparty: null,
  spaceName: null,
  ...over,
});
const t = (key: string) => key;
const withHandle = (key: string, handle: string) => key.replace('{handle}', `@${handle}`);

describe('tabs', () => {
  it('reads ?tab=, and anything unknown (including old order links) as All', () => {
    expect(tabFromSearch('?tab=deposits')).toBe('deposits');
    expect(tabFromSearch('?tab=trades&x=1')).toBe('trades');
    expect(tabFromSearch('?tab=orders')).toBe('all');
    expect(tabFromSearch('')).toBe('all');
    expect(tabHref('all')).toBe('/money/activity');
    expect(tabHref('transfers')).toBe('/money/activity?tab=transfers');
  });

  it('sorts every kind into a tab', () => {
    const kinds = {
      deposits: ['deposit', 'welcome_funds'],
      transfers: ['transfer_in', 'transfer_out', 'space_move'],
      trades: ['trade'],
    } as const;
    for (const [tab, list] of Object.entries(kinds))
      for (const kind of list) {
        expect(inTab(item({ kind }), tab as 'deposits')).toBe(true);
        expect(inTab(item({ kind }), 'all')).toBe(true);
      }
    expect(inTab(item({ kind: 'fee' }), 'trades')).toBe(false);
    expect(inTab(item({ kind: 'fee' }), 'all')).toBe(true);
    expect(inTab(item({ kind: 'trade' }), 'deposits')).toBe(false);
  });
});

describe('titleOf', () => {
  it('names the other person when known', () => {
    expect(titleOf(item({ kind: 'transfer_in', counterparty: { handle: 'maya' } }), t, withHandle)).toBe('Received from @maya');
    expect(titleOf(item({ kind: 'transfer_in' }), t, withHandle)).toBe('Received');
    expect(titleOf(item({ kind: 'transfer_out', counterparty: { handle: 'ola' } }), t, withHandle)).toBe('Sent to @ola');
    expect(titleOf(item({ kind: 'transfer_out' }), t, withHandle)).toBe('Sent');
  });
  it('uses plain words for every other kind', () => {
    expect(titleOf(item({ kind: 'welcome_funds' }), t, withHandle)).toBe('Welcome test funds');
    expect(titleOf(item({ kind: 'payment', direction: 'in' }), t, withHandle)).toBe('Payment received');
    expect(titleOf(item({ kind: 'payment', direction: 'out' }), t, withHandle)).toBe('Payment sent');
    expect(titleOf(item({ kind: 'space_move' }), t, withHandle)).toBe('Moved between your accounts');
    expect(titleOf(item({ kind: 'other' }), t, withHandle)).toBe('Other activity');
  });
});
