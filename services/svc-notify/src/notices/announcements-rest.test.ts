import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { MemoryDeliveryStore, MemoryTargetStore } from '../channel-store.js';
import { InAppChannel, UnconfiguredChannel } from '../channels/gateway.js';
import { ChannelRegistry } from '../channels/registry.js';
import { NotificationDispatcher } from '../dispatch.js';
import { NotifyService } from '../notify-service.js';
import { MemoryCommandLog } from '../preferences/account.js';
import { createNotifyRouter } from '../router.js';
import { MemoryNotifyStore } from '../store.js';
import { ANNOUNCEMENTS_PATH, registerAnnouncementsRoute } from './announcements-rest.js';
import { ANNOUNCEMENTS_LIMIT_MAX, MemoryNoticeStore, NoticeBoard, type NoticeKind, type NoticeRow } from './board.js';

/**
 * GET /api/v1/announcements (SP-developer-status-02, lead ruling D27).
 * Rows here are the test's own strings; the service seeds none.
 */

const AUTHOR = '11111111-1111-4111-8111-111111111111';
let seq = 0;

function row(kind: NoticeKind, status: 'draft' | 'published', publishedAt: string | null): NoticeRow {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  return {
    id,
    kind,
    title: `Test ${kind} ${seq}`,
    body: 'Test body',
    status,
    publishedAt: publishedAt ? new Date(publishedAt) : null,
    startsAt: kind === 'maintenance' ? new Date('2026-10-17T00:00:00.000Z') : null,
    endsAt: kind === 'maintenance' ? new Date('2026-10-18T00:00:00.000Z') : null,
    version: 1,
    impact: null,
    components: [],
    parentId: null,
    resolves: false,
    asset: null,
    network: null,
    phase: null,
    changelog: null,
    authorId: AUTHOR,
    clientRequestId: `req-${seq}`,
    publishClientRequestId: status === 'published' ? `pub-${seq}` : null,
    approvalId: status === 'published' ? `appr-${seq}` : null,
    createdAt: new Date('2026-10-16T00:00:00.000Z'),
  };
}

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function serve(board: NoticeBoard | null): Promise<FastifyInstance> {
  app = Fastify();
  registerAnnouncementsRoute(app, board);
  await app.ready();
  return app;
}

async function seeded() {
  const store = new MemoryNoticeStore();
  const older = row('changelog', 'published', '2026-10-17T09:00:00.000Z');
  const newer = row('changelog', 'published', '2026-10-17T10:00:00.000Z');
  const draft = row('changelog', 'draft', null);
  const other = row('announcement', 'published', '2026-10-17T11:00:00.000Z');
  for (const r of [older, newer, draft, other]) await store.insert(r);
  const board = new NoticeBoard(store, null, new MemoryCommandLog(), () => new Date('2026-10-17T12:00:00.000Z'));
  return { board, older, newer, draft, other };
}

describe('GET /api/v1/announcements', () => {
  it('kind=changelog&locale=en returns only published en changelog notices, newest first', async () => {
    const { board, older, newer } = await seeded();
    const res = await (await serve(board)).inject({ method: 'GET', url: `${ANNOUNCEMENTS_PATH}?kind=changelog&locale=en` });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { announcements: { id: string; kind: string; status: string }[] }).announcements;
    expect(ids.map((a) => a.id)).toEqual([newer.id, older.id]);
    expect(ids.every((a) => a.kind === 'changelog' && a.status === 'published')).toBe(true);
  });

  it('never returns drafts, with or without filters', async () => {
    const { board, draft, other } = await seeded();
    const res = await (await serve(board)).inject({ method: 'GET', url: ANNOUNCEMENTS_PATH });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { announcements: { id: string }[] }).announcements.map((a) => a.id);
    expect(ids).not.toContain(draft.id);
    expect(ids[0]).toBe(other.id);
    expect(ids).toHaveLength(3);
  });

  it('kind=bogus refuses with notify.notice_kind_unknown, 400', async () => {
    const { board } = await seeded();
    const res = await (await serve(board)).inject({ method: 'GET', url: `${ANNOUNCEMENTS_PATH}?kind=bogus&locale=en` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ code: 'notify.notice_kind_unknown' });
  });

  it('locale=fr refuses with notify.notice_locale_unknown, 400', async () => {
    const { board } = await seeded();
    const res = await (await serve(board)).inject({ method: 'GET', url: `${ANNOUNCEMENTS_PATH}?kind=changelog&locale=fr` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ code: 'notify.notice_locale_unknown' });
  });

  it('a repeated locale or kind parameter refuses instead of guessing', async () => {
    const { board } = await seeded();
    const server = await serve(board);
    const locale = await server.inject({ method: 'GET', url: `${ANNOUNCEMENTS_PATH}?locale=en&locale=fr` });
    expect(locale.statusCode).toBe(400);
    expect(locale.json()).toEqual({ code: 'notify.notice_locale_unknown' });
    const kind = await server.inject({ method: 'GET', url: `${ANNOUNCEMENTS_PATH}?kind=changelog&kind=incident` });
    expect(kind.statusCode).toBe(400);
    expect(kind.json()).toEqual({ code: 'notify.notice_kind_unknown' });
  });

  it('a bad limit refuses with notify.notices_limit_invalid; a large one is capped', async () => {
    const { board } = await seeded();
    const server = await serve(board);
    for (const limit of ['0', '-1', 'abc', '1.5']) {
      const res = await server.inject({ method: 'GET', url: `${ANNOUNCEMENTS_PATH}?limit=${limit}` });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ code: 'notify.notices_limit_invalid' });
    }
    const one = await server.inject({ method: 'GET', url: `${ANNOUNCEMENTS_PATH}?limit=1` });
    expect((one.json() as { announcements: unknown[] }).announcements).toHaveLength(1);
    const capped = await board.announcements({ limit: ANNOUNCEMENTS_LIMIT_MAX * 10 });
    expect(capped).toHaveLength(3);
  });

  it('board not wired: typed refusal (503 notify.notices_unavailable), not an empty list', async () => {
    const res = await (await serve(null)).inject({ method: 'GET', url: `${ANNOUNCEMENTS_PATH}?kind=changelog&locale=en` });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ code: 'notify.notices_unavailable' });
  });

  it('a store failure is a typed refusal, not an empty list', async () => {
    const store = new MemoryNoticeStore();
    store.listPublished = async () => {
      throw new Error('connection reset');
    };
    const board = new NoticeBoard(store, null, new MemoryCommandLog());
    const res = await (await serve(board)).inject({ method: 'GET', url: ANNOUNCEMENTS_PATH });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ code: 'notify.notices_unavailable' });
  });
});

describe('tRPC notices when the board is not wired (router.ts, D27 (4))', () => {
  it('refuses with notify.notices_unavailable instead of returning []', async () => {
    const registry = new ChannelRegistry([
      new InAppChannel(),
      new UnconfiguredChannel('email', ['NOTIFY_EMAIL_GATEWAY_URL', 'NOTIFY_EMAIL_GATEWAY_TOKEN']),
      new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
      new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
    ]);
    const targets = new MemoryTargetStore();
    const deliveries = new MemoryDeliveryStore();
    const unwired = new NotifyService(
      new MemoryNotifyStore(),
      { fanoutEnabled: true },
      {
        targets,
        deliveries,
        channels: registry,
        dispatcher: new NotificationDispatcher(registry, targets, deliveries, { maxAttempts: 3, outOfAppEnabled: false }),
      },
    );
    const edgeContext = createEdgeContext({ secret: 'notify-announcements-test-edge-secret', serviceName: 'svc-notify' });
    const anon = createNotifyRouter(unwired).createCaller(edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon-unwired' }));
    await expect(anon.notify.notices({ limit: 20 })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'notify.notices_unavailable',
    });
  });
});
