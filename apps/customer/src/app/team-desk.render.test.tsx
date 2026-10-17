import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../shared/preferences', async (original) => {
  const real = await original<typeof import('../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { TeamDesk, teamConsoleHref } from './TeamDesk';

describe('console address', () => {
  it('is read from the configured address and joined to the room path', () => {
    expect(teamConsoleHref('/ops', 'https://console.example.com')).toBe('https://console.example.com/ops');
    expect(teamConsoleHref('/platform', 'https://console.example.com/team/')).toBe('https://console.example.com/team/platform');
  });
  it('is absent when nothing is configured', () => {
    expect(teamConsoleHref('/ops', undefined)).toBeUndefined();
    expect(teamConsoleHref('/ops', '')).toBeUndefined();
  });
  it('refuses an unsafe address: plain http, embedded sign-in details, query or fragment, or junk', () => {
    expect(teamConsoleHref('/ops', 'http://console.example.com')).toBeUndefined();
    expect(teamConsoleHref('/ops', 'https://user:pw@console.example.com')).toBeUndefined();
    expect(teamConsoleHref('/ops', 'https://console.example.com/?token=1')).toBeUndefined();
    expect(teamConsoleHref('/ops', 'https://console.example.com/#x')).toBeUndefined();
    expect(teamConsoleHref('/ops', 'not a url')).toBeUndefined();
  });
  it('allows plain http only for a local dev server', () => {
    expect(teamConsoleHref('/ops', 'http://localhost:3100', true)).toBe('http://localhost:3100/ops');
    expect(teamConsoleHref('/ops', 'http://localhost:3100', false)).toBeUndefined();
    expect(teamConsoleHref('/ops', 'http://console.example.com', true)).toBeUndefined();
  });
});

describe('/ops and /platform room', () => {
  it('has a back link and says honestly that the tools live in a separate console', () => {
    const html = renderToString(<TeamDesk href={undefined} />);
    expect(html).toContain('Back to home');
    expect(html).toContain('href="/"');
    expect(html).toContain('separate console with its own sign-in');
    expect(html).toContain('no operator tools');
  });
  it('opens the console when its address is configured', () => {
    const html = renderToString(<TeamDesk href="https://console.example.com/ops" />);
    expect(html).toContain('href="https://console.example.com/ops"');
    expect(html).toContain('Open Team');
    expect(html).not.toContain('not configured');
  });
  it('says the address is not configured, and offers no dead link, when it is missing', () => {
    const html = renderToString(<TeamDesk href={undefined} />);
    expect(html).toContain('not configured');
    expect(html).not.toContain('Open Team');
  });
});
