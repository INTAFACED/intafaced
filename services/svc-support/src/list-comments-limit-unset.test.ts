import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIST_COMMENTS_LIMIT_UNSET, SupportError, SupportService, assertListCommentsLimit } from './support-service.js';
import { userCopy } from './user-copy.js';
import { withTestCommentCap } from './comment-cap.fixture.js';

/**
 * listComments page size is refuse-closed when unset.
 *
 * listComments called store.listComments(ticketId) with no page, so omit
 * dumped every comment on the ticket. Blank must refuse. Owner/client may
 * pass 100 explicitly.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
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

  it('router does not invent 100 when listComments omits limit', () => {
    const src = readFileSync(join(ROOT, 'services/svc-support/src/router.ts'), 'utf8');
    const start = src.indexOf('listComments:');
    const end = src.indexOf('setStatus:', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('limit: input.limit');
    expect(fn).not.toMatch(/input\.limit \?\? 100/);
    expect(fn).not.toMatch(/\?\? 100/);
  });

  it('listComments no longer dumps store.listComments(ticketId) without a page', () => {
    const src = readFileSync(join(ROOT, 'services/svc-support/src/support-service.ts'), 'utf8');
    const start = src.indexOf('async listComments(');
    const end = src.indexOf('async setStatus(', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('assertListCommentsLimit');
    expect(fn).toContain('this.store.listComments(input.ticketId, { limit })');
    expect(fn).not.toMatch(/this\.store\.listComments\(input\.ticketId\)/);
    expect(fn).not.toMatch(/\?\? 100/);
  });
});
