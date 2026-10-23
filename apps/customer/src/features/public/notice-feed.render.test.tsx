import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { NoticeDetail, NoticeList, NoticeMissing } from './NoticeFeed';
import { feedNotices, isNoticeId, maintenancePhase, readNotice, type Notice } from './notices-api';
import type { ApiClient } from '../../shared/api';
import { entrySchema } from '../developers/developers-api';

const notice = (over: Partial<Notice>): Notice =>
  entrySchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'announcement',
    title: 'Test notice',
    body: 'Test body',
    status: 'published',
    publishedAt: '2026-10-17T12:00:00.000Z',
    startsAt: null,
    endsAt: null,
    version: 1,
    changelog: null,
    ...over,
  });

describe('public notice feed', () => {
  it('says plainly that nothing is published when the feed is empty', () => {
    const page = renderToString(<NoticeList notices={[]} />);
    expect(page).toContain('No public notices are published');
    expect(page).not.toContain('<article');
  });

  it('keeps announcements, maintenance and incidents and leaves changelog entries to their own page', () => {
    const rows = [
      notice({ kind: 'announcement', id: '11111111-1111-4111-8111-111111111111' }),
      notice({ kind: 'changelog', id: '22222222-2222-4222-8222-222222222222' }),
      notice({ kind: 'incident', id: '33333333-3333-4333-8333-333333333333', title: 'Incident one' }),
    ];
    expect(feedNotices(rows).map((row) => row.kind)).toEqual(['announcement', 'incident']);
    const page = renderToString(<NoticeList notices={rows} />);
    expect(page).toContain('Test notice');
    expect(page).toContain('Incident one');
    expect(page).toContain('/notice/33333333-3333-4333-8333-333333333333');
    expect(page).not.toContain('/notice/22222222');
  });

  it('shows a maintenance window with an unset end as not set, never as a made-up time', () => {
    const page = renderToString(<NoticeList notices={[notice({ kind: 'maintenance', startsAt: '2026-10-20T01:00:00.000Z' })]} />);
    expect(page).toContain('Window 2026-10-20 to not set');
    expect(page.replace(/<!-- -->/g, '')).toContain('Maintenance · Started, end not set');
    expect(page).not.toContain('In progress');
  });

  it('reads a reference that is not a notice id as not published without calling the service', () => {
    expect(isNoticeId('abc')).toBe(false);
    expect(isNoticeId('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(renderToString(<NoticeDetail id="abc" />)).toBe(renderToString(<NoticeMissing />));
    expect(renderToString(<NoticeDetail id={null} />)).toContain('This notice is not published');
  });

  it('reads a notice the service says does not exist as not published, and any other refusal as a failed read', async () => {
    const api = (code: string) => ({ query: async () => ({ ok: false, reason: 'error', message: 'x', code }) }) as unknown as ApiClient;
    const id = '11111111-1111-4111-8111-111111111111';
    expect(await readNotice(api('notify.notice_not_found'), id)).toEqual({ ok: true, data: null });
    expect(await readNotice(api('notify.unavailable'), id)).toMatchObject({ ok: false });
  });
});

describe('maintenance windows on /notice', () => {
  const now = Date.parse('2026-10-23T12:00:00.000Z');
  it('says scheduled before the start, in progress inside the window, completed after the end', () => {
    const m = (startsAt: string | null, endsAt: string | null) => notice({ kind: 'maintenance', startsAt, endsAt });
    expect(maintenancePhase(m('2026-10-24T00:00:00.000Z', '2026-10-24T01:00:00.000Z'), now)).toBe('scheduled');
    expect(maintenancePhase(m('2026-10-23T11:00:00.000Z', '2026-10-23T13:00:00.000Z'), now)).toBe('in_progress');
    expect(maintenancePhase(m('2026-10-23T09:00:00.000Z', '2026-10-23T10:00:00.000Z'), now)).toBe('completed');
  });

  it('never calls a window in progress without a start and an end it can read', () => {
    const m = (startsAt: string | null, endsAt: string | null) => notice({ kind: 'maintenance', startsAt, endsAt });
    expect(maintenancePhase(m(null, null), now)).toBe('time_unset');
    expect(maintenancePhase(m('2026-13-40', '2026-10-23T13:00:00.000Z'), now)).toBe('time_unset');
    expect(maintenancePhase(m('2026-10-20T00:00:00.000Z', 'later'), now)).toBe('time_unset');
    expect(maintenancePhase(m('2025-10-20T00:00:00.000Z', null), now)).toBe('end_unset');
    expect(maintenancePhase(m('2027-10-20T00:00:00.000Z', null), now)).toBe('scheduled');
    expect(maintenancePhase(m('2026-10-23T09:00:00.000Z', '2026-10-23T10:00:00.000Z'), now)).toBe('completed');
    expect(maintenancePhase(notice({ kind: 'announcement' }), now)).toBeNull();
  });

  it('labels each maintenance card with its kind and phase, and other kinds with their kind only', () => {
    const page = renderToString(
      <NoticeList
        notices={[
          notice({
            kind: 'maintenance',
            id: '44444444-4444-4444-8444-444444444444',
            startsAt: '2000-01-01T00:00:00.000Z',
            endsAt: '2000-01-01T01:00:00.000Z',
          }),
          notice({ kind: 'incident', id: '55555555-5555-4555-8555-555555555555' }),
        ]}
      />,
    );
    expect(page.replace(/<!-- -->/g, '')).toContain('Maintenance · Completed');
    expect(page).toContain('data-phase="completed"');
    expect(page.match(/data-phase=/g)).toHaveLength(1);
  });
});
