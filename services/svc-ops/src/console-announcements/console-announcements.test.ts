import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase } from '@intafaced/db';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, type AnnouncementSaveInput } from '@intafaced/contracts';
import { migrateOutreach } from '../db/migrate.js';
import { OpsService } from '../ops-service.js';
import { createOpsRouter } from '../router.js';
import { MemoryAnnouncementStore, SqlAnnouncementStore, type AnnouncementStore } from './store.js';

const SECRET = 'a-ops-mount-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-ops' });

async function signed(scopes: string[]) {
  const raw = encodePrincipal({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'none',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

const H = 3_600_000;
const T0 = Date.parse('2026-10-24T10:00:00.000Z');
const at = (ms: number) => new Date(ms).toISOString();

function build(store: AnnouncementStore | null = new MemoryAnnouncementStore()) {
  let clock = T0;
  const router = createOpsRouter(new OpsService(), undefined, {
    now: () => at(clock),
    ...(store ? { announcements: store } : {}),
  });
  return {
    store,
    tick: (ms: number) => {
      clock += ms;
    },
    caller: (scopes = ['admin:read', 'admin:write']) => signed(scopes).then((ctx) => router.createCaller(ctx)),
  };
}

let n = 0;
const draft = (over: Partial<AnnouncementSaveInput> = {}): AnnouncementSaveInput => ({
  key: `announcement:${(++n).toString(16).padStart(16, '0')}`,
  kind: 'warning',
  title: 'Ledger upgrade tonight',
  body: 'Expect slower desks for ten minutes.',
  action: { type: 'link', url: '/ledger', label: 'Ledger desk' },
  startsAt: at(T0 - 60_000),
  endsAt: at(T0 + H),
  publish: true,
  ...over,
});

describe('console announcement banner', () => {
  it('shows a published announcement only inside its window', async () => {
    const { caller, tick } = build();
    const c = await caller();
    const saved = await c.announcements.save(draft({ startsAt: at(T0 + H), endsAt: at(T0 + 2 * H) }));
    expect(saved).toMatchObject({ outcome: 'created', announcement: { status: 'published', publishedBy: USER } });
    expect((await c.announcements.active()).active).toBeNull();
    tick(H);
    expect((await c.announcements.active()).active?.id).toBe(saved.announcement.id);
    tick(H);
    expect((await c.announcements.active()).active).toBeNull();
  });

  it('only one is active: a published window that overlaps another is refused, and withdrawing frees it', async () => {
    const { caller } = build();
    const c = await caller();
    const first = await c.announcements.save(draft());
    await expect(c.announcements.save(draft({ startsAt: at(T0 + H / 2), endsAt: at(T0 + 3 * H) }))).rejects.toThrow(/ops\.banner_conflict/);
    // A draft may overlap: it shows nothing until it is published, and publishing it is refused the same way.
    const second = await c.announcements.save(draft({ publish: false, startsAt: at(T0 + H / 2), endsAt: at(T0 + 3 * H) }));
    await expect(c.announcements.change({ id: second.announcement.id, op: 'publish' })).rejects.toThrow(/ops\.banner_conflict/);
    // Back to back is not an overlap.
    await c.announcements.save(draft({ startsAt: at(T0 + H), endsAt: at(T0 + 2 * H) }));
    await c.announcements.change({ id: first.announcement.id, op: 'withdraw' });
    const list = await c.announcements.list();
    expect(list.active).toBeNull();
    expect(list.items.filter((a) => a.status === 'published')).toHaveLength(1);
  });

  it('an announcement that has ended holds no window: a new one over the time it covered shows from when it is published', async () => {
    const { caller, tick } = build();
    const c = await caller();
    await c.announcements.save(draft({ startsAt: at(T0 - 60_000), endsAt: at(T0 + H) }));
    tick(2 * H);
    const input = draft({ startsAt: at(T0 + H / 2), endsAt: at(T0 + 4 * H) });
    const next = await c.announcements.save(input);
    expect(next).toMatchObject({ outcome: 'created', announcement: { startsAt: at(T0 + 2 * H), endsAt: at(T0 + 4 * H) } });
    // A lost reply sent again still finds it: the replay compares the start the founder typed.
    expect(await c.announcements.save(input)).toMatchObject({ outcome: 'replayed', announcement: { id: next.announcement.id } });
    expect((await c.announcements.active()).active?.id).toBe(next.announcement.id);
  });

  it('refuses a window that ends before it starts, and publishing one that has already ended', async () => {
    const { caller, tick } = build();
    const c = await caller();
    await expect(c.announcements.save(draft({ startsAt: at(T0 + H), endsAt: at(T0) }))).rejects.toThrow(/ops\.banner_window_invalid/);
    await expect(c.announcements.save(draft({ startsAt: at(T0 - 2 * H), endsAt: at(T0 - H) }))).rejects.toThrow(
      /ops\.banner_window_invalid/,
    );
    const later = await c.announcements.save(draft({ publish: false, endsAt: at(T0 + H) }));
    tick(2 * H);
    await expect(c.announcements.change({ id: later.announcement.id, op: 'publish' })).rejects.toThrow(/ops\.banner_window_invalid/);
  });

  it('a lost reply sent again finds the same announcement; the same key with other words is refused', async () => {
    const { caller, store } = build();
    const c = await caller();
    const input = draft();
    const first = await c.announcements.save(input);
    expect(await c.announcements.save(input)).toEqual({ ...first, outcome: 'replayed' });
    await expect(c.announcements.save({ ...input, title: 'Another title' })).rejects.toThrow(/ops\.idempotency_conflict/);
    expect((store as MemoryAnnouncementStore).log.filter((l) => l.op === 'save')).toHaveLength(1);
  });

  it('withdrawn stays withdrawn; publishing or withdrawing again is a logged no-op', async () => {
    const { caller, store } = build();
    const c = await caller();
    const { announcement } = await c.announcements.save(draft());
    expect(await c.announcements.change({ id: announcement.id, op: 'publish' })).toMatchObject({ outcome: 'noop' });
    expect(await c.announcements.change({ id: announcement.id, op: 'withdraw' })).toMatchObject({
      outcome: 'changed',
      announcement: { status: 'withdrawn', withdrawnBy: USER },
    });
    expect(await c.announcements.change({ id: announcement.id, op: 'withdraw' })).toMatchObject({ outcome: 'noop' });
    await expect(c.announcements.change({ id: announcement.id, op: 'publish' })).rejects.toThrow(/ops\.announcement_withdrawn/);
    await expect(c.announcements.change({ id: '33333333-3333-4333-8333-333333333333', op: 'withdraw' })).rejects.toThrow(
      /ops\.announcement_not_found/,
    );
    expect((store as MemoryAnnouncementStore).log.map((l) => `${l.op}:${l.outcome}`)).toEqual([
      'save:created',
      'publish:noop',
      'withdraw:changed',
      'withdraw:noop',
    ]);
  });

  it('a link is https or a console path, never a script or another host', async () => {
    const { caller } = build();
    const c = await caller();
    for (const url of ['javascript:alert(1)', '//evil.example/x', '/\\evil.example', 'http://plain.example', 'data:text/html,x'])
      await expect(c.announcements.save(draft({ action: { type: 'link', url, label: 'Go' } }))).rejects.toThrow();
    await expect(
      c.announcements.save(draft({ publish: false, action: { type: 'link', url: 'https://status.example/x', label: 'Status' } })),
    ).resolves.toMatchObject({ outcome: 'created' });
    await expect(
      c.announcements.save(draft({ publish: false, action: { type: 'dialog', text: 'The longer story.' } })),
    ).resolves.toMatchObject({ outcome: 'created' });
  });

  it('reads need admin:read and writes admin:write; with no storage it says so', async () => {
    const { caller } = build();
    await expect((await caller(['admin:read'])).announcements.save(draft())).rejects.toThrow();
    await expect((await caller(['ops:read'])).announcements.active()).rejects.toThrow();
    const none = await build(null).caller();
    await expect(none.announcements.active()).rejects.toThrow(/ops\.announcement_storage_unconfigured/);
    await expect(none.announcements.save(draft())).rejects.toThrow(/ops\.announcement_storage_unconfigured/);
  });
});

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('console announcement banner on real PostgreSQL', () => {
  it('keeps one active window, survives a new store, and its log is append-only', async () => {
    const database = await createTestDatabase({ service: 'ops' });
    const sql = postgres(database.url, { max: 4, onnotice: () => undefined });
    try {
      await migrateOutreach(sql);
      const { caller } = build(new SqlAnnouncementStore(sql));
      const c = await caller();
      const input = draft();
      const first = await c.announcements.save(input);
      expect(await c.announcements.save(input)).toMatchObject({ outcome: 'replayed', announcement: { id: first.announcement.id } });
      await c.announcements.save(draft({ publish: false }));
      expect((await new SqlAnnouncementStore(sql).activeAt(at(T0)))?.id).toBe(first.announcement.id);
      // The table refuses two overlapping published windows even past the desk's own check.
      await expect(
        sql`UPDATE ops.console_announcements SET status = 'published', published_at = now() WHERE id <> ${first.announcement.id}`,
      ).rejects.toThrow();
      await c.announcements.change({ id: first.announcement.id, op: 'withdraw' });
      expect(await new SqlAnnouncementStore(sql).activeAt(at(T0))).toBeNull();
      await expect(sql`DELETE FROM ops.console_announcement_log`).rejects.toThrow(/append-only/);
      await migrateOutreach(sql, 'down');
    } finally {
      await sql.end();
      await database.drop();
    }
  });
});
