import { describe, expect, it } from 'vitest';
import { appStoreHref } from './app-store-link';

describe('appStoreHref (SP-pages-03)', () => {
  it("links the founders' https store address exactly", () => {
    expect(appStoreHref({ ok: true, appStoreUrl: 'https://apps.apple.com/app/id0000000000' })).toBe(
      'https://apps.apple.com/app/id0000000000',
    );
  });

  it('has no link when none is set or the desk could not be read', () => {
    expect(appStoreHref({ ok: true, appStoreUrl: null })).toBeNull();
    expect(appStoreHref({ ok: false })).toBeNull();
  });

  it('never links a value the contract would refuse', () => {
    expect(appStoreHref({ ok: true, appStoreUrl: 'http://apps.apple.com/app' })).toBeNull();
    expect(appStoreHref({ ok: true, appStoreUrl: 'javascript:alert(1)' })).toBeNull();
  });
});
