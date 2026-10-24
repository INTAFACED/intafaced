import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { MemoryCommandLog } from '../preferences/account.js';
import { AudienceUnavailableError, createP2pMerchantMembership, type AudienceMembership, type MemberAudience } from './audiences.js';
import { MemoryNoticeStore, NoticeBoard, type NoticeApprovalConsumer, type NoticeRow } from './board.js';

/** Merchant notices (P-trade-orders-23): an announcement for P2P merchants reaches P2P merchants only, and never the public board. */

const AUTHOR = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';
const MERCHANT = '33333333-3333-4333-8333-333333333333';
const TRADER = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-10-24T12:00:00.000Z');

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
      createdAt: '2026-10-24T00:00:00.000Z',
      expiresAt: '2026-10-24T23:00:00.000Z',
      status: 'CONSUMED',
      operationId: input.operationId,
    };
  }
}

const merchants: AudienceMembership = {
  async audiencesOf(userId) {
    return new Set<MemberAudience>(userId === MERCHANT ? ['p2p-merchants'] : []);
  },
};

function desk(membership: AudienceMembership | null = merchants) {
  const published: NoticeRow[] = [];
  const board = new NoticeBoard(
    new MemoryNoticeStore(),
    new Approvals(),
    new MemoryCommandLog(),
    () => NOW,
    async () => [],
    async (row) => {
      published.push(row);
    },
    async () => new Set(),
    async () => null,
    membership,
  );
  return { board, published };
}

const window = { startsAt: '2026-10-24T11:00:00.000Z', endsAt: '2026-10-24T13:00:00.000Z' };

async function publishOne(board: NoticeBoard, key: string, audience: string | null) {
  const draft = await board.draft(AUTHOR, {
    kind: 'announcement',
    title: `TEST ${key}`,
    body: 'TEST body',
    ...window,
    audience,
    clientRequestId: `draft-${key}`,
  });
  return board.publish(AUTHOR, { id: draft.id, clientRequestId: `publish-${key}`, approvalId: `approval-${key}`, operationId: 'o' });
}

describe('notice audiences', () => {
  it('lists everyone and P2P merchants, and says when merchant membership cannot be read here', () => {
    expect(desk().board.audiences()).toEqual([
      { id: 'everyone', available: true },
      { id: 'p2p-merchants', available: true },
    ]);
    expect(desk(null).board.audiences()).toContainEqual({ id: 'p2p-merchants', available: false });
  });

  it('only an announcement may name a member audience, and only a known one', async () => {
    const { board } = desk();
    const base = { title: 'TEST', body: 'TEST', ...window };
    await expect(
      board.draft(AUTHOR, { ...base, kind: 'maintenance', audience: 'p2p-merchants', clientRequestId: 'm' }),
    ).rejects.toMatchObject({ code: 'notify.notice_audience_invalid' });
    await expect(board.draft(AUTHOR, { ...base, kind: 'announcement', audience: 'whales', clientRequestId: 'w' })).rejects.toMatchObject({
      code: 'notify.notice_audience_invalid',
    });
    const plain = await board.draft(AUTHOR, { ...base, kind: 'announcement', clientRequestId: 'p' });
    expect(plain.audience).toBe('everyone');
  });

  it('binds the audience into the publish approval; for everyone the payload is as it was before audiences', async () => {
    const { board } = desk();
    const base = { kind: 'announcement', title: 'TEST same', body: 'TEST same', ...window };
    const hash = (payload: object) => `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
    const members = await board.draft(AUTHOR, { ...base, audience: 'p2p-merchants', clientRequestId: 'q' });
    const fields = (id: string) => ({ id, kind: 'announcement', title: 'TEST same', body: 'TEST same', version: 1 });
    expect((await board.publishProposal(members.id)).payloadHash).toBe(hash({ ...fields(members.id), audience: 'p2p-merchants' }));
    const everyone = await board.draft(AUTHOR, { ...base, audience: 'everyone', clientRequestId: 'e' });
    expect((await board.publishProposal(everyone.id)).payloadHash).toBe(hash(fields(everyone.id)));
  });

  it('a merchants’ notice is on no public read and reaches no status subscriber', async () => {
    const { board, published } = desk();
    const forMerchants = await publishOne(board, 'merchants', 'p2p-merchants');
    expect(forMerchants.audience).toBe('p2p-merchants');
    expect(await board.notices({ limit: 50 })).toEqual([]);
    expect(await board.notices({ kind: 'announcement', limit: 50 })).toEqual([]);
    await expect(board.notice(forMerchants.id)).rejects.toMatchObject({ code: 'notify.notice_not_found' });
    await expect(board.notices({ limit: 10, after: forMerchants.id })).rejects.toMatchObject({ code: 'notify.notices_cursor_unknown' });
    expect(await board.currentAnnouncement()).toBeNull();
    expect(await board.publishedForFanOut(forMerchants.id)).toBeNull();
    await Promise.resolve();
    expect(published).toEqual([]);

    const forEveryone = await publishOne(board, 'everyone', null);
    expect((await board.notices({ limit: 50 })).map((n) => n.id)).toEqual([forEveryone.id]);
    expect((await board.currentAnnouncement())?.id).toBe(forEveryone.id);
    await Promise.resolve();
    expect(published.map((row) => row.id)).toEqual([forEveryone.id]);
  });

  it('a P2P merchant reads it signed in; any other account reads none', async () => {
    const { board } = desk();
    const forMerchants = await publishOne(board, 'merchants', 'p2p-merchants');
    await publishOne(board, 'everyone', null);
    expect((await board.memberNotices(MERCHANT, { limit: 10 })).map((n) => n.id)).toEqual([forMerchants.id]);
    expect(await board.memberNotices(TRADER, { limit: 10 })).toEqual([]);
  });

  it('a closed window is not read, and a draft never is', async () => {
    const { board } = desk();
    await board.draft(AUTHOR, { kind: 'announcement', title: 'TEST draft', body: 'TEST', audience: 'p2p-merchants', clientRequestId: 'd' });
    const past = await board.draft(AUTHOR, {
      kind: 'announcement',
      title: 'TEST past',
      body: 'TEST',
      startsAt: '2026-10-23T00:00:00.000Z',
      endsAt: '2026-10-23T01:00:00.000Z',
      audience: 'p2p-merchants',
      clientRequestId: 'past',
    });
    await board.publish(AUTHOR, { id: past.id, clientRequestId: 'pp', approvalId: 'pa', operationId: 'o' });
    expect(await board.memberNotices(MERCHANT, { limit: 10 })).toEqual([]);
  });

  it('an open notice is read however many closed ones were published after it', async () => {
    const { board } = desk();
    const open = await publishOne(board, 'open', 'p2p-merchants');
    for (let i = 0; i < 60; i++) {
      const closed = await board.draft(AUTHOR, {
        kind: 'announcement',
        title: `TEST closed ${i}`,
        body: 'TEST',
        startsAt: '2026-10-23T00:00:00.000Z',
        endsAt: '2026-10-23T01:00:00.000Z',
        audience: 'p2p-merchants',
        clientRequestId: `closed-${i}`,
      });
      await board.publish(AUTHOR, { id: closed.id, clientRequestId: `pc-${i}`, approvalId: `ac-${i}`, operationId: 'o' });
    }
    expect((await board.memberNotices(MERCHANT, { limit: 10 })).map((n) => n.id)).toEqual([open.id]);
  });

  it('refuses a members’ draft while membership cannot be read here: it would reach no one', async () => {
    await expect(
      desk(null).board.draft(AUTHOR, {
        kind: 'announcement',
        title: 'TEST',
        body: 'TEST',
        audience: 'p2p-merchants',
        clientRequestId: 'u',
      }),
    ).rejects.toMatchObject({ code: 'notify.notice_audience_unavailable' });
    expect(
      (await desk(null).board.draft(AUTHOR, { kind: 'announcement', title: 'TEST', body: 'TEST', clientRequestId: 'e' })).audience,
    ).toBe('everyone');
  });

  it('refuses when membership is unwired or cannot be read: never a guessed list', async () => {
    await expect(desk(null).board.memberNotices(MERCHANT, { limit: 10 })).rejects.toMatchObject({
      code: 'notify.notice_audience_unavailable',
    });
    const down: AudienceMembership = {
      audiencesOf: async () => {
        throw new AudienceUnavailableError('p2p did not answer');
      },
    };
    await expect(desk(down).board.memberNotices(MERCHANT, { limit: 10 })).rejects.toMatchObject({
      code: 'notify.notice_audience_unavailable',
    });
    await expect(desk().board.memberNotices(MERCHANT, { limit: 0 })).rejects.toMatchObject({ code: 'notify.notices_limit_invalid' });
  });
});

describe('P2P merchant membership from svc-p2p', () => {
  const answer = (status: number, body: unknown) =>
    vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  const secret = 'x'.repeat(32);

  it('asks the signed reputation door and reads only `merchant: true` as a member', async () => {
    const fetchFn = answer(200, { merchant: true, tradesTotal: 12 });
    const membership = createP2pMerchantMembership('http://p2p.test/', secret, undefined, fetchFn as never);
    expect([...(await membership.audiencesOf(MERCHANT))]).toEqual(['p2p-merchants']);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe(`http://p2p.test/internal/reputation/${MERCHANT}`);
    expect(init?.redirect).toBe('error');
    expect(Object.keys(init?.headers ?? {}).length).toBeGreaterThan(0);

    for (const merchant of [false, null]) {
      const m = createP2pMerchantMembership('http://p2p.test', secret, undefined, answer(200, { merchant }) as never);
      expect((await m.audiencesOf(TRADER)).size).toBe(0);
    }
  });

  it('a refusal, an odd answer or no answer is unavailable, not "not a merchant"', async () => {
    const cases = [
      answer(401, { code: 'p2p.unauthenticated' }),
      answer(200, { merchant: 'yes' }),
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    ];
    for (const fetchFn of cases) {
      const m = createP2pMerchantMembership('http://p2p.test', secret, undefined, fetchFn as never);
      await expect(m.audiencesOf(MERCHANT)).rejects.toBeInstanceOf(AudienceUnavailableError);
    }
  });
});
