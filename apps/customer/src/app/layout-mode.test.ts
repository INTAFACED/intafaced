import { describe, expect, it } from 'vitest';
import { currentPreferences, savePreferences } from '../shared/preferences';

describe('layoutMode preference (UI-SPEC 3.3, PLT-0009)', () => {
  it('defaults to Pro and stores either mode', () => {
    expect(currentPreferences().layoutMode).toBe('pro');
    savePreferences({ layoutMode: 'simple' });
    expect(currentPreferences().layoutMode).toBe('simple');
    savePreferences({ layoutMode: 'pro' });
    expect(currentPreferences().layoutMode).toBe('pro');
  });
  it('refuses a value that is not a mode', () => {
    expect(() => savePreferences({ layoutMode: 'dense' as never })).toThrow();
    expect(currentPreferences().layoutMode).toBe('pro');
  });
});
