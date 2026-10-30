import { describe, expect, it } from 'vitest';
import { SupportService } from './support-service.js';

/**
 * J-support-public-10 #4 and #8 (SP-tickets-09): an agent claims the queue's next request, and a reply written while
 * someone else moved the request on is refused as stale, writing nothing.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OP = '33333333-3333-4333-8333-333333333333';
const OTHER_OP = '44444444-4444-4444-8444-444444444444';

const open = (svc: SupportService, subject: string, category: 'account' | 'other' = 'account') =>
  svc.createTicket({ userId: USER, category, subject, body: 'TEST' });

describe('claimNext', () => {
  it('claims the request the queue ranks first, and refuses an empty queue with a typed code', async () => {
    const svc = new SupportService();
    await expect(svc.claimNext(OP)).rejects.toMatchObject({ code: 'support.claim.queue_empty' });
    await open(svc, 'TEST low', 'other');
    const high = await open(svc, 'TEST high', 'account');
    expect((await svc.peekNext(OP))?.ticketId).toBe(high.id);
    const claimed = await svc.claimNext(OP);
    expect(claimed).toMatchObject({ id: high.id, assigneeId: OP, status: 'pending' });
    expect((await svc.getTicket({ userId: OP, ticketId: high.id, asOperator: true })).assigneeId).toBe(OP);
  });

  it('never takes a request another agent holds: the second claim gets the next free one, then the empty refusal', async () => {
    const svc = new SupportService();
    const only = await open(svc, 'TEST only');
    expect((await svc.claimNext(OP)).id).toBe(only.id);
    await expect(svc.claimNext(OTHER_OP)).rejects.toMatchObject({ code: 'support.claim.queue_empty' });
    expect((await svc.getTicket({ userId: OP, ticketId: only.id, asOperator: true })).assigneeId).toBe(OP);
  });

  it('skips a row that is claimed between the read and the claim, and claims the next one', async () => {
    const svc = new SupportService();
    const first = await open(svc, 'TEST first', 'account');
    const second = await open(svc, 'TEST second', 'other');
    const store = (svc as unknown as { store: { claimTicket: (i: { ticketId: string; operatorId: string }) => Promise<unknown> } }).store;
    const real = store.claimTicket.bind(store);
    let raced = false;
    store.claimTicket = async (input) => {
      if (!raced) {
        raced = true;
        await real({ ticketId: input.ticketId, operatorId: OTHER_OP });
      }
      return real(input);
    };
    const claimed = await svc.claimNext(OP);
    expect(claimed.id).toBe(second.id);
    expect((await svc.getTicket({ userId: OP, ticketId: first.id, asOperator: true })).assigneeId).toBe(OTHER_OP);
  });
});

describe('a reply after someone else moved the request', () => {
  it('refuses support.stale_ticket and writes nothing; after reading the new rows it goes through once', async () => {
    const svc = new SupportService();
    const t = await open(svc, 'TEST stale');
    await svc.claimForOperator({ operatorId: OP, ticketId: t.id });
    const seen = (await svc.listTicketEvents({ userId: OP, ticketId: t.id, asOperator: true, limit: 100 })).at(-1)!.sequence;
    await svc.setStatus({ operatorId: OTHER_OP, ticketId: t.id, status: 'on_hold', note: 'TEST waiting on a document' });
    const reply = { userId: OP, ticketId: t.id, body: 'TEST answer', asOperator: true };
    await expect(svc.comment({ ...reply, expectedSequence: seen })).rejects.toMatchObject({ code: 'support.stale_ticket' });
    expect(await svc.listComments({ userId: OP, ticketId: t.id, asOperator: true, limit: 100 })).toHaveLength(0);
    const events = await svc.listTicketEvents({ userId: OP, ticketId: t.id, asOperator: true, limit: 100 });
    const newer = events.filter((row) => row.sequence > seen);
    expect(newer).toMatchObject([{ kind: 'status_changed', actorId: OTHER_OP, toStatus: 'on_hold' }]);
    expect((await svc.getTicket({ userId: OP, ticketId: t.id, asOperator: true })).status).toBe('on_hold');

    await svc.comment({ ...reply, expectedSequence: events.at(-1)!.sequence });
    expect(await svc.listComments({ userId: OP, ticketId: t.id, asOperator: true, limit: 100 })).toMatchObject([{ body: 'TEST answer' }]);
  });

  it("the agent's own newer rows (after the customer's opening row, #1) do not make the reply stale", async () => {
    const svc = new SupportService();
    const t = await open(svc, 'TEST own rows');
    await svc.claimForOperator({ operatorId: OP, ticketId: t.id });
    await svc.setStatus({ operatorId: OP, ticketId: t.id, status: 'on_hold', note: 'TEST mine' });
    await svc.comment({ userId: OP, ticketId: t.id, body: 'TEST answer', asOperator: true, expectedSequence: 1 });
    expect(await svc.listComments({ userId: OP, ticketId: t.id, asOperator: true, limit: 100 })).toHaveLength(1);
  });
  it("does not count another agent's account read as a change", async () => {
    const svc = new SupportService();
    const t = await open(svc, 'TEST read only');
    const claimed = await svc.claimForOperator({ operatorId: OP, ticketId: t.id });
    const seen = Math.max(
      ...(await svc.listTicketEvents({ userId: OP, ticketId: t.id, asOperator: true, limit: 100 })).map((e) => e.sequence),
    );
    const store = (svc as unknown as { store: { appendEvent: (i: Record<string, unknown>) => Promise<unknown> } }).store;
    await store.appendEvent({
      ticketId: t.id,
      kind: 'grounding_read',
      actorId: OTHER_OP,
      actorRole: 'operator',
      note: 'unread:plane_dark',
    });
    expect(claimed.assigneeId).toBe(OP);
    await svc.comment({ userId: OP, ticketId: t.id, body: 'TEST answer', asOperator: true, expectedSequence: seen });
    expect(await svc.listComments({ userId: OP, ticketId: t.id, asOperator: true, limit: 100 })).toHaveLength(1);
  });
});

describe('a status or property change after someone else moved the request', () => {
  const trail = (svc: SupportService, ticketId: string) => svc.listTicketEvents({ userId: OP, ticketId, asOperator: true, limit: 100 });

  it('a status change naming an older row refuses support.stale_ticket and changes nothing', async () => {
    const svc = new SupportService();
    const t = await open(svc, 'TEST stale status');
    await svc.claimForOperator({ operatorId: OP, ticketId: t.id });
    const seen = (await trail(svc, t.id)).at(-1)!.sequence;
    await svc.setStatus({ operatorId: OTHER_OP, ticketId: t.id, status: 'on_hold', note: 'TEST other' });
    const before = await trail(svc, t.id);
    await expect(svc.setStatus({ operatorId: OP, ticketId: t.id, status: 'resolved', expectedSequence: seen })).rejects.toMatchObject({
      code: 'support.stale_ticket',
    });
    expect(await trail(svc, t.id)).toEqual(before);
    expect((await svc.getTicket({ userId: OP, ticketId: t.id, asOperator: true })).status).toBe('on_hold');
    await svc.setStatus({ operatorId: OP, ticketId: t.id, status: 'resolved', expectedSequence: before.at(-1)!.sequence });
    expect((await svc.getTicket({ userId: OP, ticketId: t.id, asOperator: true })).status).toBe('resolved');
  });

  it('a property change naming an older row refuses support.stale_ticket and writes no log row', async () => {
    const svc = new SupportService();
    const t = await open(svc, 'TEST stale props');
    await svc.claimForOperator({ operatorId: OP, ticketId: t.id });
    const seen = (await trail(svc, t.id)).at(-1)!.sequence;
    await svc.setStatus({ operatorId: OTHER_OP, ticketId: t.id, status: 'on_hold', note: 'TEST other' });
    await expect(
      svc.setTicketProperties({ operatorId: OP, ticketId: t.id, labels: ['vip'], clientRequestId: 'TEST-props-1', expectedSequence: seen }),
    ).rejects.toMatchObject({ code: 'support.stale_ticket' });
    expect(await svc.listTicketPropertyChanges({ operatorId: OP, ticketId: t.id, limit: 50 })).toHaveLength(0);
    const latest = (await trail(svc, t.id)).at(-1)!.sequence;
    const saved = await svc.setTicketProperties({
      operatorId: OP,
      ticketId: t.id,
      labels: ['vip'],
      clientRequestId: 'TEST-props-2',
      expectedSequence: latest,
    });
    expect(saved.labels).toEqual(['vip']);
  });

  it('a repeated reply request id answers its stored comment before the sequence is checked', async () => {
    const svc = new SupportService();
    const t = await open(svc, 'TEST replay first');
    await svc.claimForOperator({ operatorId: OP, ticketId: t.id });
    const seen = (await trail(svc, t.id)).at(-1)!.sequence;
    const reply = {
      userId: OP,
      ticketId: t.id,
      body: 'TEST answer',
      asOperator: true,
      clientRequestId: 'TEST-reply-1',
      expectedSequence: seen,
    };
    const first = await svc.comment(reply);
    await svc.setStatus({ operatorId: OTHER_OP, ticketId: t.id, status: 'on_hold', note: 'TEST other' });
    expect(await svc.comment(reply)).toEqual(first);
    expect(await svc.listComments({ userId: OP, ticketId: t.id, asOperator: true, limit: 100 })).toHaveLength(1);
  });
});
