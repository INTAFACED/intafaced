import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { statusPageConfigureInputSchema, type ActionApproval, type ActionApprovalConsumeInput } from '@intafaced/contracts';
import { MemoryCommandLog } from '../preferences/account.js';
import { MemoryStatusPageBook } from '../status-page/book.js';
import { MemoryNoticeStore, NoticeBoard, type NoticeApprovalConsumer } from './board.js';

/** Notice categories (SP-status-03): an owner-set list, blank meaning none, stored on the notice as written. */

const AUTHOR = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';

class Approvals implements NoticeApprovalConsumer {
  async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
    return {
      approvalId: input.approvalId,
      actionType: 'notify.notice.publish',
      targetService: input.targetService,
      targetId: input.targetId,
      expectedVersion: input.expectedVersion,
      payloadHash: input.payloadHash,
      requesterId: AUTHOR,
      approverId: APPROVER,
      policyVersion: 'v1',
      createdAt: '2026-10-23T00:00:00.000Z',
      expiresAt: '2026-10-23T23:00:00.000Z',
      status: 'CONSUMED',
      operationId: input.operationId,
    };
  }
}

async function desk() {
  const book = new MemoryStatusPageBook();
  const board = new NoticeBoard(
    new MemoryNoticeStore(),
    new Approvals(),
    new MemoryCommandLog(),
    () => new Date('2026-10-23T12:00:00.000Z'),
    async () => [],
    async () => undefined,
    async () => new Set(),
    async () => (await book.definition()).noticeCategories,
  );
  const setCategories = async (noticeCategories: { id: string; name: string }[] | null) => {
    const { revision } = await book.definition();
    return book.configure({
      input: statusPageConfigureInputSchema.parse({ reason: 'TEST categories', expectedRevision: revision, noticeCategories }),
      by: AUTHOR,
      at: '2026-10-23T12:00:00.000Z',
    });
  };
  return { board, book, setCategories };
}

const draft = (category: string | null, key: string) => ({
  kind: 'announcement',
  title: 'TEST new listing',
  body: 'TEST the market opens on Monday.',
  category,
  clientRequestId: key,
});

describe('notice categories', () => {
  it('with no list set, a notice names no category, and one that names any is refused', async () => {
    const { board } = await desk();
    expect((await board.draft(AUTHOR, draft(null, 'plain'))).category).toBeNull();
    await expect(board.draft(AUTHOR, draft('listings', 'named'))).rejects.toMatchObject({ code: 'status.category_unknown' });
  });

  it('a listed category is stored with its name as listed, shown on the published notice and bound by the approval', async () => {
    const { board, setCategories } = await desk();
    await setCategories([
      { id: 'listings', name: 'New listings' },
      { id: 'risk', name: 'Risk notices' },
    ]);
    await expect(board.draft(AUTHOR, draft('delistings', 'off-list'))).rejects.toMatchObject({ code: 'status.category_unknown' });
    const drafted = await board.draft(AUTHOR, draft('listings', 'listed'));
    expect(drafted.category).toEqual({ id: 'listings', name: 'New listings' });
    const hash = (fields: object) => `sha256:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}`;
    expect((await board.publishProposal(drafted.id)).payloadHash).toBe(
      hash({
        id: drafted.id,
        kind: 'announcement',
        title: 'TEST new listing',
        body: 'TEST the market opens on Monday.',
        version: 1,
        category: { id: 'listings', name: 'New listings' },
      }),
    );
    await board.publish(AUTHOR, { id: drafted.id, clientRequestId: 'p', approvalId: 'a', operationId: 'o' });
    // Renaming the category later leaves the published notice as it was filed.
    await setCategories([{ id: 'listings', name: 'Listings' }]);
    const published = (await board.notices({ kind: 'announcement', limit: 10 })).filter((n) => n.id === drafted.id);
    expect(published.map((n) => n.category)).toEqual([{ id: 'listings', name: 'New listings' }]);
    expect((await board.notice(drafted.id)).category).toEqual({ id: 'listings', name: 'New listings' });
  });

  it('only an announcement takes a category: any other kind naming one is refused', async () => {
    const { board, setCategories } = await desk();
    await setCategories([{ id: 'listings', name: 'New listings' }]);
    await expect(board.draft(AUTHOR, { ...draft('listings', 'changelog'), kind: 'changelog' })).rejects.toMatchObject({
      code: 'status.category_unknown',
    });
    expect((await board.draft(AUTHOR, { ...draft(null, 'changelog-plain'), kind: 'changelog' })).category).toBeNull();
  });

  it('the list is an owner value: set whole, cleared with null, and refused with a duplicate id', async () => {
    const { book, setCategories } = await desk();
    expect((await book.definition()).noticeCategories).toBeNull();
    await setCategories([{ id: 'listings', name: 'New listings' }]);
    expect((await book.definition()).noticeCategories).toEqual([{ id: 'listings', name: 'New listings' }]);
    await setCategories(null);
    expect((await book.definition()).noticeCategories).toBeNull();
    for (const bad of [
      [
        { id: 'listings', name: 'A' },
        { id: 'listings', name: 'B' },
      ],
      [{ id: 'Bad Id', name: 'A' }],
      [],
    ])
      expect(statusPageConfigureInputSchema.safeParse({ reason: 'TEST', expectedRevision: 0, noticeCategories: bad }).success).toBe(false);
  });
});
