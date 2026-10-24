import { describe, expect, it } from 'vitest';
import { SupportService } from './support-service.js';
import { withTestCommentCap } from './comment-cap.fixture.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const OP = '33333333-3333-4333-8333-333333333333';

/**
 * The lifecycle table already names `resolved → open` as the "not fixed" path.
 * Until this residual, only operator `setStatus` walked that edge. A user
 * reply left the ticket `resolved`, so it never re-entered the unassigned
 * queue — a comment nobody would pick up.
 */
describe('a user reply on resolved reopens the same ticket', () => {
  async function resolvedTicket(svc = withTestCommentCap()) {
    const ticket = await svc.createTicket({
      userId: USER,
      category: 'account',
      subject: 'Cannot sign in',
      body: 'Details',
    });
    await svc.claimForOperator({ operatorId: OP, ticketId: ticket.id });
    await svc.setStatus({ operatorId: OP, ticketId: ticket.id, status: 'resolved' });
    return { svc, ticket };
  }

  it('reopens onto the same id, clears the assignee, and returns to the queue', async () => {
    const { svc, ticket } = await resolvedTicket();

    const before = await svc.listOperatorQueue({ limit: 100 });
    expect(before.status).toBe('empty');

    const comment = await svc.comment({ userId: USER, ticketId: ticket.id, body: 'This is not fixed.' });
    expect(comment.authorRole).toBe('user');
    expect(comment.ticketId).toBe(ticket.id);

    const again = await svc.getTicket({ userId: USER, ticketId: ticket.id });
    expect(again.id).toBe(ticket.id);
    expect(again.status).toBe('open');
    expect(again.assigneeId).toBeNull();

    const q = await svc.listOperatorQueue({ limit: 100 });
    expect(q.status).toBe('ok');
    if (q.status !== 'ok') return;
    expect(q.entries.map((e) => e.ticketId)).toEqual([ticket.id]);
  });

  it('records resolved → open on the trail as the user, not as a silent operator', async () => {
    const { svc, ticket } = await resolvedTicket();
    await svc.comment({ userId: USER, ticketId: ticket.id, body: 'Still broken.' });

    const trail = await svc.listTicketEvents({ userId: USER, ticketId: ticket.id, limit: 100 });
    const reopens = trail.filter((e) => e.kind === 'status_changed' && e.fromStatus === 'resolved' && e.toStatus === 'open');
    expect(reopens).toHaveLength(1);
    expect(reopens[0]).toMatchObject({
      actorId: USER,
      actorRole: 'user',
      note: 'user_reply_reopen',
    });
  });

  it('keeps the earlier comments — reopen is not a second ticket', async () => {
    const svc = withTestCommentCap();
    const ticket = await svc.createTicket({ userId: USER, category: 'account', subject: 'Cannot sign in', body: 'Details' });
    await svc.comment({ userId: USER, ticketId: ticket.id, body: 'More context before resolve.' });
    await svc.setStatus({ operatorId: OP, ticketId: ticket.id, status: 'resolved' });
    await svc.comment({ userId: USER, ticketId: ticket.id, body: 'Not fixed.' });
    const thread = await svc.listComments({ userId: USER, ticketId: ticket.id, limit: 100 });
    expect(thread.map((c) => c.body)).toEqual(['More context before resolve.', 'Not fixed.']);
    expect((await svc.getTicket({ userId: USER, ticketId: ticket.id })).status).toBe('open');
  });

  it('an operator note on resolved does not reopen and does not invent queue work', async () => {
    const { svc, ticket } = await resolvedTicket();
    await svc.comment({ userId: OP, ticketId: ticket.id, body: 'Closing note.', asOperator: true });
    const still = await svc.getTicket({ userId: USER, ticketId: ticket.id });
    expect(still.status).toBe('resolved');
    expect(await svc.listOperatorQueue({ limit: 100 })).toEqual({ status: 'empty' });
  });
});

describe('a user cannot grow a closed ticket', () => {
  it('refuses the owner with a code, and stores no comment', async () => {
    const svc = withTestCommentCap();
    const ticket = await svc.createTicket({ userId: USER, category: 'other', subject: 'Q', body: 'B' });
    await svc.setStatus({ operatorId: OP, ticketId: ticket.id, status: 'closed' });

    await expect(svc.comment({ userId: USER, ticketId: ticket.id, body: 'Please reopen.' })).rejects.toMatchObject({
      code: 'support.comment.terminal',
    });
    expect(await svc.listComments({ userId: USER, ticketId: ticket.id, limit: 100 })).toHaveLength(0);
    expect((await svc.getTicket({ userId: USER, ticketId: ticket.id })).status).toBe('closed');
  });

  it('still answers a stranger with not_found — terminal is not an existence leak', async () => {
    const svc = withTestCommentCap();
    const ticket = await svc.createTicket({ userId: USER, category: 'other', subject: 'Q', body: 'B' });
    await svc.setStatus({ operatorId: OP, ticketId: ticket.id, status: 'closed' });

    const foreign = await svc.comment({ userId: OTHER, ticketId: ticket.id, body: 'x' }).catch((e: Error) => e);
    const missing = await svc
      .comment({ userId: OTHER, ticketId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', body: 'x' })
      .catch((e: Error) => e);
    expect(foreign).toMatchObject({ code: 'support.not_found' });
    expect(missing).toMatchObject({ code: 'support.not_found' });
    expect((foreign as Error).message).toBe((missing as Error).message);
  });

  it('lets an operator annotate a closed ticket without reopening it', async () => {
    const svc = withTestCommentCap();
    const ticket = await svc.createTicket({ userId: USER, category: 'other', subject: 'Q', body: 'B' });
    await svc.setStatus({ operatorId: OP, ticketId: ticket.id, status: 'closed' });
    await expect(svc.comment({ userId: OP, ticketId: ticket.id, body: 'Filed for retention.', asOperator: true })).resolves.toMatchObject({
      authorRole: 'operator',
    });
    expect((await svc.getTicket({ userId: USER, ticketId: ticket.id })).status).toBe('closed');
  });
});
