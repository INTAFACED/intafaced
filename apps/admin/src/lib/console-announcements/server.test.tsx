import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnnouncementBanner } from '@/components/announcement-banner';
import { effectiveOf, loadPreferences, setPreferences } from '@/lib/console-preferences/server';
import { announcementKey, changeAnnouncement, loadActiveAnnouncement, saveAnnouncement } from './server';

const ctx = {
  session: {
    userId: '11111111-1111-4111-8111-111111111111',
    accessToken: 'founder-access-token',
    refreshToken: 'r',
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-01-01T00:00:00.000Z',
    csrf: 'c'.repeat(43),
  },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};
const ok = (data: unknown) => Response.json({ result: { data } });
const refused = (code: string, status = 412) =>
  Response.json(
    { error: { message: `${code} — refused`, code: -32603, data: { code: 'PRECONDITION_FAILED', httpStatus: status, cause: { code } } } },
    { status },
  );

const announcement = {
  id: '9b1d8f0e-2c4a-5b6d-8e7f-0a1b2c3d4e5f',
  kind: 'warning' as const,
  title: 'Ledger upgrade tonight',
  body: 'Expect slower desks.',
  action: { type: 'dialog' as const, text: 'The ledger moves to the new schema between 22:00 and 22:10.' },
  startsAt: '2026-10-24T09:00:00.000Z',
  endsAt: '2026-10-24T11:00:00.000Z',
  status: 'published' as const,
  createdBy: ctx.session.userId,
  createdAt: '2026-10-24T08:59:00.000Z',
  publishedBy: ctx.session.userId,
  publishedAt: '2026-10-24T08:59:00.000Z',
  withdrawnBy: null,
  withdrawnAt: null,
};
const content = {
  kind: 'warning' as const,
  title: 'Ledger upgrade tonight',
  body: '',
  action: { type: 'none' as const },
  startsAt: announcement.startsAt,
  endsAt: announcement.endsAt,
};

afterEach(() => vi.unstubAllGlobals());

describe('announcement banner', () => {
  it('shows the active announcement in its tone, with its dialog and its end in the founder’s time zone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ active: announcement, asOf: '2026-10-24T10:00:00.000Z' })),
    );
    const view = await loadActiveAnnouncement(ctx);
    const html = renderToStaticMarkup(<AnnouncementBanner view={view} timeZone="Europe/Berlin" />);
    expect(html).toContain('data-tone="warn"');
    expect(html).toContain('Warning: Ledger upgrade tonight');
    expect(html).toContain('Until 24 Oct 2026, 13:00 (Europe/Berlin)');
    expect(html).toContain('Read more');
  });

  it('shows nothing when none is active, when there is no storage, or when svc-ops cannot be read', async () => {
    for (const answer of [
      () => ok({ active: null, asOf: '2026-10-24T10:00:00.000Z' }),
      () => refused('ops.announcement_storage_unconfigured'),
      () => Promise.reject(new Error('down')),
    ]) {
      vi.stubGlobal('fetch', vi.fn(answer));
      const view = await loadActiveAnnouncement(ctx);
      expect(renderToStaticMarkup(<AnnouncementBanner view={view} timeZone="UTC" />)).toBe('');
    }
  });
});

describe('announcement writes', () => {
  it('a save sent again carries the same business key; another basis or publish choice is another key', () => {
    const k = announcementKey(ctx.session.userId, null, content, true);
    expect(k).toMatch(/^announcement:[0-9a-f]{48}$/);
    expect(announcementKey(ctx.session.userId, null, content, true)).toBe(k);
    expect(announcementKey(ctx.session.userId, announcement.id, content, true)).not.toBe(k);
    expect(announcementKey(ctx.session.userId, null, content, false)).not.toBe(k);
  });

  it('a refused publish carries the refusal map’s words and code', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => refused('ops.banner_conflict', 409));
    vi.stubGlobal('fetch', fn);
    const out = await saveAnnouncement(ctx, null, content, true);
    expect(fn.mock.calls[0]![0]).toBe('http://edge:4000/api/ops/trpc/announcements.save');
    expect(out).toMatchObject({
      status: 409,
      reply: { ok: false, code: 'ops.banner_conflict', title: 'Another announcement holds that window' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ok({
          announcement: { ...announcement, status: 'withdrawn', withdrawnAt: announcement.endsAt, withdrawnBy: ctx.session.userId },
          outcome: 'changed',
        }),
      ),
    );
    expect(await changeAnnouncement(ctx, announcement.id, 'withdraw')).toEqual({
      status: 200,
      reply: { ok: true, what: 'announcement withdrawn' },
    });
  });
});

describe('console preferences reads', () => {
  it('a failed read falls back to the server’s preferences, never a guess', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('down'))),
    );
    const view = await loadPreferences(ctx);
    expect(view).toMatchObject({ kind: 'unknown' });
    expect(effectiveOf(view)).toEqual({
      theme: { value: 'dark', from: 'server' },
      homePage: { value: '/crm', from: 'server' },
      timeZone: { value: 'UTC', from: 'server' },
      weekStart: { value: 'monday', from: 'server' },
    });
  });

  it('a refused value names the refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => refused('ops.preference_invalid', 400)),
    );
    const out = await setPreferences(ctx, {
      level: 'person',
      expectedRevision: 0,
      values: { theme: null, homePage: null, timeZone: 'Mars/Olympus', weekStart: null },
    });
    expect(out).toMatchObject({ status: 400, reply: { ok: false, code: 'ops.preference_invalid' } });
  });
});
