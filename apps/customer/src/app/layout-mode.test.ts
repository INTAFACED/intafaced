import { describe, expect, it } from 'vitest';
import { currentPreferences, savePreferences } from '../shared/preferences';

describe('layoutMode preference (UI-SPEC 3.3; Simple first, owner decision 2026-10-26)', () => {
  it('defaults to Simple and stores either mode', () => {
    expect(currentPreferences().layoutMode).toBe('simple');
    savePreferences({ layoutMode: 'pro' });
    expect(currentPreferences().layoutMode).toBe('pro');
    savePreferences({ layoutMode: 'simple' });
    expect(currentPreferences().layoutMode).toBe('simple');
  });
  it('refuses a value that is not a mode', () => {
    expect(() => savePreferences({ layoutMode: 'dense' as never })).toThrow();
    expect(currentPreferences().layoutMode).toBe('simple');
  });
});
