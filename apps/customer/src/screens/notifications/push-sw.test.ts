import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// The push worker (public/push-sw.js) is plain script, so it runs here in a context of its own with a stand-in `self`.
const source = readFileSync(new URL('../../../public/push-sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://app.test';

/** Pushes a notice whose link is `href`, presses the notification it shows, and returns the URL the worker opened. */
function press(href: unknown): string {
  const handlers: Record<string, (event: unknown) => void> = {};
  const shown: { data: unknown }[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (name: string, handler: (event: unknown) => void) => (handlers[name] = handler),
    registration: { showNotification: (_title: string, options: { data: unknown }) => shown.push(options) },
    clients: { openWindow: (url: string) => opened.push(url) },
  };
  runInNewContext(source, { self, URL });
  const waitUntil = () => {};
  handlers.push!({ data: { json: () => ({ title: 'TEST notice', href }) }, waitUntil });
  handlers.notificationclick!({ notification: { close: () => {}, data: shown[0]!.data }, waitUntil });
  return opened[0]!;
}

describe('the push worker opens only this site', () => {
  it('opens the notice room on this site', () => {
    expect(press('/notice/n-1?x=1#top')).toBe(`${ORIGIN}/notice/n-1?x=1#top`);
  });

  it('opens the inbox for a link that would leave the site, however it is spelled', () => {
    for (const href of [
      '/..//evil.example',
      '//evil.example/x',
      'https://evil.example/',
      '/\\evil.example',
      'javascript:alert(1)',
      undefined,
    ]) {
      expect(new URL(press(href)).origin).toBe(ORIGIN);
    }
    expect(press('//evil.example/x')).toBe(`${ORIGIN}/notifications`);
  });
});

describe('the push worker shows the brand', () => {
  it('shows the app icon and the one-colour badge from the brand folder, and both files are served', () => {
    const shown: { icon?: string; badge?: string }[] = [];
    const handlers: Record<string, (event: unknown) => void> = {};
    const self = {
      location: { origin: ORIGIN },
      addEventListener: (name: string, handler: (event: unknown) => void) => (handlers[name] = handler),
      registration: { showNotification: (_title: string, options: { icon?: string; badge?: string }) => shown.push(options) },
      clients: { openWindow: () => {} },
    };
    runInNewContext(source, { self, URL });
    handlers.push!({ data: { json: () => ({ title: 'TEST notice' }) }, waitUntil: () => {} });
    expect(shown[0]).toMatchObject({ icon: '/brand/icon-192.png', badge: '/brand/badge-96.png' });
    for (const file of [shown[0]!.icon!, shown[0]!.badge!])
      expect(
        readFileSync(new URL(`../../../public${file}`, import.meta.url))
          .subarray(1, 4)
          .toString(),
      ).toBe('PNG');
  });
});
