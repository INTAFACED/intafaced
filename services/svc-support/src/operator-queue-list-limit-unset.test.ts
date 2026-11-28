import { describe, expect, it } from 'vitest';
import { QUEUE_LIST_LIMIT_UNSET, assertOperatorQueueLimit as publishedQueueLimit, buildOperatorQueue } from './operator-queue.js';
import type { SupportTicket } from '@intafaced/contracts';
import { SupportError, SupportService, assertOperatorQueueLimit } from './support-service.js';
import { userCopy } from './user-copy.js';
import { callerAs } from './testing/router-caller.js';

/**
 * listQueue page size is refuse-closed when unset.
 *
 * buildOperatorQueue used `options.limit ?? 100` and listQueue passed
 * `input?.limit`, so omit invented a 100-row operator ticket queue. Blank
 * must refuse. Owner/client may pass 100 explicitly.
 */

describe('listQueue limit unset refuse', () => {
  it('assertOperatorQueueLimit refuses blank / NaN / 0 — never invents 100', () => {
    expect(() => assertOperatorQueueLimit(undefined)).toThrow(SupportError);
    expect(() => assertOperatorQueueLimit(Number.NaN)).toThrow(SupportError);
    expect(() => assertOperatorQueueLimit(0)).toThrow(SupportError);
    try {
      assertOperatorQueueLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(SupportError);
      expect((e as SupportError).code).toBe(QUEUE_LIST_LIMIT_UNSET);
      expect((e as SupportError).message).not.toMatch(/100-row|default 100/i);
      expect(userCopy((e as SupportError).code)).toBe(QUEUE_LIST_LIMIT_UNSET);
      expect(userCopy((e as SupportError).code)).not.toMatch(/100-row|default 100/i);
    }
    expect(() => publishedQueueLimit(undefined)).toThrow(/support\.queue_list_limit_unset/);
  });

  it('accepts owner-published 100 and caps at existing door max 500', () => {
    expect(assertOperatorQueueLimit(100)).toBe(100);
    expect(assertOperatorQueueLimit(1)).toBe(1);
    expect(assertOperatorQueueLimit(500)).toBe(500);
    expect(assertOperatorQueueLimit(501)).toBe(500);
  });

  it('buildOperatorQueue refuses an omitted limit by name and pages an explicit one', () => {
    const now = new Date('2026-08-05T12:00:00.000Z');
    const rows: SupportTicket[] = [0, 1, 2].map((i) => ({
      id: `t${i}`,
      userId: '11111111-1111-4111-8111-111111111111',
      category: 'other',
      subject: `S${i}`,
      body: 'B',
      status: 'open',
      assigneeId: null,
      createdAt: `2026-08-05T0${i}:00:00.000Z`,
      updatedAt: `2026-08-05T0${i}:00:00.000Z`,
    }));
    expect(() => buildOperatorQueue(rows, { now })).toThrow(/support\.queue_list_limit_unset/);
    const page = buildOperatorQueue(rows, { now, limit: 2 });
    expect(page.status === 'ok' ? page.entries : []).toHaveLength(2);
  });

  it('the listQueue door refuses an omitted limit by name and pages an explicit one', async () => {
    const svc = new SupportService();
    for (let i = 0; i < 3; i += 1) {
      await svc.createTicket({ userId: '11111111-1111-4111-8111-111111111111', category: 'other', subject: `S${i}`, body: 'B' });
    }
    const desk = await callerAs(svc, '33333333-3333-4333-8333-333333333333', ['support:ops', 'support:read', 'support:write']);
    for (const input of [undefined, {}]) {
      await expect(desk.listQueue(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: userCopy(QUEUE_LIST_LIMIT_UNSET) });
    }
    const page = await desk.listQueue({ limit: 2 });
    expect(page.status === 'ok' ? page.entries : []).toHaveLength(2);
  });
});
