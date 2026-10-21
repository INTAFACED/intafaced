import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';
import { MemorySupportStore } from './store.js';

/**
 * SP-tickets-07 — merge a duplicate request into the one that stays: messages and files move, the source ends closed with
 * its link, both trails get a merge row, a replay moves nothing twice, and a resolved, closed, foreign or same request is
 * refused with its typed code.
 */

const authConfig = {
  secret: 'a-support-merge-test-secret-long-enough-12345',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const LEAD = '33333333-3333-4333-8333-333333333333';
const SESSION = '66666666-6666-4666-8666-666666666666';

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-merge' };
}

async function desk() {
  const store = new MemorySupportStore();
  const support = new SupportService(store);
  const router = createSupportRouter(support);
  const lead = router.createCaller(await ctx(LEAD, ['support:ops']));
  const customer = router.createCaller(await ctx(USER, ['support:read', 'support:write']));
  const make = async (userId: string, n: number) =>
    (await support.createTicket({ userId, category: 'account', subject: `Request ${n}`, body: `Body ${n}` })).id;
  return { store, support, lead, customer, make };
}

describe('merge duplicate requests', () => {
  it('moves messages and files, closes the source with its link and writes a merge row on both trails', async () => {
    const { store, support, lead, make } = await desk();
    const [src, win] = [await make(USER, 1), await make(USER, 2)] as [string, string];
    await support.comment({ userId: USER, ticketId: src, body: 'again' });
    await support.comment({ userId: LEAD, ticketId: src, body: 'looking', asOperator: true });
    await store.recordAttachment({
      id: '99999999-9999-4999-8999-999999999999',
      userId: USER,
      ticketId: src,
      clientRequestId: 'file-0001',
      storeKey: 'k',
      contentType: 'image/png',
      byteLength: 3,
      maxCount: 5,
    });

    const res = await lead.mergeTickets({ sourceId: src, survivorId: win, reason: 'same login problem' });
    expect(res).toMatchObject({ sourceId: src, survivorId: win, commentsMoved: 2, attachmentsMoved: 1 });

    expect(await store.listComments(src)).toHaveLength(0);
    expect((await store.listComments(win)).map((c) => c.body)).toEqual(['again', 'looking']);
    expect((await store.listAttachmentsFor(win, 10)).map((a) => a.id)).toEqual(['99999999-9999-4999-8999-999999999999']);
    expect(await store.listAttachmentsFor(src, 10)).toHaveLength(0);

    const source = await support.getTicket({ userId: USER, ticketId: src });
    expect(source).toMatchObject({ status: 'closed', mergedInto: win });
    expect((await support.getTicket({ userId: USER, ticketId: win })).status).toBe('open');

    const srcTrail = await store.listEvents(src);
    const winTrail = await store.listEvents(win);
    expect(srcTrail.map((e) => e.kind)).toEqual(['opened', 'merged', 'status_changed']);
    expect(srcTrail[1]!.note).toBe(`merged into ${win}: same login problem`);
    expect(winTrail.map((e) => e.kind)).toEqual(['opened', 'merged']);
    expect(winTrail[1]!.note).toBe(`absorbed ${src}: same login problem`);
  });

  it('answers a replay of the same pair with the stored result and writes nothing more', async () => {
    const { store, lead, make } = await desk();
    const [src, win] = [await make(USER, 1), await make(USER, 2)] as [string, string];
    const first = await lead.mergeTickets({ sourceId: src, survivorId: win, reason: 'dup' });
    const again = await lead.mergeTickets({ sourceId: src, survivorId: win, reason: 'dup again' });
    expect(again).toEqual(first);
    expect(await store.listEvents(src)).toHaveLength(3);
    expect(await store.listEvents(win)).toHaveLength(2);
  });

  it('refuses a source already merged into another request', async () => {
    const { lead, make } = await desk();
    const [src, win, third] = [await make(USER, 1), await make(USER, 2), await make(USER, 3)] as [string, string, string];
    await lead.mergeTickets({ sourceId: src, survivorId: win, reason: 'dup' });
    await expect(lead.mergeTickets({ sourceId: src, survivorId: third, reason: 'dup' })).rejects.toThrow(/support.merge_not_allowed/);
  });

  it('refuses a resolved or closed request on either side with support.merge_not_allowed, and changes nothing', async () => {
    const { store, support, lead, make } = await desk();
    const [a, b, c] = [await make(USER, 1), await make(USER, 2), await make(USER, 3)] as [string, string, string];
    await support.setStatus({ operatorId: LEAD, ticketId: a, status: 'resolved' });
    await support.setStatus({ operatorId: LEAD, ticketId: c, status: 'closed' });
    for (const [s, w] of [
      [a, b],
      [b, a],
      [c, b],
      [b, c],
    ] as const) {
      await expect(lead.mergeTickets({ sourceId: s, survivorId: w, reason: 'dup' })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    }
    expect(await store.listEvents(b)).toHaveLength(1);
    expect((await support.getTicket({ userId: USER, ticketId: b })).mergedInto).toBeUndefined();
  });

  it('refuses a merge across two requester accounts', async () => {
    const { lead, make } = await desk();
    const [mine, theirs] = [await make(USER, 1), await make(OTHER, 2)] as [string, string];
    await expect(lead.mergeTickets({ sourceId: mine, survivorId: theirs, reason: 'dup' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('refuses the same request, a missing one, a missing reason and a customer caller', async () => {
    const { lead, customer, make } = await desk();
    const a = await make(USER, 1);
    await expect(lead.mergeTickets({ sourceId: a, survivorId: a, reason: 'dup' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(
      lead.mergeTickets({ sourceId: a, survivorId: '77777777-7777-4777-8777-777777777777', reason: 'dup' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(lead.mergeTickets({ sourceId: a, survivorId: await make(USER, 2), reason: '  ' })).rejects.toThrow();
    await expect(customer.mergeTickets({ sourceId: a, survivorId: await make(USER, 3), reason: 'dup' })).rejects.toThrow();
  });
});

describe('merge preview', () => {
  it('counts what moves, says what stays on the source, and moves nothing', async () => {
    const { store, support, lead, make } = await desk();
    const [src, win] = [await make(USER, 1), await make(USER, 2)] as [string, string];
    await support.comment({ userId: USER, ticketId: src, body: 'hello' });
    const preview = await lead.previewMerge({ sourceId: src, survivorId: win });
    expect(preview).toMatchObject({
      refusal: null,
      commentsToMove: 1,
      attachmentsToMove: 0,
      staysOnSource: { rating: false, caseFile: false },
      alreadyMerged: false,
    });
    expect(await store.listComments(src)).toHaveLength(1);
  });

  it('names the refusal a merge would give, and reports an already-made merge as merged', async () => {
    const { support, lead, make } = await desk();
    const [src, win, res] = [await make(USER, 1), await make(USER, 2), await make(USER, 3)] as [string, string, string];
    await support.setStatus({ operatorId: LEAD, ticketId: res, status: 'resolved' });
    expect((await lead.previewMerge({ sourceId: src, survivorId: res })).refusal).toBe('support.merge_not_allowed');
    expect((await lead.previewMerge({ sourceId: src, survivorId: src })).refusal).toBe('support.merge_same_ticket');
    await lead.mergeTickets({ sourceId: src, survivorId: win, reason: 'dup' });
    expect(await lead.previewMerge({ sourceId: src, survivorId: win })).toMatchObject({ refusal: null, alreadyMerged: true });
  });
});
