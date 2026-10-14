import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Light is out of scope: ApplyView and the chart read the theme through `useResolvedTheme`, which is always dark. */
async function themesFor(stored: string | null, deviceIsLight = false) {
  vi.resetModules();
  vi.stubGlobal('localStorage', { getItem: () => stored, setItem: () => undefined });
  vi.stubGlobal('window', {
    addEventListener: () => undefined,
    matchMedia: () => ({ matches: deviceIsLight, addEventListener: () => undefined, removeEventListener: () => undefined }),
  });
  const { currentPreferences, useResolvedTheme } = await import('./preferences');
  let rendered = '';
  function Probe() {
    rendered = useResolvedTheme(currentPreferences().theme);
    return null;
  }
  renderToString(<Probe />);
  return { stored: currentPreferences().theme, rendered };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dark only', () => {
  it('renders dark for a stored light theme, and keeps the stored value as it was', async () => {
    expect(await themesFor(JSON.stringify({ language: 'en', theme: 'light' }))).toEqual({ stored: 'light', rendered: 'dark' });
  });
  it('renders dark for the system theme on a light device', async () => {
    expect(await themesFor(JSON.stringify({ language: 'en', theme: 'system' }), true)).toEqual({ stored: 'system', rendered: 'dark' });
  });
  it('renders dark with nothing stored', async () => {
    expect((await themesFor(null)).rendered).toBe('dark');
  });
});
