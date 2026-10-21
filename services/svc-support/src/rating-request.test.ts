import { describe, expect, it } from 'vitest';
import { MemoryGroupBook } from './desk-groups.js';
import { MemoryPropertiesBook } from './desk-properties.js';
import { MemoryStaffBook } from './desk-staff.js';
import { MemoryLifecycleBook } from './ticket-lifecycle.js';
import { MemoryRatingRequestBook, RatingRequestOutbox, eventRatingRequestSink, type RatingRequest } from './rating-request.js';
import { SupportService } from './support-service.js';

const AGENT = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const ASK: RatingRequest = { ticketId: '9f1b6c52-0d9e-4c55-8a53-0d3a5f0b7a11', userId: CUSTOMER, resolvedAt: '2026-10-20T10:00:00.000Z' };

function desk(sink: { send(r: RatingRequest): Promise<void> } | null) {
  const book = new MemoryRatingRequestBook();
  const outbox = new RatingRequestOutbox(book, async () => sink);
  const support = new SupportService(
    undefined,
    undefined,
    undefined,
    new MemoryStaffBook(),
    undefined,
    null,
    undefined,
    new MemoryGroupBook(),
    [],
    new MemoryPropertiesBook(),
    new MemoryLifecycleBook(),
    outbox,
  );
  const ticket = () => support.createTicket({ userId: CUSTOMER, category: 'account', subject: 'Help', body: 'Help me please' });
  return { support, book, outbox, ticket };
}

/** The service records and publishes after the status change returns; let that finish. */
const settle = () => new Promise<void>((r) => setTimeout(r, 10));

describe('emailed rating request outbox (SP-csat-01)', () => {
  it('publishes a resolved request once, under the ticket business key', async () => {
    const sent: RatingRequest[] = [];
    const { support, book, outbox, ticket } = desk({ send: async (r) => void sent.push(r) });
    const t = await ticket();
    const done = await support.setStatus({ operatorId: AGENT, ticketId: t.id, status: 'resolved' });
    await settle();
    expect(sent).toEqual([{ ticketId: t.id, userId: CUSTOMER, resolvedAt: done.updatedAt }]);
    expect(await book.pending(10)).toEqual([]);
  });

  it('asks once per ticket: a reopen and a second resolve publish nothing more', async () => {
    const sent: RatingRequest[] = [];
    const { support, ticket } = desk({ send: async (r) => void sent.push(r) });
    const t = await ticket();
    await support.setStatus({ operatorId: AGENT, ticketId: t.id, status: 'resolved' });
    await support.setStatus({ operatorId: AGENT, ticketId: t.id, status: 'open' });
    await support.setStatus({ operatorId: AGENT, ticketId: t.id, status: 'resolved' });
    await settle();
    expect(sent).toHaveLength(1);
  });

  it('other moves (pending, closed) publish nothing', async () => {
    const sent: RatingRequest[] = [];
    const { support, ticket } = desk({ send: async (r) => void sent.push(r) });
    const t = await ticket();
    await support.setStatus({ operatorId: AGENT, ticketId: t.id, status: 'pending' });
    await support.setStatus({ operatorId: AGENT, ticketId: t.id, status: 'closed' });
    await settle();
    expect(sent).toEqual([]);
  });

  it('a failed publish keeps the row, does not fail the status change, and the sweep sends it later', async () => {
    let down = true;
    const sent: RatingRequest[] = [];
    const { support, outbox, book, ticket } = desk({
      send: async (r) => {
        if (down) throw new Error('nats down');
        sent.push(r);
      },
    });
    const t = await ticket();
    const done = await support.setStatus({ operatorId: AGENT, ticketId: t.id, status: 'resolved' });
    expect(done.status).toBe('resolved');
    await settle();
    expect(await book.pending(10)).toHaveLength(1);
    expect(await outbox.flush()).toBe(0);
    down = false;
    expect(await outbox.flush()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(await outbox.flush()).toBe(0);
  });

  it('one failing ask does not hold back the ones behind it', async () => {
    const sent: string[] = [];
    const book = new MemoryRatingRequestBook();
    const outbox = new RatingRequestOutbox(book, async () => ({
      send: async (r) => {
        if (r.ticketId === 'a') throw new Error('rejected');
        sent.push(r.ticketId);
      },
    }));
    await outbox.record({ ...ASK, ticketId: 'a', resolvedAt: '2026-10-20T10:00:00.000Z' });
    await outbox.record({ ...ASK, ticketId: 'b', resolvedAt: '2026-10-20T10:01:00.000Z' });
    expect(await outbox.flush()).toBe(1);
    expect(sent).toEqual(['b']);
    expect((await book.pending(10)).map((r) => r.ticketId)).toEqual(['a']);
  });

  it('with no bus connected the asks stay pending and nothing is claimed sent', async () => {
    const { support, outbox, book, ticket } = desk(null);
    const t = await ticket();
    await support.setStatus({ operatorId: AGENT, ticketId: t.id, status: 'resolved' });
    await settle();
    expect(await outbox.flush()).toBe(0);
    expect(await book.pending(10)).toHaveLength(1);
  });

  it('a crash after publish and before the mark re-publishes under the same key', async () => {
    const keys: string[] = [];
    const bus = { publish: async (_n: string, _p: unknown, o?: { idempotencyKey?: string }) => void keys.push(o?.idempotencyKey ?? '') };
    const sink = eventRatingRequestSink(bus as never);
    await sink.send(ASK);
    await sink.send(ASK);
    expect(keys).toEqual([`support.rating_request:${ASK.ticketId}`, `support.rating_request:${ASK.ticketId}`]);
  });

  it('the bus payload is the ticket, the owner and the resolve time and nothing else', async () => {
    const seen: unknown[] = [];
    const bus = { publish: async (name: string, payload: unknown) => void seen.push([name, payload]) };
    await eventRatingRequestSink(bus as never).send(ASK);
    expect(seen).toEqual([['supportTicketResolved', { ticketId: ASK.ticketId, userId: CUSTOMER, resolvedAt: ASK.resolvedAt }]]);
  });

  it('a bus that was down at the first try is connected on a later sweep', async () => {
    const sent: string[] = [];
    let up = false;
    const book = new MemoryRatingRequestBook();
    const outbox = new RatingRequestOutbox(book, async () => (up ? { send: async (r) => void sent.push(r.ticketId) } : null));
    await outbox.record(ASK);
    expect(await outbox.flush()).toBe(0);
    up = true;
    expect(await outbox.flush()).toBe(1);
    expect(sent).toEqual([ASK.ticketId]);
  });

  it('overlapping sweeps send each ask once', async () => {
    const sent: string[] = [];
    const outbox = new RatingRequestOutbox(new MemoryRatingRequestBook(), async () => ({
      send: async (r) => {
        await settle();
        sent.push(r.ticketId);
      },
    }));
    await outbox.record(ASK);
    await Promise.all([outbox.flush(), outbox.flush()]);
    expect(sent).toEqual([ASK.ticketId]);
  });
});
