// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BANNER_TEXT, testBanner } from '../../deployment/test-banner.mjs';
import INDEX from '../../index.html?raw';

// The TEST banner is the build's own: the page a build makes from index.html carries it unless the build is
// for real money, wherever that page is served. Each case runs the build's own page step over the real index.html,
// loads the page it makes, and draws the app part that reads it.

function built(env: Record<string, string | undefined>): string {
  return testBanner(env).transformIndexHtml(INDEX);
}

let root: Root | undefined;

async function load(env: Record<string, string | undefined>) {
  vi.resetModules(); // the app reads the served page once
  document.documentElement.innerHTML = new DOMParser().parseFromString(built(env), 'text/html').documentElement.innerHTML;
  const { TesterBuild } = await import('../features/public/TesterBuild');
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<TesterBuild />));
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.documentElement.innerHTML = '';
});

describe('the TEST banner', () => {
  it('shows in a test deployment, first in the page, and the app reads it as a test build', async () => {
    for (const env of [{}, { VITE_MONEY: 'test' }]) {
      await load(env);
      const banner = document.getElementById('local-test-stack-banner')!;
      expect(banner.parentElement).toBe(document.body);
      // before the boot frame and the app's root, so it is drawn from the page's first paint
      expect(banner.compareDocumentPosition(document.getElementById('root')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(banner.compareDocumentPosition(document.getElementById('boot-frame')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(banner.getAttribute('role')).toBe('status');
      expect(banner.textContent).toBe(BANNER_TEXT);
      expect(banner.style.position).toBe('fixed');
      expect(document.querySelector('[data-testid="tester-build"]')).not.toBeNull();
      act(() => root?.unmount());
    }
  });

  it('is absent in a real-money deployment, and the app shows nothing a test build shows', async () => {
    await load({ VITE_MONEY: 'real' });
    expect(document.getElementById('local-test-stack-banner')).toBeNull();
    expect(document.body.textContent).not.toContain('TEST FUNDS');
    expect(document.querySelector('[data-testid="tester-build"]')).toBeNull();
  });

  it('a real-money build refuses a page that already carries it, and any other money value is refused', () => {
    const forged = built({});
    expect(() => testBanner({ VITE_MONEY: 'real' }).transformIndexHtml(forged)).toThrow('a real-money build carries the TEST banner');
    expect(() => built({ VITE_MONEY: 'live' })).toThrow('VITE_MONEY must be blank, "test" or "real", not "live"');
  });
});
