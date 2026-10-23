import { describe, expect, it } from 'vitest';
import { groupActivity } from './activity-view';
import { groupMatches, hasFilters, NO_FILTERS } from './activity-filter';
import { activityPageSchema } from '../../data/activity';
import type { ActivityItem } from './deps';

/** PF-activity-03 screen half: the report description on a line, and the only-lines-with-a-note filter. */

const item = (over: Partial<ActivityItem>): ActivityItem => ({
  id: 'id-1',
  kind: 'transfer_out',
  direction: 'out',
  asset: 'USDT',
  amount: '12.5',
  postedAt: '2026-10-10T12:00:00Z',
  txId: 'tx-100',
  counterparty: null,
  spaceName: null,
  ...over,
});
const row = (over: Partial<ActivityItem>) => groupActivity([item(over)]).groups[0]!;

describe('only lines with a note', () => {
  const only = { ...NO_FILTERS, hasNote: true };
  it('counts as a filter, so Clear filters shows', () => {
    expect(hasFilters(only)).toBe(true);
  });
  it('keeps a line with a note or a report description, and drops one with neither', () => {
    expect(groupMatches(row({ privateNote: 'rent' }), only, 'UTC', '')).toBe(true);
    expect(groupMatches(row({ reportDescription: 'Office rent' }), only, 'UTC', '')).toBe(true);
    expect(groupMatches(row({}), only, 'UTC', '')).toBe(false);
    expect(groupMatches(row({}), NO_FILTERS, 'UTC', '')).toBe(true);
  });
});

describe('report description on the wire', () => {
  it('reads a description from the bank and leaves it absent when there is none', () => {
    const page = activityPageSchema.parse({
      items: [
        {
          id: 'a',
          kind: 'transfer_out',
          direction: 'out',
          asset: 'USDT',
          amount: '1',
          postedAt: '2026-10-10T12:00:00Z',
          txId: 't',
          reportDescription: 'Rent',
        },
        {
          id: 'b',
          kind: 'transfer_out',
          direction: 'out',
          asset: 'USDT',
          amount: '1',
          postedAt: '2026-10-10T12:00:00Z',
          txId: 't2',
          reportDescription: null,
        },
      ],
      nextCursor: null,
    });
    expect(page.items[0]?.reportDescription).toBe('Rent');
    expect(page.items[1]?.reportDescription).toBeUndefined();
  });
});

describe('the note on a payment between two people', () => {
  const wire = (over: Record<string, unknown>) =>
    activityPageSchema.parse({
      items: [
        {
          id: 'tx-200:u:USDT:in',
          kind: 'transfer_in',
          direction: 'in',
          asset: 'USDT',
          amount: '25',
          postedAt: '2026-10-22T10:14:20Z',
          txId: 'tx-200',
          counterparty: { handle: 'ada' },
          ...over,
        },
      ],
      nextCursor: null,
    }).items[0]!;

  it('reads the payment note apart from the private note, and never mixes the two', () => {
    const both = wire({ note: 'Lunch, TEST', privateNote: 'paid back' });
    expect(both.paymentNote).toBe('Lunch, TEST');
    expect(both.privateNote).toBe('paid back');
    expect(both).not.toHaveProperty('note');
    expect(wire({ note: 'Lunch, TEST' }).privateNote).toBeUndefined();
  });

  it('leaves it absent when the payment had none', () => {
    expect(wire({}).paymentNote).toBeUndefined();
    expect(wire({ note: null }).paymentNote).toBeUndefined();
    expect(wire({ note: '' }).paymentNote).toBeUndefined();
  });
});
