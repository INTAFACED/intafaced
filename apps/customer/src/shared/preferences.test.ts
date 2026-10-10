import { afterEach, describe, expect, it, vi } from 'vitest';

const key = 'intafaced.customer.view.v1';
async function setup(initial: string | null = null) {
  vi.resetModules();
  let raw = initial;
  let storageChanged: (event: unknown) => void = () => {};
  const storage = {
    getItem: vi.fn(() => raw),
    setItem: vi.fn((_key: string, value: string) => {
      raw = value;
    }),
  };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', {
    addEventListener: (_name: string, listener: typeof storageChanged) => {
      storageChanged = listener;
    },
  });
  const preferences = await import('./preferences');
  return {
    ...preferences,
    storage,
    raw: () => raw,
    event: (current: string | null, oldValue: string | null = null, newValue = current) => {
      raw = current;
      storageChanged({ key, storageArea: storage, oldValue, newValue });
    },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('canonical device preference admission', () => {
  it('hydrates an alias without rewriting stored bytes or unrelated choices', async () => {
    const raw = JSON.stringify({ language: 'zh-CN', theme: 'light', confirmSend: false });
    const p = await setup(raw);
    expect(p.currentPreferences()).toMatchObject({ language: 'zh-Hans', theme: 'light', confirmSend: false });
    expect(p.raw()).toBe(raw);
    expect(p.storage.setItem).not.toHaveBeenCalled();
  });
  it('retains the current valid snapshot across malformed/unknown/null language storage events', async () => {
    const p = await setup(JSON.stringify({ language: 'fr', theme: 'light', hideBalances: true }));
    const original = p.currentPreferences();
    for (const raw of ['{broken', JSON.stringify({ language: 'zz-ZZ' }), JSON.stringify({ language: null })]) {
      p.event(raw);
      expect(p.currentPreferences()).toBe(original);
    }
    p.storage.getItem.mockImplementation(() => {
      throw new Error('unreadable');
    });
    p.event(JSON.stringify({ language: 'ar' }));
    expect(p.currentPreferences()).toBe(original);
    expect(p.storage.setItem).not.toHaveBeenCalled();
  });
  it('installs current storage rather than an older queued event and preserves daily departure epochs', async () => {
    const p = await setup(JSON.stringify({ language: 'en', theme: 'light' }));
    const previous = JSON.stringify(p.currentPreferences());
    const departure = JSON.stringify({ ...p.currentPreferences(), language: 'ar', dailyStart: 'utc8' });
    const current = JSON.stringify({ ...p.currentPreferences(), language: 'FR' });
    p.event(current, previous, departure);
    expect(p.currentPreferences()).toMatchObject({ language: 'fr', theme: 'light', dailyStart: 'nativeUTC' });
    expect(p.currentDailyPreferenceEpoch()).toBeGreaterThan(0);
    expect(p.storage.setItem).not.toHaveBeenCalled();
  });
  it('acknowledges an exact current write/readback while preserving all other preferences', async () => {
    const p = await setup();
    const previous = p.currentPreferences();
    expect(p.savePreferences({ language: 'de' })).toBe('device');
    expect(p.currentPreferences()).toEqual({ ...previous, language: 'de' });
    expect(JSON.parse(p.raw()!)).toEqual(p.currentPreferences());
  });
  it('keeps a valid RAM choice with visit-only acknowledgement after a failed write', async () => {
    const p = await setup(JSON.stringify({ language: 'es', theme: 'light' }));
    const raw = p.raw();
    p.storage.setItem.mockImplementation(() => {
      throw new Error('quota');
    });
    expect(p.savePreferences({ language: 'ar' })).toBe('visit');
    expect(p.currentPreferences()).toMatchObject({ language: 'ar', theme: 'light' });
    expect(p.raw()).toBe(raw);
  });
  it('refuses a device-saved claim on unreadable or mismatched readback', async () => {
    const p = await setup();
    p.storage.getItem.mockReturnValue('different');
    expect(p.savePreferences({ language: 'de' })).toBe('visit');
    p.storage.getItem.mockImplementation(() => {
      throw new Error('readback unavailable');
    });
    expect(p.savePreferences({ language: 'ar' })).toBe('visit');
    expect(p.currentPreferences().language).toBe('ar');
  });
  it('refuses an invalid local patch before changing RAM or stored bytes', async () => {
    const p = await setup();
    const previous = p.currentPreferences();
    expect(() => p.savePreferences({ language: 'zz-ZZ' as never })).toThrow();
    expect(p.currentPreferences()).toBe(previous);
    expect(p.storage.setItem).not.toHaveBeenCalled();
  });
  it('observes a valid same-value external write without fabricating a daily departure', async () => {
    const p = await setup();
    p.savePreferences({ language: 'ar' });
    const current = p.currentPreferences();
    const epoch = p.currentDailyPreferenceEpoch();
    const observation = p.currentPreferenceObservation();
    p.event(JSON.stringify(current));
    expect(p.currentPreferences()).toBe(current);
    expect(p.currentPreferenceObservation()).toBe(observation + 1);
    expect(p.currentDailyPreferenceEpoch()).toBe(epoch);
  });
});
