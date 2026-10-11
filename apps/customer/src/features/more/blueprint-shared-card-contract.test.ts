import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentSharedCardRoute,
  sharedCardFailure,
  sharedCardHref,
  sharedCardResponse,
  sharedCardRoute,
  sharedCardSelection,
  subscribeSharedCardRoute,
} from './blueprint-shared-card-contract';
const subject = '22222222-2222-4222-8222-222222222222';
const selection = { userId: subject, size: 'portrait' as const };
const card = {
  size: 'portrait',
  width: 1080,
  height: 1350,
  svg: '<svg/>',
  shareMode: 'svg',
  raster: { status: 'unavailable', code: 'blueprint.card_renderer_unconfigured', reason: 'Renderer absent' },
};
afterEach(() => vi.unstubAllGlobals());
describe('Blueprint shared card exact contract', () => {
  it('accepts only an exact subject UUID and supported size, with no viewer field', () => {
    expect(sharedCardSelection.safeParse(selection).success).toBe(true);
    for (const candidate of [
      { ...selection, viewerId: subject },
      { ...selection, userId: 'account-name' },
      { ...selection, size: 'square' },
    ])
      expect(sharedCardSelection.safeParse(candidate).success).toBe(false);
  });
  it('binds the response size and canonical dimensions to the submitted request', () => {
    expect(sharedCardResponse(selection).safeParse(card).success).toBe(true);
    for (const extra of [{ size: 'landscape' }, { width: 1200 }, { height: 630 }, { viewerId: subject }])
      expect(sharedCardResponse(selection).safeParse({ ...card, ...extra }).success).toBe(false);
  });
  it('refuses unknown or malformed raster variants without losing their distinction from read failures', () => {
    for (const raster of [
      { ...card.raster, code: 'invented' },
      { ...card.raster, reason: '' },
      { status: 'rendered', url: 'https://fixture.invalid/x.png', contentType: 'image/jpeg', bytes: 1 },
      { status: 'rendered', url: 'bad', contentType: 'image/png', bytes: 1 },
    ])
      expect(sharedCardResponse(selection).safeParse({ ...card, raster }).success).toBe(false);
  });
  it('accepts valid landscape and rendered PNG metadata without loading its URL', () => {
    expect(
      sharedCardResponse({ ...selection, size: 'landscape' }).safeParse({
        ...card,
        size: 'landscape',
        width: 1200,
        height: 630,
        shareMode: 'png',
        raster: { status: 'rendered', url: 'https://fixture.invalid/x.png', contentType: 'image/png', bytes: 1 },
      }).success,
    ).toBe(true);
  });
  it('distinguishes only the exact named not-found 404, never a private or missing subtype', () => {
    expect(sharedCardFailure({ ok: false, reason: 'not_mounted', status: 404, code: 'blueprint.not_found', message: '' })).toBe(
      'unavailable',
    );
    expect(sharedCardFailure({ ok: false, reason: 'not_mounted', status: 404, message: '' })).toBe('routeUnavailable');
    expect(sharedCardFailure({ ok: false, reason: 'forbidden', status: 403, code: 'blueprint.not_found', message: '' })).toBe('forbidden');
  });
  it('strictly parses intentional same-room links and refuses ambiguous duplicate parameters', () => {
    vi.stubGlobal('location', { origin: 'https://fixture.invalid' });
    expect(sharedCardRoute(`/blueprint?subject=${subject}&size=portrait`).selection).toEqual(selection);
    for (const route of [
      `/blueprint?subject=${subject}&subject=${subject}`,
      `/blueprint?subject=${subject}&size=portrait&size=landscape`,
      '/blueprint?size=portrait',
      '/blueprint?subject=not-a-uuid',
    ])
      expect(sharedCardRoute(route).invalid).toBe(true);
    expect(sharedCardRoute('/blueprint')).toEqual({ selection: null, invalid: false });
  });
  it('carries only a validated UUID and size through the existing same-room auth return', () => {
    vi.stubGlobal('location', { origin: 'https://fixture.invalid' });
    const original = { ...selection, size: 'landscape' as const };
    const href = sharedCardHref(original);
    expect(href).toBe(`/blueprint?subject=${subject}&size=landscape`);
    expect(sharedCardRoute(href)).toEqual({ selection: original, invalid: false });
    for (const invalid of [
      { ...original, userId: 'account-name' },
      { ...original, size: 'square' },
      { ...original, providerUrl: 'https://fixture.invalid/private' },
    ])
      expect(() => sharedCardHref(invalid as typeof original)).toThrow();
  });
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
    const original = currentSharedCardRoute();
    const notify = vi.fn(),
      unsubscribe = subscribeSharedCardRoute(notify);
    history.replaceState(null, '', '/blueprint?subject=' + subject);
    history.replaceState(null, '', '/blueprint');
    expect(currentSharedCardRoute().epoch).toBe(original.epoch + 2);
    expect(notify).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(history.pushState).toBe(push);
    expect(history.replaceState).toBe(push);
  });
});
