import { describe, expect, it } from 'vitest';
import type { Notice } from '../../features/public/notices-api';
import { homeNotices } from './notice-model';

const notice = (over: Partial<Notice>): Notice => ({
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'announcement',
  title: 'TEST notice',
  body: 'TEST body',
  status: 'published',
  publishedAt: '2026-10-23T00:00:00Z',
  startsAt: null,
  endsAt: null,
  version: 1,
  changelog: null,
  ...over,
});

const NOW = Date.parse('2026-10-23T04:00:00Z');
const window = notice({ id: '00000000-0000-4000-8000-000000000002', kind: 'maintenance', endsAt: '2026-10-23T05:00:00Z' });
const incident = notice({ id: '00000000-0000-4000-8000-000000000003', kind: 'incident' });

describe('Home notices (HM-widgets-03)', () => {
  it('draws nothing when nothing is published or the reads failed', () => {
    expect(homeNotices({ incidents: [], maintenance: [] }, null, NOW)).toEqual({ banner: [], strip: [] });
    expect(homeNotices(null, null, NOW)).toEqual({ banner: [], strip: [] });
  });

  it('puts incidents before maintenance windows in the banner, each once', () => {
    expect(homeNotices({ incidents: [incident], maintenance: [window, window] }, null, NOW).banner.map((row) => row.kind)).toEqual([
      'incident',
      'maintenance',
    ]);
  });

  it('shows the latest announcements in the strip, each once and announcements only, and keeps the banner when their read failed', () => {
    const announcement = notice({});
    const later = notice({ id: '00000000-0000-4000-8000-000000000004' });
    expect(homeNotices({ incidents: [], maintenance: [] }, [later, announcement, announcement, window], NOW).strip).toEqual([
      later,
      announcement,
    ]);
    expect(homeNotices({ incidents: [], maintenance: [window] }, null, NOW)).toEqual({ banner: [window], strip: [] });
  });

  it('drops a window that closed since the read', () => {
    expect(homeNotices({ incidents: [], maintenance: [window] }, null, Date.parse('2026-10-23T05:00:00Z')).banner).toEqual([]);
  });

  it('never draws a draft, whatever the read held', () => {
    const draft = notice({ status: 'draft' });
    expect(homeNotices({ incidents: [], maintenance: [{ ...window, status: 'draft' }] }, [draft], NOW)).toEqual({ banner: [], strip: [] });
  });
});
