import { describe, expect, it } from 'vitest';
import { UI_VIEW_NAMESPACE, uiViewPreferenceSchema, uiViewRequestId, uiViewValueSchema } from './ui-view-preferences.js';
import * as root from './index.js';

describe('ui.view record', () => {
  it('accepts a whole record, a partial one and an empty one', () => {
    expect(
      uiViewValueSchema.safeParse({
        layoutMode: 'simple',
        hideBalances: true,
        displayCurrency: 'BTC',
        theme: 'system',
        activeProfile: 'business:acme-1',
      }).success,
    ).toBe(true);
    expect(uiViewValueSchema.safeParse({ layoutMode: 'pro' }).success).toBe(true);
    expect(uiViewValueSchema.safeParse({}).success).toBe(true);
  });
  it.each([
    { layoutMode: 'compact' },
    { hideBalances: 'yes' },
    { displayCurrency: 'JPY' },
    { theme: 'blue' },
    { activeProfile: 'business:' },
    { activeProfile: 'business:has space' },
    { activeProfile: 'sub:1' },
    { somethingElse: 1 },
  ])('refuses %j', (value) => {
    expect(uiViewValueSchema.safeParse(value).success).toBe(false);
  });
  it('is the shape the preferences door returns for this namespace', () => {
    expect(uiViewPreferenceSchema.safeParse({ namespace: UI_VIEW_NAMESPACE, version: 0, value: null }).success).toBe(true);
    expect(uiViewPreferenceSchema.safeParse({ namespace: 'account.display', version: 0, value: null }).success).toBe(false);
  });
  it('names a write by person and version, never at random', () => {
    expect(uiViewRequestId('ABC', 3)).toBe('ui-view:abc:3');
    expect(uiViewRequestId('abc', 3)).toBe(uiViewRequestId('ABC', 3));
    expect(uiViewRequestId('abc', 4)).not.toBe(uiViewRequestId('abc', 3));
  });
  it('is reachable from the package root too', () => {
    expect(root.UI_VIEW_NAMESPACE).toBe('ui.view');
  });
});
