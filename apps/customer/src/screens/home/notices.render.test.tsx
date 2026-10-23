import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => ({ ...real.currentPreferences(), timeZone: 'UTC' }) };
});

import { NoticeRow } from './Notices';
import type { HomeNotice } from './notices';

const notice = (over: Partial<HomeNotice>): HomeNotice => ({
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'announcement',
  title: 'TEST <b>notice</b>',
  body: 'TEST body',
  status: 'published',
  publishedAt: '2026-10-23T00:00:00Z',
  startsAt: null,
  endsAt: null,
  version: 1,
  changelog: null,
  ...over,
});

describe('A notice on Home (HM-widgets-03)', () => {
  it('draws the title as plain text and links the notice and the list', () => {
    const html = renderToString(<NoticeRow notice={notice({})} banner={false} />);
    expect(html).toContain('TEST &lt;b&gt;notice&lt;/b&gt;');
    expect(html).toContain('role="status"');
    expect(html).toContain('href="/notice/00000000-0000-4000-8000-000000000001"');
    expect(html).toContain('href="/notice"');
    expect(html).not.toContain('Until');
  });

  it('gives a maintenance window its end time, or says none was published', () => {
    const until = renderToString(<NoticeRow notice={notice({ kind: 'maintenance', endsAt: '2026-10-23T05:00:00Z' })} banner />);
    expect(until).toContain('role="status"');
    expect(renderToString(<NoticeRow notice={notice({ kind: 'incident' })} banner />)).toContain('role="alert"');
    expect(until).toContain('Until 23 Oct, 05:00 UTC');
    expect(until).not.toContain('href="/notice"');
    expect(renderToString(<NoticeRow notice={notice({ kind: 'maintenance' })} banner />)).toContain('No end time published');
  });
});
