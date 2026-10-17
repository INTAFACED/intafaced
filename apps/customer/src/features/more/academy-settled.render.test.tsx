import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { ProgressBar } from './AcademyLmsParts';

describe('Academy progress bar', () => {
  // The 2026-10-17 browser run called /academy and the lesson reader "still loading after 20 s". Every Academy read had
  // settled; the one "busy" element was a finished 4-of-7 bar carrying role="progressbar".
  const html = renderToString(<ProgressBar percent={57.14} label="Foundations: 4 of 7 lessons recorded" />);

  it('is a settled meter, never a progressbar that reads as work still in flight', () => {
    expect(html).toContain('role="meter"');
    expect(html).not.toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="57"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-label="Foundations: 4 of 7 lessons recorded"');
  });

  it('carries no loading class or busy flag', () => {
    expect(html).not.toMatch(/loading|spinner|loader|aria-busy/i);
  });

  it('clamps an out-of-range ratio instead of drawing past the track', () => {
    expect(renderToString(<ProgressBar percent={140} label="x" />)).toContain('aria-valuenow="100"');
    expect(renderToString(<ProgressBar percent={-5} label="x" />)).toContain('aria-valuenow="0"');
  });
});
