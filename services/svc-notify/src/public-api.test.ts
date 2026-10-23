import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import type { StatusPage } from '@intafaced/contracts/status-page';
import { MemoryCommandLog } from './preferences/account.js';
import { MemoryNoticeStore, NoticeBoard, type NoticeApprovalConsumer } from './notices/board.js';
import { registerPublicReadApi } from './public-api.js';

/** The documented read API (SP-api-01): the site's notice and status reads as plain GETs, paged, signed out. */

const AUTHOR = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';

class Approvals implements NoticeApprovalConsumer {
  async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
    return {
      ...input,
      actionType: 'notify.notice.publish',
      requesterId: AUTHOR,
      approverId: APPROVER,
      policyVersion: 'v1',
      createdAt: '2026-10-23T00:00:00.000Z',
      expiresAt: '2026-10-23T23:00:00.000Z',
      status: 'CONSUMED',
    } as ActionApproval;
  }
}

async function api(statusPage: () => Promise<StatusPage> = async () => ({ page: 'TEST' }) as unknown as StatusPage) {
  let now = new Date('2026-10-23T12:00:00.000Z');
  const board = new NoticeBoard(new MemoryNoticeStore(), new Approvals(), new MemoryCommandLog(), () => now);
  const publish = async (kind: 'announcement' | 'changelog', key: string, at: string) => {
    now = new Date(at);
    const draft = await board.draft(AUTHOR, { kind, title: `TEST ${key}`, body: 'TEST body', clientRequestId: key });
    await board.publish(AUTHOR, { id: draft.id, clientRequestId: `${key}-pub`, approvalId: `${key}-a`, operationId: `${key}-o` });
    return draft.id;
  };
  const app = Fastify();
  registerPublicReadApi(app, { notices: board, statusPage });
  const get = async (url: string) => {
    const res = await app.inject({ method: 'GET', url });
    return { status: res.statusCode, body: res.json() };
  };
  return { board, publish, get };
}

describe('the public read API', () => {
  it('pages the published notices newest first, as the tRPC read answers them, until a short page', async () => {
    const { board, publish, get } = await api();
    const a = await publish('announcement', 'a', '2026-10-23T10:00:00.000Z');
    const b = await publish('announcement', 'b', '2026-10-23T11:00:00.000Z');
    const c = await publish('announcement', 'c', '2026-10-23T11:00:00.000Z');
    const first = await get('/v1/notices?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.notices).toEqual(JSON.parse(JSON.stringify(await board.notices({ limit: 2 }))));
    const tie = [b, c].sort();
    expect(first.body.notices.map((n: { id: string }) => n.id)).toEqual(tie);
    expect(first.body.next).toBe(tie[1]);
    const second = await get(`/v1/notices?limit=2&after=${first.body.next}`);
    expect(second.body).toMatchObject({ next: null });
    expect(second.body.notices.map((n: { id: string }) => n.id)).toEqual([a]);
  });

  it('says nothing follows a page that ends exactly at the last notice, and reads an id in capitals', async () => {
    const { publish, get } = await api();
    const ids = [];
    for (const n of [1, 2, 3, 4]) ids.push(await publish('announcement', `x${n}`, `2026-10-23T1${n}:00:00.000Z`));
    const first = await get('/v1/notices?limit=2');
    const second = await get(`/v1/notices?limit=2&after=${first.body.next.toUpperCase()}`);
    expect(second.body.notices.map((n: { id: string }) => n.id)).toEqual([ids[1], ids[0]]);
    expect(second.body.next).toBeNull();
    expect((await get(`/v1/notices/${ids[0]!.toUpperCase()}`)).body.id).toBe(ids[0]);
    // A page size past the cap is the cap, however many digits it has.
    expect((await get('/v1/notices?limit=1000000')).body.notices).toHaveLength(4);
  });

  it('narrows to one kind, and a cursor of another kind refuses instead of restarting', async () => {
    const { publish, get } = await api();
    const note = await publish('announcement', 'n', '2026-10-23T10:00:00.000Z');
    const log = await publish('changelog', 'l', '2026-10-23T11:00:00.000Z');
    expect((await get('/v1/notices?limit=5&kind=announcement')).body.notices.map((n: { id: string }) => n.id)).toEqual([note]);
    expect(await get(`/v1/notices?limit=5&kind=announcement&after=${log}`)).toEqual({
      status: 400,
      body: { code: 'notify.notices_cursor_unknown' },
    });
    expect(await get('/v1/notices?limit=5&after=99999999-9999-4999-8999-999999999999')).toMatchObject({ status: 400 });
    expect(await get('/v1/notices?limit=5&kind=memo')).toEqual({ status: 400, body: { code: 'notify.notice_kind_unknown' } });
  });

  it('has no default page size: a missing or malformed limit refuses', async () => {
    const { get } = await api();
    for (const url of ['/v1/notices', '/v1/notices?limit=0', '/v1/notices?limit=two', '/v1/notices?limit=-1']) {
      expect(await get(url)).toEqual({ status: 400, body: { code: 'notify.notices_limit_invalid' } });
    }
    expect(await get('/v1/notices?limit=5&after=nope')).toEqual({ status: 400, body: { code: 'notify.notices_cursor_unknown' } });
  });

  it('reads one published notice, and anything else is the same not-found', async () => {
    const { board, publish, get } = await api();
    const id = await publish('announcement', 'one', '2026-10-23T10:00:00.000Z');
    expect(await get(`/v1/notices/${id}`)).toEqual({ status: 200, body: JSON.parse(JSON.stringify(await board.notice(id))) });
    const draft = await board.draft(AUTHOR, { kind: 'announcement', title: 'TEST draft', body: 'TEST', clientRequestId: 'draft' });
    for (const missing of [draft.id, '99999999-9999-4999-8999-999999999999', 'nope']) {
      expect(await get(`/v1/notices/${missing}`)).toEqual({ status: 404, body: { code: 'notify.notice_not_found' } });
    }
  });

  it('answers the status page as statusPage.read does, and says so when it cannot read it', async () => {
    expect(await (await api()).get('/v1/status')).toEqual({ status: 200, body: { page: 'TEST' } });
    const down = await api(async () => {
      throw new Error('database down');
    });
    expect(await down.get('/v1/status')).toEqual({ status: 503, body: { code: 'notify.status_page_unavailable' } });
  });

  it('says the notices are unavailable when the board is not wired, never an empty list', async () => {
    const app = Fastify();
    registerPublicReadApi(app, { notices: null, statusPage: async () => ({}) as StatusPage });
    const res = await app.inject({ method: 'GET', url: '/v1/notices?limit=5' });
    expect([res.statusCode, res.json()]).toEqual([503, { code: 'notify.notices_unavailable' }]);
  });
});
