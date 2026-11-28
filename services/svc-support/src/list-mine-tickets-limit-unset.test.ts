import { describe, expect, it } from 'vitest';
import { LIST_MINE_LIMIT_UNSET, SupportError, SupportService, assertListMineTicketsLimit } from './support-service.js';
import { userCopy } from './user-copy.js';
import { callerAs } from './testing/router-caller.js';

/**
 * listMine page size is refuse-closed when unset.
 *
 * listMyTickets called store.listByUser() with no page, so omit dumped every
 * ticket for the caller. Blank must refuse. Owner/client may pass 100 explicitly.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('listMine limit unset refuse', () => {
  it('assertListMineTicketsLimit refuses blank / NaN / 0 — never invents 100', () => {
    expect(() => assertListMineTicketsLimit(undefined)).toThrow(SupportError);
    expect(() => assertListMineTicketsLimit(Number.NaN)).toThrow(SupportError);
    expect(() => assertListMineTicketsLimit(0)).toThrow(SupportError);
    try {
      assertListMineTicketsLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(SupportError);
      expect((e as SupportError).code).toBe(LIST_MINE_LIMIT_UNSET);
      expect((e as SupportError).message).not.toMatch(/100-row|default 100/i);
      expect(userCopy((e as SupportError).code)).toBe(LIST_MINE_LIMIT_UNSET);
      expect(userCopy((e as SupportError).code)).not.toMatch(/100-row|default 100/i);
    }
  });

  it('accepts owner-published 100 and caps at existing door max 500', () => {
    expect(assertListMineTicketsLimit(100)).toBe(100);
    expect(assertListMineTicketsLimit(1)).toBe(1);
    expect(assertListMineTicketsLimit(500)).toBe(500);
    expect(assertListMineTicketsLimit(501)).toBe(500);
  });

  it('listMyTickets omit refuses; explicit 100 pages; never dumps the table', async () => {
    const svc = new SupportService();
    for (let i = 0; i < 3; i += 1) {
      await svc.createTicket({
        userId: USER,
        category: 'other',
        subject: `S${i}`,
        body: 'B',
      });
    }
    await expect(svc.listMyTickets({ userId: USER })).rejects.toMatchObject({ code: LIST_MINE_LIMIT_UNSET });
    await expect(svc.listMyTickets({ userId: USER, limit: undefined })).rejects.toMatchObject({
      code: LIST_MINE_LIMIT_UNSET,
    });
    const page = await svc.listMyTickets({ userId: USER, limit: 100 });
    expect(page).toHaveLength(3);
    const one = await svc.listMyTickets({ userId: USER, limit: 1 });
    expect(one).toHaveLength(1);
  });

  it("the listMine door refuses an omitted limit by name and pages an explicit one of the caller's own tickets", async () => {
    const svc = new SupportService();
    for (let i = 0; i < 3; i += 1) {
      await svc.createTicket({ userId: USER, category: 'other', subject: `S${i}`, body: 'B' });
    }
    await svc.createTicket({ userId: OTHER, category: 'other', subject: 'Not mine', body: 'B' });
    const me = await callerAs(svc, USER, ['support:read', 'support:write']);
    for (const input of [undefined, {}]) {
      await expect(me.listMine(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: userCopy(LIST_MINE_LIMIT_UNSET) });
    }
    expect(await me.listMine({ limit: 100 })).toHaveLength(3);
    expect(await me.listMine({ limit: 1 })).toHaveLength(1);
  });
});
