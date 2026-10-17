import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { ReportedTime } from './bank-context';

describe('Bank dates share the app look', () => {
  it('shows "18 Oct, 01:05", never the US month/day/year with seconds', () => {
    const html = renderToStaticMarkup(<ReportedTime value="2026-10-18T01:05:00.000Z" />);
    const text = html.replace(/<[^>]+>/g, '');
    expect(text).toMatch(/^\d{1,2} [A-Z][a-z]{2}( \d{4})?, \d{2}:\d{2}$/);
    expect(text).not.toMatch(/\d\/\d|AM|PM/);
    expect(html).toContain('dateTime="2026-10-18T01:05:00.000Z"');
  });
});
