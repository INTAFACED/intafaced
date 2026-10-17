import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ActivityItem } from './deps';
import { recentPanelState } from './recent';

let n = 0;
const line = (over: Partial<ActivityItem>): ActivityItem => ({
  id: `i${++n}`,
  kind: 'trade',
  direction: 'out',
  asset: 'USDT',
  amount: '1',
  postedAt: '2026-10-17T10:00:00.000Z',
  txId: `t${n}`,
  counterparty: null,
  spaceName: null,
  ...over,
});

// The real shape of a conversion in Activity: a hold on the paying asset plus a trade line for the bought asset.
const conversion = [
  line({ orderId: 'o1', kind: 'order_hold', direction: 'out', asset: 'USDT', amount: '9.73524' }),
  line({ orderId: 'o1', kind: 'trade', direction: 'in', asset: 'BTC', amount: '0.00015' }),
];

describe('recentPanelState', () => {
  it('is parked on TRD-0857 even when the feed holds a real conversion', () => {
    expect(recentPanelState({ status: 'ready', data: { items: conversion } as never, asOf: 1 })).toEqual({
      kind: 'parked',
      blocker: 'TRD-0857',
    });
  });
  it('is parked for an empty feed too, so the panel never claims there are none', () => {
    expect(recentPanelState({ status: 'ready', data: { items: [] } as never, asOf: 1 })).toEqual({ kind: 'parked', blocker: 'TRD-0857' });
    expect(recentPanelState({ status: 'empty' })).toEqual({ kind: 'parked', blocker: 'TRD-0857' });
  });
  it('RecentConversions.tsx no longer says "No conversions yet"', () => {
    const source = readFileSync(new URL('./RecentConversions.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('No conversions yet');
    expect(source).toContain('TRD-0857');
  });
});
