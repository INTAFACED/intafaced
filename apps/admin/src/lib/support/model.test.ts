import { describe, expect, it } from 'vitest';
import { claimGate, formatAge, isTicketId, queueMetrics, readQueueResult } from './model';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const U = '33333333-3333-4333-8333-333333333333';
const entry = (over: Record<string, unknown> = {}) => ({
  ticketId: T1,
  userId: U,
  category: 'account',
  status: 'open',
  subject: 'Cannot sign in',
  score: 12.5,
  ageMs: 3_600_000,
  createdAt: '2026-10-17T02:00:00.000Z',
  timingKind: 'score_not_promise',
  sla: false,
  ...over,
});

describe('queue reader', () => {
  it('reads a queue and keeps the page size it asked for', () => {
    const read = readQueueResult(
      { status: 'ok', entries: [entry(), entry({ ticketId: T2, category: 'trading', status: 'pending', ageMs: 7_200_000 })] },
      100,
    );
    expect(read?.entries).toHaveLength(2);
    expect(read?.limit).toBe(100);
  });
  it('an empty queue is only empty when the service says so', () => {
    expect(readQueueResult({ status: 'empty' }, 100)).toEqual({ entries: [], limit: 100 });
    expect(readQueueResult({ status: 'empty', entries: [entry()] }, 100)).toBeNull();
    expect(readQueueResult({}, 100)).toBeNull();
    expect(readQueueResult(null, 100)).toBeNull();
    expect(readQueueResult({ status: 'ok' }, 100)).toBeNull();
  });
  it('refuses any row that is not exactly a queue row, including one that stops saying score is not a promise', () => {
    for (const bad of [
      entry({ ticketId: 'x' }),
      entry({ status: 'weird' }),
      entry({ score: 'high' }),
      entry({ ageMs: -1 }),
      entry({ createdAt: 'yesterday' }),
      entry({ timingKind: 'promise' }),
      entry({ sla: true }),
      entry({ subject: '' }),
      null,
    ]) {
      expect(readQueueResult({ status: 'ok', entries: [entry(), bad] }, 100)).toBeNull();
    }
  });
});

describe('metrics are of the page given, and say so', () => {
  const read = readQueueResult(
    {
      status: 'ok',
      entries: [
        entry(),
        entry({ ticketId: T2, category: 'trading', status: 'pending', ageMs: 7_200_000 }),
        entry({ ticketId: U, ageMs: 60_000 }),
      ],
    },
    3,
  )!;
  it('counts by status and category and finds the oldest', () => {
    const m = queueMetrics(read);
    expect(m.shown).toBe(3);
    expect(m.byStatus).toEqual({ open: 2, pending: 1 });
    expect(m.byCategory).toEqual({ account: 2, trading: 1 });
    expect(m.oldestAgeMs).toBe(7_200_000);
  });
  it('a full page is flagged: these are not totals', () => {
    expect(queueMetrics(read).pageFull).toBe(true);
    expect(queueMetrics({ ...read, limit: 100 }).pageFull).toBe(false);
  });
  it('an empty page has no oldest age rather than zero', () => {
    expect(queueMetrics({ entries: [], limit: 100 }).oldestAgeMs).toBeNull();
  });
});

describe('ages', () => {
  it('are whole units and never a promise', () => {
    expect(formatAge(0)).toBe('under a minute');
    expect(formatAge(59_999)).toBe('under a minute');
    expect(formatAge(5 * 60_000)).toBe('5 min');
    expect(formatAge(3 * 3_600_000 + 12 * 60_000)).toBe('3 h 12 min');
    expect(formatAge(50 * 3_600_000)).toBe('2 d 2 h');
  });
});

describe('who may claim', () => {
  const me = U;
  it('an unowned open or pending ticket can be claimed', () => {
    expect(claimGate({ status: 'open', assigneeId: null }, me, false)).toEqual({ ok: true });
    expect(claimGate({ status: 'pending', assigneeId: null }, me, false)).toEqual({ ok: true });
  });
  it('not a ticket someone else owns (no takeover), not one I already own, not a finished one', () => {
    expect(claimGate({ status: 'open', assigneeId: T1 }, me, false)).toMatchObject({
      ok: false,
      why: expect.stringContaining('does not allow taking it over'),
    });
    expect(claimGate({ status: 'open', assigneeId: me.toUpperCase() }, me, false)).toMatchObject({
      ok: false,
      why: expect.stringContaining('already own'),
    });
    expect(claimGate({ status: 'resolved', assigneeId: null }, me, false).ok).toBe(false);
    expect(claimGate({ status: 'closed', assigneeId: null }, me, false).ok).toBe(false);
  });
  it('not while a step is in flight', () => expect(claimGate({ status: 'open', assigneeId: null }, me, true).ok).toBe(false));
  it('ticket ids are UUIDs', () => {
    expect(isTicketId(T1)).toBe(true);
    for (const bad of ['', 'abc', null, 12, `${T1}x`]) expect(isTicketId(bad)).toBe(false);
  });
});
