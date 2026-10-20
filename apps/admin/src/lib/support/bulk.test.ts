import { describe, expect, it } from 'vitest';
import {
  bulkChangeOf,
  bulkCodeWords,
  bulkGate,
  bulkSummary,
  bulkTally,
  emptyBulkForm,
  readBulkPolicy,
  readBulkResults,
  type BulkForm,
} from './bulk';
import { readBulkReply } from './bulk-browser';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const form = (over: Partial<BulkForm> = {}): BulkForm => ({ ...emptyBulkForm, ...over });

describe('the batch size', () => {
  it('reads a set size and a blank one, and nothing in between', () => {
    expect(readBulkPolicy({ cap: 25, missing: null })).toEqual({ cap: 25 });
    expect(readBulkPolicy({ cap: null, missing: 'support.bulk_cap' })).toEqual({ cap: null });
    expect(readBulkPolicy({ cap: null, missing: null })).toBeNull();
    expect(readBulkPolicy({ cap: 25, missing: 'support.bulk_cap' })).toBeNull();
    expect(readBulkPolicy({ cap: 0, missing: null })).toBeNull();
    expect(readBulkPolicy({ cap: 1.5, missing: null })).toBeNull();
    expect(readBulkPolicy('25')).toBeNull();
  });
});

describe('the change the bar holds', () => {
  it('is null until it is complete, and clears a priority with "none"', () => {
    expect(bulkChangeOf(form())).toBeNull();
    expect(bulkChangeOf(form({ kind: 'status', status: 'resolved' }))).toEqual({ kind: 'status', status: 'resolved' });
    expect(bulkChangeOf(form({ kind: 'priority' }))).toBeNull();
    expect(bulkChangeOf(form({ kind: 'priority', priority: 'high' }))).toEqual({ kind: 'priority', priority: 'high' });
    expect(bulkChangeOf(form({ kind: 'priority', priority: 'none' }))).toEqual({ kind: 'priority', priority: null });
    expect(bulkChangeOf(form({ kind: 'assign', assigneeId: 'me' }))).toBeNull();
    expect(bulkChangeOf(form({ kind: 'assign', assigneeId: A }))).toEqual({ kind: 'assign', assigneeId: A });
  });
});

describe('when the bar may send', () => {
  const ready = form({ kind: 'status', status: 'resolved' });
  it('refuses with the real reason: no size read, size not set, nothing ticked, over the size, nothing chosen', () => {
    expect(bulkGate({ selected: 2, policy: null }, ready, false)).toMatchObject({ ok: false });
    expect(bulkGate({ selected: 2, policy: { cap: null } }, ready, false)).toMatchObject({
      ok: false,
      why: expect.stringContaining('not set'),
    });
    expect(bulkGate({ selected: 0, policy: { cap: 5 } }, ready, false)).toMatchObject({ ok: false, why: 'Tick at least one request.' });
    expect(bulkGate({ selected: 6, policy: { cap: 5 } }, ready, false)).toMatchObject({ ok: false, why: expect.stringContaining('5') });
    expect(bulkGate({ selected: 2, policy: { cap: 5 } }, form(), false)).toMatchObject({ ok: false });
    expect(bulkGate({ selected: 2, policy: { cap: 5 } }, ready, true)).toMatchObject({ ok: false });
  });
  it('goes at exactly the size', () => {
    expect(bulkGate({ selected: 5, policy: { cap: 5 } }, ready, false)).toEqual({ ok: true });
  });
});

describe('the answer', () => {
  const rows = [
    { ticketId: A, outcome: 'changed', code: null },
    { ticketId: B, outcome: 'unchanged', code: null },
    { ticketId: '33333333-3333-4333-8333-333333333333', outcome: 'refused', code: 'support.transition_illegal' },
  ];
  it('reads every request or none', () => {
    expect(readBulkResults({ batchKey: 'k', results: rows })).toHaveLength(3);
    expect(readBulkResults({ batchKey: 'k', results: [...rows, { ticketId: 'x', outcome: 'changed', code: null }] })).toBeNull();
    expect(readBulkResults({ batchKey: 'k', results: [{ ticketId: A, outcome: 'done', code: null }] })).toBeNull();
    expect(readBulkResults({ results: rows })).toBeNull();
  });
  it('counts and says it in the service words', () => {
    const read = readBulkResults({ batchKey: 'k', results: rows })!;
    expect(bulkTally(read)).toEqual({ changed: 1, unchanged: 1, refused: 1 });
    expect(bulkSummary(read)).toBe('svc-support changed 1, found 1 already there and refused 1 of 3 requests.');
  });
  it('names a known refusal in words and shows an unknown code as it is', () => {
    expect(bulkCodeWords('support.transition_illegal')).toContain('not allowed');
    expect(bulkCodeWords('support.something_new')).toBe('support.something_new');
    expect(bulkCodeWords(null)).toBe('');
  });
  it('the browser reply is a success only with every request in it', () => {
    expect(readBulkReply({ ok: true, action: 'bulk', summary: 's', results: rows })).toMatchObject({ ok: true });
    expect(readBulkReply({ ok: true, action: 'bulk', summary: 's' })).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
    expect(readBulkReply({ ok: true, action: 'status', summary: 's', results: rows })).toMatchObject({ ok: false });
    expect(readBulkReply(null)).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });
});
