import { describe, expect, it } from 'vitest';
import { SUPPORT_NOTE_MAX } from '@intafaced/contracts';
import {
  allowedNextStatuses,
  claimGate,
  escalateGate,
  formatAge,
  isTicketId,
  queueMetrics,
  readActionRequest,
  readQueueResult,
  readRatingResult,
  internalNoteGate,
  INTERNAL_NOTE_MAX,
  DESK_COMMENTS_READ,
  noteKeyBlock,
  replyGate,
  statusGate,
} from './model';

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

describe('status moves', () => {
  it('offers only the moves svc-support allows, and none from closed', () => {
    expect(allowedNextStatuses('open')).toEqual(['pending', 'on_hold', 'resolved', 'closed']);
    expect(allowedNextStatuses('pending')).toEqual(['open', 'on_hold', 'resolved', 'closed']);
    expect(allowedNextStatuses('on_hold')).toEqual(['open', 'pending', 'resolved', 'closed']);
    expect(allowedNextStatuses('resolved')).toEqual(['open', 'closed']);
    expect(allowedNextStatuses('closed')).toEqual([]);
    expect(allowedNextStatuses('weird')).toEqual([]);
  });
  it('says why a move is off before the click', () => {
    expect(statusGate({ status: 'open' }, 'on_hold', '', false)).toMatchObject({ ok: false });
    expect(statusGate({ status: 'open' }, 'on_hold', '   ', false)).toMatchObject({ ok: false });
    expect(statusGate({ status: 'open' }, 'on_hold', 'Waiting on the bank', false)).toMatchObject({ ok: true });
    expect(statusGate({ status: 'on_hold' }, 'open', '', false)).toMatchObject({ ok: true });
    expect(statusGate({ status: 'closed' }, 'open', '', false)).toMatchObject({ ok: false });
    expect(statusGate({ status: 'resolved' }, 'pending', '', false)).toMatchObject({ ok: false });
    expect(statusGate({ status: 'open' }, 'resolved', '', true)).toMatchObject({ ok: false });
    expect(statusGate({ status: 'open' }, 'resolved', 'x'.repeat(501), false)).toMatchObject({ ok: false });
    expect(statusGate({ status: 'open' }, 'resolved', 'Fixed', false)).toEqual({ ok: true });
  });
});

describe('reply and escalate gates', () => {
  it('needs words, an open door and no send in progress', () => {
    expect(replyGate({ status: 'open' }, 'Hello', false)).toEqual({ ok: true });
    expect(replyGate({ status: 'open' }, '   ', false)).toMatchObject({ ok: false });
    expect(replyGate({ status: 'closed' }, 'Hello', false)).toMatchObject({ ok: false });
    expect(replyGate({ status: 'open' }, 'Hello', true)).toMatchObject({ ok: false });
    expect(replyGate({ status: 'open' }, 'x'.repeat(10_001), false)).toMatchObject({ ok: false });
    expect(escalateGate({ status: 'open' }, 'Needs review', false)).toEqual({ ok: true });
    expect(escalateGate({ status: 'open' }, '', false)).toMatchObject({ ok: false });
    expect(escalateGate({ status: 'closed' }, 'Needs review', false)).toMatchObject({ ok: false });
    expect(escalateGate({ status: 'resolved' }, 'Needs review', false)).toEqual({ ok: true });
  });
});

describe('the internal note gate', () => {
  it('caps a note at the contract’s own limit', () => {
    expect(INTERNAL_NOTE_MAX).toBe(SUPPORT_NOTE_MAX);
  });
  it('needs words, holds while busy, caps the length, and takes a note on a closed ticket too', () => {
    expect(internalNoteGate('  ', false)).toEqual({ ok: false, why: 'Write the note first.' });
    expect(internalNoteGate('TEST', true)).toMatchObject({ ok: false });
    expect(internalNoteGate('x'.repeat(INTERNAL_NOTE_MAX + 1), false)).toMatchObject({ ok: false });
    expect(internalNoteGate('TEST', false)).toEqual({ ok: true });
  });
  it('keys a note only from a whole read of the comments: unread or a read that filled the limit holds it, with why', () => {
    expect(noteKeyBlock(3, false)).toBeNull();
    expect(noteKeyBlock(0, false)).toBeNull();
    expect(noteKeyBlock(null, false)).toContain('could not be read');
    expect(noteKeyBlock(3, true)).toBe(
      `This ticket has ${DESK_COMMENTS_READ} or more comments, more than the desk reads, so a note cannot be told apart from one already sent.`,
    );
  });
  it('reads a note strictly: the row read and the notes sent are its key', () => {
    expect(readActionRequest({ action: 'note', ticketId: T1, body: ' TEST ', expectedSequence: 4, sent: 0 })).toEqual({
      action: 'note',
      ticketId: T1,
      body: 'TEST',
      expectedSequence: 4,
      sent: 0,
    });
    expect(readActionRequest({ action: 'note', ticketId: T1, body: 'TEST', sent: 0 })).toBeNull();
    expect(readActionRequest({ action: 'note', ticketId: T1, body: 'TEST', expectedSequence: 4 })).toBeNull();
    expect(readActionRequest({ action: 'note', ticketId: 'x', body: 'TEST', expectedSequence: 4, sent: 0 })).toBeNull();
    expect(
      readActionRequest({ action: 'note', ticketId: T1, body: 'x'.repeat(INTERNAL_NOTE_MAX + 1), expectedSequence: 4, sent: 0 }),
    ).toBeNull();
  });
});

describe('the strict action reader', () => {
  it('reads each known action and trims what was typed', () => {
    expect(readActionRequest({ action: 'reply', ticketId: T1, body: ' Hi ' })).toEqual({ action: 'reply', ticketId: T1, body: 'Hi' });
    expect(readActionRequest({ action: 'status', ticketId: T1, status: 'closed' })).toEqual({
      action: 'status',
      ticketId: T1,
      status: 'closed',
    });
    expect(readActionRequest({ action: 'status', ticketId: T1, status: 'closed', note: ' done ' })).toMatchObject({ note: 'done' });
    expect(readActionRequest({ action: 'status', ticketId: T1, status: 'on_hold', note: 'Waiting on the bank' })).toMatchObject({
      status: 'on_hold',
      note: 'Waiting on the bank',
    });
    expect(
      readActionRequest({ action: 'escalate', ticketId: T1, reason: 'kyc_review', summary: ' s ', citedArticleIds: ['kb-a'] }),
    ).toEqual({ action: 'escalate', ticketId: T1, reason: 'kyc_review', summary: 's', citedArticleIds: ['kb-a'] });
    expect(
      readActionRequest({ action: 'kb_publish', id: 'a', titleKey: 't', bodyKey: 'b', baseRevision: 0, category: 'c', tags: ['x'] }),
    ).toEqual({ action: 'kb_publish', id: 'a', titleKey: 't', bodyKey: 'b', baseRevision: 0, category: 'c', tags: ['x'] });
    expect(readActionRequest({ action: 'kb_unpublish', id: 'a', baseRevision: 3 })).toEqual({
      action: 'kb_unpublish',
      id: 'a',
      baseRevision: 3,
    });
    expect(readActionRequest({ action: 'kb_audience', id: ' a ', baseRevision: 3, audience: 'staff' })).toEqual({
      action: 'kb_audience',
      id: 'a',
      baseRevision: 3,
      audience: 'staff',
    });
  });
  it('turns anything else into null so nothing is sent', () => {
    const bad: Record<string, unknown>[] = [
      {},
      { action: 'claim', ticketId: T1 },
      { action: 'reply', ticketId: 'x', body: 'Hi' },
      { action: 'reply', ticketId: T1, body: 5 },
      { action: 'reply', ticketId: T1, body: 'x'.repeat(10_001) },
      { action: 'status', ticketId: T1, status: 'gone' },
      { action: 'status', ticketId: T1, status: 'open', note: '' },
      { action: 'escalate', ticketId: T1, reason: 'refund', summary: 's' },
      { action: 'escalate', ticketId: T1, reason: 'other', summary: 's', citedArticleIds: 'kb-a' },
      { action: 'escalate', ticketId: T1, reason: 'other', summary: 's', citedArticleIds: Array(21).fill('a') },
      { action: 'kb_publish', id: '', titleKey: 't', bodyKey: 'b', baseRevision: 0 },
      { action: 'kb_publish', id: 'a', titleKey: 't', bodyKey: 'b', baseRevision: 1.5 },
      { action: 'kb_publish', id: 'a', titleKey: 't', bodyKey: 'b', baseRevision: '0' },
      { action: 'kb_unpublish', id: 'a', baseRevision: 0 },
      { action: 'kb_audience', id: 'a', baseRevision: 1, audience: 'everyone' },
      { action: 'kb_audience', id: 'a', baseRevision: 1 },
      { action: 'kb_audience', id: 'a', baseRevision: 0, audience: 'public' },
    ];
    for (const raw of bad) expect(readActionRequest(raw)).toBeNull();
  });
});

describe('the rating reader', () => {
  const ok = { ticketId: T1, userId: U, score: 5, note: null, createdAt: '2026-10-17T02:00:00.000Z' };
  it('null is "not rated"; a good row is a rating; anything else is unreadable', () => {
    expect(readRatingResult(null)).toEqual({ value: null });
    expect(readRatingResult(ok)).toEqual({ value: ok });
    expect(readRatingResult({ ...ok, score: 0 })).toBeNull();
    expect(readRatingResult({ ...ok, score: 2.5 })).toBeNull();
    expect(readRatingResult({ ...ok, note: 3 })).toBeNull();
    expect(readRatingResult({ ...ok, userId: 'x' })).toBeNull();
    expect(readRatingResult('5')).toBeNull();
  });
});

describe('the owner changes and the stale check', () => {
  it('reads claim-next, unclaim, assign and a reply that quotes the row it read; nothing else rides along', () => {
    expect(readActionRequest({ action: 'claim_next' })).toEqual({ action: 'claim_next' });
    expect(readActionRequest({ action: 'claim_next', ticketId: T1 })).toBeNull();
    expect(readActionRequest({ action: 'unclaim', ticketId: T1, expectedSequence: 4 })).toEqual({
      action: 'unclaim',
      ticketId: T1,
      expectedSequence: 4,
    });
    expect(readActionRequest({ action: 'unclaim', ticketId: T1 })).toBeNull();
    expect(readActionRequest({ action: 'assign', ticketId: T1, assigneeId: U, expectedSequence: 0 })).toEqual({
      action: 'assign',
      ticketId: T1,
      assigneeId: U,
      expectedSequence: 0,
    });
    expect(readActionRequest({ action: 'assign', ticketId: T1, assigneeId: 'someone', expectedSequence: 0 })).toBeNull();
    expect(readActionRequest({ action: 'reply', ticketId: T1, body: 'Hi', expectedSequence: 2 })).toEqual({
      action: 'reply',
      ticketId: T1,
      body: 'Hi',
      expectedSequence: 2,
    });
    expect(readActionRequest({ action: 'reply', ticketId: T1, body: 'Hi', expectedSequence: -1 })).toBeNull();
    expect(readActionRequest({ action: 'reply', ticketId: T1, body: 'Hi', expectedSequence: 1.5 })).toBeNull();
  });
});
