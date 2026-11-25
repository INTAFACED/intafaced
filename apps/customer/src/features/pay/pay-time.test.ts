import { describe, expect, it } from 'vitest';
import { payTimeText } from './components';

const NOW = Date.parse('2026-10-18T04:00:00Z');

describe('payTimeText', () => {
  it('shows the viewer’s own clock by default without forcing UTC', () => {
    const local = payTimeText('2026-10-17T21:43:08Z', 'en', NOW);
    expect(local).not.toBeNull();
    expect(local).not.toContain('UTC');
    expect(local).not.toMatch(/10\/17\/2026|PM/);
  });
  it('names the zone when UTC or UTC+8 is picked in Settings', () => {
    expect(payTimeText('2026-10-17T21:43:08Z', 'en', NOW, 'UTC')).toBe('17 Oct, 21:43 UTC');
    expect(payTimeText('2026-10-17T21:43:08Z', 'en', NOW, 'UTC+8')).toBe('18 Oct, 05:43 UTC+8');
    expect(payTimeText('2026-10-17T21:43:08Z', 'en', NOW, 'UTC')).not.toMatch(/10\/17\/2026|PM/);
  });
  it('adds the year only for another year', () => {
    expect(payTimeText('2025-10-17T21:43:08Z', 'en', NOW, 'UTC')).toBe('17 Oct 2025, 21:43 UTC');
  });
  it('uses the shown language for the month', () => {
    expect(payTimeText('2026-10-17T21:43:08Z', 'es', NOW, 'UTC')).toContain('oct');
    expect(payTimeText('2026-10-17T21:43:08Z', 'fr', NOW, 'UTC')).toMatch(/oct\.?, 21:43 UTC$/);
  });
  it('an unreadable time is not formatted into a made-up one', () => {
    expect(payTimeText('yesterday', 'en', NOW)).toBeNull();
  });
});
