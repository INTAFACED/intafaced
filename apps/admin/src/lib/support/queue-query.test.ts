import { describe, expect, it } from 'vitest';
import { clauseOf, isQueryEmpty, parseFilterText, queueQueryString, readQueueQuery } from './queue-query';
import { readActionRequest } from './model';

describe('queue query in the address (SP-desk-01)', () => {
  it('reads one field:value clause, the search and a saved view id', () => {
    const query = readQueueQuery(new URLSearchParams('filter=category:trading&q=%20zebra%20&view=0f8f1d1e-1111-4111-8111-111111111111'));
    expect(query).toEqual({
      filter: { field: 'category', op: 'eq', value: 'trading' },
      q: 'zebra',
      viewId: '0f8f1d1e-1111-4111-8111-111111111111',
    });
    expect(readQueueQuery(new URLSearchParams(queueQueryString(query)))).toEqual(query);
  });

  it('passes a field the console does not list on to svc-support to judge', () => {
    expect(parseFilterText('nosuchfield:x')).toEqual({ field: 'nosuchfield', op: 'eq', value: 'x' });
  });

  it('leaves out what it cannot read instead of guessing', () => {
    expect(parseFilterText('category')).toBeNull();
    expect(parseFilterText(':trading')).toBeNull();
    expect(parseFilterText('category:')).toBeNull();
    expect(readQueueQuery({ view: 'not-an-id' }).viewId).toBeNull();
    expect(isQueryEmpty(readQueueQuery({}))).toBe(true);
  });

  it('shows a saved view as one clause only when it is one', () => {
    expect(clauseOf({ field: 'status', op: 'eq', value: 'open' })).toEqual({ field: 'status', op: 'eq', value: 'open' });
    expect(clauseOf({ any: [] })).toBeNull();
  });

  it('a view save names one clause, a name and whether it is shared', () => {
    expect(
      readActionRequest({
        action: 'view_save',
        name: ' Trading ',
        shared: true,
        filter: { field: 'category', op: 'eq', value: 'trading' },
        reason: 'r',
      }),
    ).toEqual({
      action: 'view_save',
      name: 'Trading',
      shared: true,
      filter: { field: 'category', op: 'eq', value: 'trading' },
      reason: 'r',
    });
    expect(
      readActionRequest({
        action: 'view_save',
        name: 'x',
        shared: 'yes',
        filter: { field: 'category', op: 'eq', value: 'trading' },
        reason: 'r',
      }),
    ).toBeNull();
    expect(readActionRequest({ action: 'view_save', name: 'x', shared: true, filter: { all: [] }, reason: 'r' })).toBeNull();
  });
});
