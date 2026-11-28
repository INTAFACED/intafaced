import { describe, expect, it } from 'vitest';
import { LIST_COMMENTS_LIMIT_UNSET, SupportError, assertListCommentsLimit } from './support-service.js';
import { userCopy } from './user-copy.js';
import { withTestCommentCap } from './comment-cap.fixture.js';
import { callerAs } from './testing/router-caller.js';

/**
 * listComments page size is refuse-closed when unset.
 *
 * listComments called store.listComments(ticketId) with no page, so omit
 * dumped every comment on the ticket. Blank must refuse. Owner/client may
 * pass 100 explicitly.
 */

const USER = '11111111-1111-4111-8111-111111111111';

describe('listComments limit unset refuse', () => {
  it('assertListCommentsLimit refuses blank / NaN / 0 — never invents 100', () => {
    expect(() => assertListCommentsLimit(undefined)).toThrow(SupportError);
    expect(() => assertListCommentsLimit(Number.NaN)).toThrow(SupportError);
    expect(() => assertListCommentsLimit(0)).toThrow(SupportError);
    try {
      assertListCommentsLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(SupportError);
      expect((e as SupportError).code).toBe(LIST_COMMENTS_LIMIT_UNSET);
      expect((e as SupportError).message).not.toMatch(/100-row|default 100/i);
      expect(userCopy((e as SupportError).code)).toBe(LIST_COMMENTS_LIMIT_UNSET);
      expect(userCopy((e as SupportError).code)).not.toMatch(/100-row|default 100/i);
    }
  });

  it('accepts owner-published 100 and caps at existing door max 500', () => {
    expect(assertListCommentsLimit(100)).toBe(100);
    expect(assertListCommentsLimit(1)).toBe(1);
    expect(assertListCommentsLimit(500)).toBe(500);
    expect(assertListCommentsLimit(501)).toBe(500);
  });

  it('listComments omit refuses; explicit 100 pages; never dumps the thread', async () => {
    const svc = withTestCommentCap();
    const ticket = await svc.createTicket({
      userId: USER,
      category: 'other',
      subject: 'S',
      body: 'B',
    });
    await svc.comment({ userId: USER, ticketId: ticket.id, body: 'c0' });
    await svc.comment({ userId: USER, ticketId: ticket.id, body: 'c1' });
    await svc.comment({ userId: USER, ticketId: ticket.id, body: 'c2' });
    await expect(svc.listComments({ userId: USER, ticketId: ticket.id })).rejects.toMatchObject({
      code: LIST_COMMENTS_LIMIT_UNSET,
    });
    await expect(svc.listComments({ userId: USER, ticketId: ticket.id, limit: undefined })).rejects.toMatchObject({
      code: LIST_COMMENTS_LIMIT_UNSET,
    });
    const page = await svc.listComments({ userId: USER, ticketId: ticket.id, limit: 100 });
    expect(page).toHaveLength(3);
    const one = await svc.listComments({ userId: USER, ticketId: ticket.id, limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.body).toBe('c0');
  });

  it('the listComments door refuses an omitted limit by name and pages an explicit one; it never dumps the thread', async () => {
    const svc = withTestCommentCap();
    const ticket = await svc.createTicket({ userId: USER, category: 'other', subject: 'S', body: 'B' });
    for (const body of ['c0', 'c1', 'c2']) await svc.comment({ userId: USER, ticketId: ticket.id, body });
    const me = await callerAs(svc, USER, ['support:read', 'support:write']);
    await expect(me.listComments({ ticketId: ticket.id })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: userCopy(LIST_COMMENTS_LIMIT_UNSET),
    });
    expect(await me.listComments({ ticketId: ticket.id, limit: 100 })).toHaveLength(3);
    const one = await me.listComments({ ticketId: ticket.id, limit: 1 });
    expect(one.map((c) => c.body)).toEqual(['c0']);
  });
});
