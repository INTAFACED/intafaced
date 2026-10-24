import { describe, expect, it } from 'vitest';
import { SupportError, SupportService, assertOperatorQueueLimit } from './support-service.js';
import { withTestCommentCap } from './comment-cap.fixture.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const OP = '33333333-3333-4333-8333-333333333333';

describe('SupportService Stage-1', () => {
  it('creates and lists tickets for the owner only', async () => {
    const svc = new SupportService();
    const t = await svc.createTicket({
      userId: USER,
      category: 'account',
      subject: 'Cannot sign in',
      body: 'Reset help please',
    });
    expect(t.status).toBe('open');
    expect(t.assigneeId).toBeNull();
    // no money fields
    expect(t).not.toHaveProperty('balance');
    expect(t).not.toHaveProperty('refundAmount');

    expect(await svc.listMyTickets({ userId: USER, limit: 100 })).toHaveLength(1);
    expect(await svc.listMyTickets({ userId: OTHER, limit: 100 })).toHaveLength(0);
  });

  it('hides other users tickets from non-operators', async () => {
    const svc = new SupportService();
    const t = await svc.createTicket({
      userId: USER,
      category: 'other',
      subject: 'Q',
      body: 'B',
    });
    await expect(svc.getTicket({ userId: OTHER, ticketId: t.id })).rejects.toMatchObject({
      code: 'support.not_found',
    });
    await expect(svc.getTicket({ userId: OP, ticketId: t.id, asOperator: true })).resolves.toMatchObject({
      id: t.id,
    });
  });

  it('comments and status without any ledger side effects', async () => {
    const svc = withTestCommentCap();
    const t = await svc.createTicket({
      userId: USER,
      category: 'trading',
      subject: 'Order stuck',
      body: 'Details',
    });
    const c = await svc.comment({ userId: USER, ticketId: t.id, body: 'More info' });
    expect(c.authorRole).toBe('user');
    const thread = await svc.listComments({ userId: USER, ticketId: t.id, limit: 100 });
    expect(thread).toHaveLength(1);
    expect(thread[0]!.id).toBe(c.id);
    await expect(svc.listComments({ userId: OTHER, ticketId: t.id, limit: 100 })).rejects.toMatchObject({
      code: 'support.not_found',
    });
    const all = await svc.listAllTickets({ limit: 100 });
    expect(all).toHaveLength(1);
    const resolved = await svc.setStatus({ operatorId: OP, ticketId: t.id, status: 'resolved' });
    expect(resolved.status).toBe('resolved');
  });

  it('lists Stage-2 platform KB spine (i18n keys only)', async () => {
    const svc = new SupportService();
    const kb = await svc.listKb({ limit: 100 });
    expect(kb.length).toBeGreaterThanOrEqual(5);
    expect(kb.every((a) => a.titleKey.startsWith('support.kb.'))).toBe(true);
    expect(kb.every((a) => a.published === true && typeof a.revision === 'number' && a.revision >= 1)).toBe(true);
    expect(kb.every((a) => typeof a.version === 'number' && a.version >= 1)).toBe(true);
    expect(kb[0]).not.toHaveProperty('balance');
  });
});

describe('SupportService Stage-2 operator queue', () => {
  it('listOperatorQueue ranks deposit_withdraw above other and skips closed', async () => {
    const svc = new SupportService();
    const closed = await svc.createTicket({
      userId: USER,
      category: 'deposit_withdraw',
      subject: 'Closed dep',
      body: 'B',
    });
    await svc.setStatus({ operatorId: OP, ticketId: closed.id, status: 'closed' });
    const other = await svc.createTicket({
      userId: USER,
      category: 'other',
      subject: 'Low',
      body: 'B',
    });
    const dep = await svc.createTicket({
      userId: USER,
      category: 'deposit_withdraw',
      subject: 'High',
      body: 'B',
    });

    const q = await svc.listOperatorQueue({ limit: 100 });
    expect(q.status).toBe('ok');
    if (q.status !== 'ok') return;
    expect(q.entries.map((e) => e.ticketId)).toEqual([dep.id, other.id]);
    expect(q.entries[0]!).not.toHaveProperty('balance');
    expect(q.entries[0]!).not.toHaveProperty('refundAmount');
    expect(q.entries[0]!).toMatchObject({ timingKind: 'score_not_promise', sla: false });
    expect(q.entries[0]!).not.toHaveProperty('slaMinutes');
  });

  it('refuses listOperatorQueue without limit — never invents 100', async () => {
    const svc = new SupportService();
    await expect(svc.listOperatorQueue()).rejects.toMatchObject({
      code: 'support.queue_list_limit_unset',
    });
    expect(assertOperatorQueueLimit(100)).toBe(100);
    const empty = await svc.listOperatorQueue({ limit: 100 });
    expect(empty).toEqual({ status: 'empty' });
    await expect(svc.listOperatorQueue()).rejects.toBeInstanceOf(SupportError);
  });

  it('peekNext and claimForOperator — exclusive claim, refuse steal', async () => {
    const svc = new SupportService();
    expect(await svc.peekNext()).toBeNull();

    const t = await svc.createTicket({
      userId: USER,
      category: 'account',
      subject: 'Need help',
      body: 'Details',
    });
    const next = await svc.peekNext();
    expect(next?.ticketId).toBe(t.id);

    const claimed = await svc.claimForOperator({ operatorId: OP, ticketId: t.id });
    expect(claimed.assigneeId).toBe(OP);
    expect(claimed.status).toBe('pending');
    expect(claimed).not.toHaveProperty('balance');

    // idempotent same operator
    await expect(svc.claimForOperator({ operatorId: OP, ticketId: t.id })).resolves.toMatchObject({
      assigneeId: OP,
    });

    await expect(svc.claimForOperator({ operatorId: OTHER, ticketId: t.id })).rejects.toMatchObject({
      code: 'support.claim.already_claimed',
    });
  });

  it('claim refuses missing and non-queueable tickets', async () => {
    const svc = new SupportService();
    const t = await svc.createTicket({
      userId: USER,
      category: 'other',
      subject: 'Q',
      body: 'B',
    });
    await svc.setStatus({ operatorId: OP, ticketId: t.id, status: 'resolved' });
    await expect(svc.claimForOperator({ operatorId: OP, ticketId: t.id })).rejects.toMatchObject({
      code: 'support.claim.not_queueable',
    });
    await expect(svc.claimForOperator({ operatorId: OP, ticketId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })).rejects.toMatchObject({
      code: 'support.claim.not_found',
    });
  });
});

/**
 * "Somebody else's ticket" and "no such ticket" must be the SAME answer.
 *
 * Answering a foreign ticket with `not_found` rather than a forbidden is a
 * deliberate choice, and it only works if the two are indistinguishable. They
 * were not: the missing case interpolated the id and the foreign case did not,
 * and `mapError` puts i18n `userCopy(err.code)` on the wire — so a caller could ask about
 * any id and read its existence off whether the id came back.
 */
describe('a foreign ticket is indistinguishable from a missing one', () => {
  const MISSING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  async function ownedTicket() {
    const svc = new SupportService();
    const ticket = await svc.createTicket({ userId: USER, category: 'other', subject: 'Q', body: 'B' });
    return { svc, ticket };
  }

  it('refuses both with a byte-identical message and code', async () => {
    const { svc, ticket } = await ownedTicket();

    const foreign = await svc.getTicket({ userId: OTHER, ticketId: ticket.id }).catch((e: Error) => e);
    const missing = await svc.getTicket({ userId: OTHER, ticketId: MISSING }).catch((e: Error) => e);

    expect(foreign).toBeInstanceOf(Error);
    expect(missing).toBeInstanceOf(Error);
    // The whole property, in one line: nothing about the two refusals differs.
    expect((foreign as Error).message).toBe((missing as Error).message);
    expect(foreign).toMatchObject({ code: 'support.not_found' });
    expect(missing).toMatchObject({ code: 'support.not_found' });
  });

  it('never echoes the ticket id back — an echoed id is an id confirmed to exist', async () => {
    const { svc, ticket } = await ownedTicket();

    for (const id of [ticket.id, MISSING]) {
      const err = (await svc.getTicket({ userId: OTHER, ticketId: id }).catch((e: Error) => e)) as Error;
      expect(err.message).not.toContain(id);
    }

    // setStatus is operator-only but reads the same table and used to echo too.
    const status = (await svc.setStatus({ operatorId: OP, ticketId: MISSING, status: 'resolved' }).catch((e: Error) => e)) as Error;
    expect(status.message).not.toContain(MISSING);
  });

  it('holds on the paths that reach getTicket indirectly', async () => {
    const { svc, ticket } = await ownedTicket();

    // comment and listComments both route through getTicket, so they inherit
    // the check — asserted rather than assumed, because "it inherits it" is
    // exactly the sentence that stops being true after a refactor.
    for (const call of [
      () => svc.comment({ userId: OTHER, ticketId: ticket.id, body: 'x' }),
      () => svc.listComments({ userId: OTHER, ticketId: ticket.id, limit: 100 }),
    ]) {
      const err = (await call().catch((e: Error) => e)) as Error;
      expect(err).toMatchObject({ code: 'support.not_found' });
      expect(err.message).not.toContain(ticket.id);
    }
  });
});

/**
 * The operator bypass, executed.
 *
 * `asOperator` is the flag that decides whether a caller may read another
 * user's ticket. Before this, no test invoked the router handlers that compute
 * it, and the service-level tests covered only the refusal — so the line that
 * grants the bypass, and the line that withholds it on the indirect paths, ran
 * in no test at all.
 */
describe('the operator bypass', () => {
  it('grants an operator every path a user is refused', async () => {
    const svc = new SupportService();
    const ticket = await svc.createTicket({ userId: USER, category: 'other', subject: 'Q', body: 'B' });

    await expect(svc.getTicket({ userId: OP, ticketId: ticket.id, asOperator: true })).resolves.toMatchObject({
      id: ticket.id,
    });
    await expect(svc.comment({ userId: OP, ticketId: ticket.id, body: 'looking into it', asOperator: true })).resolves.toMatchObject({
      authorRole: 'operator',
    });
    await expect(svc.listComments({ userId: OP, ticketId: ticket.id, asOperator: true, limit: 100 })).resolves.toHaveLength(1);
  });

  it('does not turn a missing ticket into a readable one', async () => {
    const svc = new SupportService();
    // The bypass skips the OWNERSHIP check, not existence. An operator asking
    // for a ticket that is not there gets the same refusal as anyone else.
    const err = (await svc
      .getTicket({ userId: OP, ticketId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', asOperator: true })
      .catch((e: Error) => e)) as Error;
    expect(err).toMatchObject({ code: 'support.not_found' });
  });

  it('a falsy asOperator is not a bypass', async () => {
    const svc = new SupportService();
    const ticket = await svc.createTicket({ userId: USER, category: 'other', subject: 'Q', body: 'B' });

    for (const asOperator of [false, undefined]) {
      await expect(svc.getTicket({ userId: OTHER, ticketId: ticket.id, asOperator })).rejects.toMatchObject({
        code: 'support.not_found',
      });
    }
  });
});

describe('SupportService cannot settle', () => {
  it('refuses complete_withdrawal, unfreeze_account, and move_money', async () => {
    const svc = new SupportService();
    for (const act of ['complete_withdrawal', 'unfreeze_account', 'move_money'] as const) {
      await expect(svc.attemptSettlement({ operatorId: OP, act })).rejects.toMatchObject({
        code: 'support.settle.refused',
      });
    }
  });

  it('refuses resolving a deposit_withdraw ticket and writes no trail', async () => {
    const svc = new SupportService();
    const t = await svc.createTicket({
      userId: USER,
      category: 'deposit_withdraw',
      subject: 'Where is my withdrawal',
      body: 'Please complete it',
    });
    await expect(svc.setStatus({ operatorId: OP, ticketId: t.id, status: 'resolved' })).rejects.toMatchObject({
      code: 'support.settle.refused',
    });
    const trail = await svc.listTicketEvents({ userId: USER, ticketId: t.id, limit: 100 });
    expect(trail.map((e) => e.kind)).toEqual(['opened']);
    expect((await svc.getTicket({ userId: USER, ticketId: t.id })).status).toBe('open');
  });

  it('refuses a resolve whose note claims a payout', async () => {
    const svc = new SupportService();
    const t = await svc.createTicket({ userId: USER, category: 'other', subject: 'Q', body: 'B' });
    await expect(svc.setStatus({ operatorId: OP, ticketId: t.id, status: 'resolved', note: 'refunded via pay' })).rejects.toMatchObject({
      code: 'support.settle.refused',
    });
  });

  it('refuses resolving after a money_request escalation', async () => {
    const svc = new SupportService();
    const t = await svc.createTicket({ userId: USER, category: 'account', subject: 'Refund', body: 'Please' });
    await svc.escalate({
      operatorId: OP,
      ticketId: t.id,
      reason: 'money_request',
      summary: 'User asked for a payout.',
      citedArticleIds: ['kb-deposit-withdraw-honest'],
    });
    await expect(svc.setStatus({ operatorId: OP, ticketId: t.id, status: 'resolved' })).rejects.toMatchObject({
      code: 'support.settle.refused',
    });
  });

  it('refuses resolved and closed when a later technical file follows money_request', async () => {
    const svc = new SupportService();
    for (const status of ['resolved', 'closed'] as const) {
      const t = await svc.createTicket({ userId: USER, category: 'account', subject: 'Refund', body: 'Please' });
      await svc.escalate({
        operatorId: OP,
        ticketId: t.id,
        reason: 'money_request',
        summary: 'User asked for a payout.',
        citedArticleIds: ['kb-deposit-withdraw-honest'],
      });
      await svc.escalate({
        operatorId: OP,
        ticketId: t.id,
        reason: 'technical',
        summary: 'Later file names a different reason.',
        citedArticleIds: ['kb-deposit-withdraw-honest'],
      });
      await expect(svc.setStatus({ operatorId: OP, ticketId: t.id, status })).rejects.toMatchObject({
        code: 'support.settle.refused',
      });
      expect((await svc.getTicket({ userId: USER, ticketId: t.id })).status).toBe('open');
    }
  });

  it('can still cite KB articles and close a deposit_withdraw ticket without paying', async () => {
    const svc = new SupportService();
    const articles = await svc.searchKb('deposit', { limit: 100 });
    expect(articles.some((a) => a.id === 'kb-deposit-withdraw-honest')).toBe(true);
    const t = await svc.createTicket({
      userId: USER,
      category: 'deposit_withdraw',
      subject: 'Where is my withdrawal',
      body: 'Please complete it',
    });
    const closed = await svc.setStatus({
      operatorId: OP,
      ticketId: t.id,
      status: 'closed',
      note: 'cited kb-deposit-withdraw-honest',
    });
    expect(closed.status).toBe('closed');
  });
});
