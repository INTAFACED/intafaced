import { describe, expect, it } from 'vitest';
import { LIST_ALL_LIMIT_UNSET, SupportError, SupportService, assertListAllTicketsLimit } from './support-service.js';
import { userCopy } from './user-copy.js';
import { callerAs } from './testing/router-caller.js';

/**
 * listAll page size is refuse-closed when unset.
 *
 * listAllTickets called store.listAll() with no page, so omit dumped every
 * ticket. Blank must refuse. Owner/client may pass 100 explicitly.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '33333333-3333-4333-8333-333333333333';

describe('listAll limit unset refuse', () => {
  it('assertListAllTicketsLimit refuses blank / NaN / 0 — never invents 100', () => {
    expect(() => assertListAllTicketsLimit(undefined)).toThrow(SupportError);
    expect(() => assertListAllTicketsLimit(Number.NaN)).toThrow(SupportError);
    expect(() => assertListAllTicketsLimit(0)).toThrow(SupportError);
    try {
      assertListAllTicketsLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(SupportError);
      expect((e as SupportError).code).toBe(LIST_ALL_LIMIT_UNSET);
      expect((e as SupportError).message).not.toMatch(/100-row|default 100/i);
      expect(userCopy((e as SupportError).code)).toBe(LIST_ALL_LIMIT_UNSET);
      expect(userCopy((e as SupportError).code)).not.toMatch(/100-row|default 100/i);
    }
  });

  it('accepts owner-published 100 and caps at existing door max 500', () => {
    expect(assertListAllTicketsLimit(100)).toBe(100);
    expect(assertListAllTicketsLimit(1)).toBe(1);
    expect(assertListAllTicketsLimit(500)).toBe(500);
    expect(assertListAllTicketsLimit(501)).toBe(500);
  });

  it('listAllTickets omit refuses; explicit 100 pages; never dumps the table', async () => {
    const svc = new SupportService();
    for (let i = 0; i < 3; i += 1) {
      await svc.createTicket({
        userId: USER,
        category: 'other',
        subject: `S${i}`,
        body: 'B',
      });
    }
    await expect(svc.listAllTickets()).rejects.toMatchObject({ code: LIST_ALL_LIMIT_UNSET });
    await expect(svc.listAllTickets({})).rejects.toMatchObject({ code: LIST_ALL_LIMIT_UNSET });
    const page = await svc.listAllTickets({ limit: 100 });
    expect(page).toHaveLength(3);
    const one = await svc.listAllTickets({ limit: 1 });
    expect(one).toHaveLength(1);
  });

  it('the listAll door refuses an omitted limit by name and pages an explicit one; it never dumps the table', async () => {
    const svc = new SupportService();
    for (let i = 0; i < 3; i += 1) {
      await svc.createTicket({ userId: USER, category: 'other', subject: `S${i}`, body: 'B' });
    }
    const desk = await callerAs(svc, OPERATOR, ['support:ops', 'support:read', 'support:write']);
    for (const input of [undefined, {}]) {
      await expect(desk.listAll(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: userCopy(LIST_ALL_LIMIT_UNSET) });
    }
    expect(await desk.listAll({ limit: 100 })).toHaveLength(3);
    expect(await desk.listAll({ limit: 1 })).toHaveLength(1);
  });
});
