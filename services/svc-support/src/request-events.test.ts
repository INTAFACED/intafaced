import { EVENT_CATALOG } from '@intafaced/events';
import { describe, expect, it } from 'vitest';
import { MemoryRequestEventBook, RequestEventOutbox, eventRequestEventSink, rowToEvent, type RequestEvent } from './request-events.js';

const T = '9f1b6c52-0d9e-4c55-8a53-0d3a5f0b7a11';
const U = '11111111-1111-4111-8111-111111111111';
const M = '22222222-2222-4222-8222-222222222222';

const OPENED: RequestEvent = {
  key: `support.ticket.opened:${T}`,
  name: 'supportTicketOpened',
  ticketId: T,
  userId: U,
  occurredAt: '2026-10-22T07:00:00.000Z',
};
const UPDATED: RequestEvent = {
  key: `support.ticket.updated:${T}:pending:1`,
  name: 'supportTicketUpdated',
  ticketId: T,
  userId: U,
  status: 'pending',
  occurredAt: '2026-10-22T07:01:00.000Z',
};
const MESSAGE: RequestEvent = {
  key: `support.message.created:${M}`,
  name: 'supportMessageCreated',
  ticketId: T,
  userId: U,
  messageId: M,
  authorRole: 'operator',
  occurredAt: '2026-10-22T07:02:00.000Z',
};

function capture() {
  const seen: { name: string; payload: unknown; key: string }[] = [];
  const bus = {
    publish: async (name: string, payload: unknown, opts: { idempotencyKey: string }) =>
      void seen.push({ name, payload, key: opts.idempotencyKey }),
  };
  return { seen, sink: eventRequestEventSink(bus as never) };
}

describe('request notification outbox (SP-email-01)', () => {
  it('publishes each pending row once, oldest first, under its business key', async () => {
    const book = new MemoryRequestEventBook();
    book.add(MESSAGE);
    book.add(OPENED);
    book.add(UPDATED);
    const { seen, sink } = capture();
    const outbox = new RequestEventOutbox(book, async () => sink);
    expect(await outbox.flush()).toBe(3);
    expect(seen.map((s) => s.key)).toEqual([OPENED.key, UPDATED.key, MESSAGE.key]);
    expect(await outbox.flush()).toBe(0);
    expect(seen).toHaveLength(3);
  });

  it('the payloads carry ids, status, role and time only, and each parses against the catalog schema', async () => {
    const { seen, sink } = capture();
    for (const e of [OPENED, UPDATED, MESSAGE]) await sink.send(e);
    expect(seen.map((s) => [s.name, s.payload])).toEqual([
      ['supportTicketOpened', { ticketId: T, userId: U, openedAt: OPENED.occurredAt }],
      ['supportTicketUpdated', { ticketId: T, userId: U, status: 'pending', updatedAt: UPDATED.occurredAt }],
      ['supportMessageCreated', { ticketId: T, messageId: M, userId: U, authorRole: 'operator', createdAt: MESSAGE.occurredAt }],
    ]);
    for (const s of seen) {
      const def = EVENT_CATALOG[s.name as keyof typeof EVENT_CATALOG];
      expect(def.schema.safeParse(s.payload).success).toBe(true);
    }
  });

  it('with no bus the rows stay pending and nothing is claimed sent', async () => {
    const book = new MemoryRequestEventBook();
    book.add(OPENED);
    const outbox = new RequestEventOutbox(book, async () => null);
    expect(await outbox.flush()).toBe(0);
    expect(book.publishedAt(OPENED.key)).toBeNull();
    expect(await book.pending(10)).toHaveLength(1);
  });

  it('a failed publish keeps its row; the retry reuses the same key', async () => {
    const book = new MemoryRequestEventBook();
    book.add(OPENED);
    const keys: string[] = [];
    let fail = true;
    const outbox = new RequestEventOutbox(book, async () => ({
      send: async (e) => {
        keys.push(e.key);
        if (fail) throw new Error('bus down');
      },
    }));
    expect(await outbox.flush()).toBe(0);
    expect(book.publishedAt(OPENED.key)).toBeNull();
    fail = false;
    expect(await outbox.flush()).toBe(1);
    expect(keys).toEqual([OPENED.key, OPENED.key]);
  });

  it('adding the same key twice keeps one row', async () => {
    const book = new MemoryRequestEventBook();
    book.add(OPENED);
    book.add(OPENED);
    expect(await book.pending(10)).toHaveLength(1);
  });

  it('a row whose shape does not fit its name is refused, not guessed at', () => {
    const base = {
      event_key: 'k',
      ticket_id: T,
      user_id: U,
      message_id: null,
      author_role: null,
      occurred_at: new Date('2026-10-22T07:00:00Z'),
    };
    expect(() => rowToEvent({ ...base, event_name: 'supportTicketUpdated', status: 'archived' })).toThrow(
      'support.event_outbox_row_invalid',
    );
    expect(() => rowToEvent({ ...base, event_name: 'supportMessageCreated', status: null })).toThrow('support.event_outbox_row_invalid');
  });
});
