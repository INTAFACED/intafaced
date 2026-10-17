import { describe, expect, it } from 'vitest';
import { groupActivity } from './activity-view';
import { groupMatches, hasFilters, inRange, NO_FILTERS, rangeProblem, dayStart } from './activity-filter';
import { activityCsv, csvFileName, signedAmount, CSV_HEADER } from './activity-csv';
import type { ActivityItem } from './deps';

const item = (over: Partial<ActivityItem>): ActivityItem => ({
  id: 'id-1',
  kind: 'transfer_out',
  direction: 'out',
  asset: 'USDT',
  amount: '12.5',
  postedAt: '2026-10-10T12:00:00Z',
  txId: 'tx-100',
  counterparty: { handle: 'maria_k' },
  spaceName: null,
  ...over,
});
const row = (over: Partial<ActivityItem>) => groupActivity([item(over)]).groups[0]!;

describe('activity filters', () => {
  it('knows when nothing is filtered', () => {
    expect(hasFilters(NO_FILTERS)).toBe(false);
    expect(hasFilters({ ...NO_FILTERS, q: ' ' })).toBe(false);
    expect(hasFilters({ ...NO_FILTERS, dir: 'in' })).toBe(true);
  });
  it('searches the words on the row, handles, assets, amounts and references', () => {
    const group = row({});
    expect(groupMatches(group, { ...NO_FILTERS, q: '@maria' }, 'UTC', 'Sent to @maria_k')).toBe(true);
    expect(groupMatches(group, { ...NO_FILTERS, q: 'usdt 12.5' }, 'UTC', 'Sent')).toBe(true);
    expect(groupMatches(group, { ...NO_FILTERS, q: 'tx-100' }, 'UTC', 'Sent')).toBe(true);
    expect(groupMatches(group, { ...NO_FILTERS, q: 'nobody' }, 'UTC', 'Sent')).toBe(false);
  });
  it('filters by direction', () => {
    const group = row({});
    expect(groupMatches(group, { ...NO_FILTERS, dir: 'out' }, 'UTC', '')).toBe(true);
    expect(groupMatches(group, { ...NO_FILTERS, dir: 'in' }, 'UTC', '')).toBe(false);
  });
});

describe('activity date range', () => {
  it('reads a calendar day in the chosen clock', () => {
    expect(dayStart('2026-10-10', 'UTC')).toBe(Date.UTC(2026, 9, 10));
    expect(dayStart('2026-10-10', 'UTC+8')).toBe(Date.UTC(2026, 9, 10) - 8 * 3600_000);
    expect(dayStart('2026-02-30', 'UTC')).toBeNull();
    expect(dayStart('10/10/2026', 'UTC')).toBeNull();
  });
  it('includes both end days whole', () => {
    const f = { ...NO_FILTERS, from: '2026-10-10', to: '2026-10-10' };
    expect(inRange('2026-10-10T00:00:00Z', f, 'UTC')).toBe(true);
    expect(inRange('2026-10-10T23:59:59Z', f, 'UTC')).toBe(true);
    expect(inRange('2026-10-09T23:59:59Z', f, 'UTC')).toBe(false);
    expect(inRange('2026-10-11T00:00:00Z', f, 'UTC')).toBe(false);
  });
  it('flags an end before the start', () => {
    expect(rangeProblem({ ...NO_FILTERS, from: '2026-10-11', to: '2026-10-10' }, 'UTC')).toBe('order');
    expect(rangeProblem({ ...NO_FILTERS, from: '2026-13-01' }, 'UTC')).toBe('from');
    expect(rangeProblem({ ...NO_FILTERS, from: '2026-10-01', to: '2026-10-10' }, 'UTC')).toBeNull();
  });
});

describe('activity statement export', () => {
  it('keeps exact amounts, with a minus only for money out', () => {
    expect(signedAmount({ direction: 'out', amount: '0.000000000000000001' })).toBe('-0.000000000000000001');
    expect(signedAmount({ direction: 'in', amount: '5' })).toBe('5');
    expect(signedAmount({ direction: 'out', amount: '0' })).toBe('0');
  });
  it('writes a header and one line per record in UTC, quoting commas and quotes', () => {
    const csv = activityCsv(
      [item({ spaceName: 'Holiday, "fund"' }), item({ id: 'id-2', direction: 'in', kind: 'deposit', counterparty: null, amount: '3' })],
      (entry) => (entry.kind === 'deposit' ? 'Deposit' : 'Sent'),
    );
    const lines = csv.replace('﻿', '').trimEnd().split('\r\n');
    expect(lines[0]).toBe(CSV_HEADER.join(','));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(`2026-10-10T12:00:00.000Z,Sent,out,USDT,-12.5,'@maria_k,"Holiday, ""fund""",tx-100,id-1`);
    expect(lines[2]).toBe('2026-10-10T12:00:00.000Z,Deposit,in,USDT,3,,,tx-100,id-2');
  });
  it('defuses text that a spreadsheet would run as a formula, including a leading at sign, but never touches the amount', () => {
    const csv = activityCsv([item({ spaceName: '=HYPERLINK("x")', amount: '9' })], () => 'Sent');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(',-9,');
  });
  it('names the file by date', () => {
    expect(csvFileName(new Date('2026-10-17T05:00:00Z'))).toBe('intafaced-activity-2026-10-17.csv');
  });
});
