import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SupportRatingSummaryView } from '@/lib/support/types';
import { RatingsSummaryView } from './support-ratings-summary';

const view = (over: Record<string, unknown> = {}): SupportRatingSummaryView => ({
  asOf: '2026-10-20T04:00:00.000Z',
  summary: {
    kind: 'ok',
    data: {
      from: '2026-09-20T00:00:00.000Z',
      to: '2026-10-20T00:00:00.000Z',
      solved: 0,
      responses: 0,
      perScore: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
      ratedShareBasisPoints: null,
      ...over,
    },
  } as SupportRatingSummaryView['summary'],
});
const html = (v: SupportRatingSummaryView | null, loading = false) =>
  renderToStaticMarkup(<RatingsSummaryView days={30} onDays={() => undefined} view={v} loading={loading} />);

describe('customer ratings card (SP-csat-01)', () => {
  it('with nothing rated says zero responses and shows no average or percentage', () => {
    const out = html(view());
    expect(out).toContain('No ratings yet');
    expect(out).toContain('data-testid="ratings-responses">0<');
    expect(out).toContain('data-testid="ratings-share">—<');
    expect(out).not.toContain('%');
  });

  it('shows the counts, the share and the average from the service figures', () => {
    const out = html(view({ solved: 3, responses: 2, perScore: { '1': 0, '2': 0, '3': 0, '4': 2, '5': 0 }, ratedShareBasisPoints: 6666 }));
    expect(out).toContain('data-testid="ratings-share">66.6%<');
    expect(out).toContain('data-testid="ratings-average">4.0<');
    expect(out).toContain('data-testid="ratings-score-4">2<');
  });

  it('states the window and offers the three windows, the picked one pressed', () => {
    const out = html(view());
    expect(out).toContain('20 Sep 2026, 00:00:00 UTC to 20 Oct 2026, 00:00:00 UTC');
    expect(out).toContain('Last 7 days');
    expect(out).toMatch(/aria-pressed="true"[^>]*>Last 30 days/);
  });

  it('says it could not read, or is reading, instead of showing empty numbers', () => {
    expect(html(null)).toContain('svc-support could not be read');
    expect(html(null, true)).toContain('Reading…');
    expect(html(null)).not.toContain('data-testid="ratings-solved"');
  });

  it('shows a refused read as unavailable, with the reason', () => {
    const out = html({
      asOf: '2026-10-20T04:00:00.000Z',
      summary: { kind: 'failed', message: 'No.', forbidden: true } as never,
    });
    expect(out).toContain('Customer ratings unavailable');
  });
});
