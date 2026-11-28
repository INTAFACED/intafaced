import { describe, expect, it } from 'vitest';
import { LIST_EVENTS_LIMIT_UNSET, SupportError, SupportService, assertListEventsLimit } from './support-service.js';
import { userCopy } from './user-copy.js';
import { callerAs } from './testing/router-caller.js';

/**
 * events / listTicketEvents page size is refuse-closed when unset.
 *
 * listTicketEvents called store.listEvents(ticketId) with no page, so omit
 * dumped every trail row. Blank must refuse. Owner/client may pass 100
 * explicitly.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OP = '33333333-3333-4333-8333-333333333333';

describe('listTicketEvents limit unset refuse', () => {
  it('assertListEventsLimit refuses blank / NaN / 0 — never invents 100', () => {
    expect(() => assertListEventsLimit(undefined)).toThrow(SupportError);
    expect(() => assertListEventsLimit(Number.NaN)).toThrow(SupportError);
    expect(() => assertListEventsLimit(0)).toThrow(SupportError);
    try {
      assertListEventsLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(SupportError);
      expect((e as SupportError).code).toBe(LIST_EVENTS_LIMIT_UNSET);
      expect((e as SupportError).message).not.toMatch(/100-row|default 100/i);
      expect(userCopy((e as SupportError).code)).toBe(LIST_EVENTS_LIMIT_UNSET);
      expect(userCopy((e as SupportError).code)).not.toMatch(/100-row|default 100/i);
    }
  });

  it('accepts owner-published 100 and caps at existing door max 500', () => {
    expect(assertListEventsLimit(100)).toBe(100);
    expect(assertListEventsLimit(1)).toBe(1);
    expect(assertListEventsLimit(500)).toBe(500);
    expect(assertListEventsLimit(501)).toBe(500);
  });

  it('listTicketEvents omit refuses; explicit 100 pages; never dumps the trail', async () => {
    const svc = new SupportService();
    const ticket = await svc.createTicket({
      userId: USER,
      category: 'other',
      subject: 'S',
      body: 'B',
    });
    await svc.setStatus({ operatorId: OP, ticketId: ticket.id, status: 'pending' });
    await svc.setStatus({ operatorId: OP, ticketId: ticket.id, status: 'resolved' });
    await expect(svc.listTicketEvents({ userId: USER, ticketId: ticket.id })).rejects.toMatchObject({
      code: LIST_EVENTS_LIMIT_UNSET,
    });
    await expect(svc.listTicketEvents({ userId: USER, ticketId: ticket.id, limit: undefined })).rejects.toMatchObject({
      code: LIST_EVENTS_LIMIT_UNSET,
    });
    const page = await svc.listTicketEvents({ userId: USER, ticketId: ticket.id, limit: 100 });
    expect(page).toHaveLength(3);
    const one = await svc.listTicketEvents({ userId: USER, ticketId: ticket.id, limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.kind).toBe('opened');
  });

  it('the events door refuses an omitted limit by name and pages an explicit one; it never dumps the trail', async () => {
    const svc = new SupportService();
    const ticket = await svc.createTicket({ userId: USER, category: 'other', subject: 'S', body: 'B' });
    await svc.setStatus({ operatorId: OP, ticketId: ticket.id, status: 'pending' });
    await svc.setStatus({ operatorId: OP, ticketId: ticket.id, status: 'resolved' });
    const me = await callerAs(svc, USER, ['support:read', 'support:write']);
    await expect(me.events({ ticketId: ticket.id })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: userCopy(LIST_EVENTS_LIMIT_UNSET),
    });
    expect(await me.events({ ticketId: ticket.id, limit: 100 })).toHaveLength(3);
    const one = await me.events({ ticketId: ticket.id, limit: 1 });
    expect(one.map((e) => e.kind)).toEqual(['opened']);
  });
});
