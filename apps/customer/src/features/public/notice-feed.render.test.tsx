import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { NoticeDetail, NoticeList, NoticeMissing } from './NoticeFeed';
import { feedNotices, isNoticeId, type Notice } from './notices-api';
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
  });

  it('reads a reference that is not a notice id as not published without calling the service', () => {
    expect(isNoticeId('abc')).toBe(false);
    expect(isNoticeId('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(renderToString(<NoticeDetail id="abc" />)).toBe(renderToString(<NoticeMissing />));
    expect(renderToString(<NoticeDetail id={null} />)).toContain('This notice is not published');
  });
});
