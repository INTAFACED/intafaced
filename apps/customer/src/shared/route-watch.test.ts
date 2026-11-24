import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentRoute, subscribeRoute } from './route-watch';

const subject = '22222222-2222-4222-8222-222222222222';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('route watch', () => {
  it('observes query/hash A→B→A synchronously and restores only owned history wrappers', () => {
    const loc = { origin: 'https://fixture.invalid', href: 'https://fixture.invalid/blueprint' };
    vi.stubGlobal('location', loc);
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    vi.stubGlobal('HashChangeEvent', class extends Event {});
    const push = function (_data: unknown, _unused: string, href?: string | URL | null) {
      loc.href = new URL(String(href), loc.origin).href;
    };
    vi.stubGlobal('history', { pushState: push, replaceState: push });
    const original = currentRoute();
    const notify = vi.fn(),
      unsubscribe = subscribeRoute(notify);
    history.replaceState(null, '', '/blueprint?subject=' + subject);
    history.replaceState(null, '', '/blueprint');
    expect(currentRoute().epoch).toBe(original.epoch + 2);
    expect(notify).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(history.pushState).toBe(push);
    expect(history.replaceState).toBe(push);
  });
});
