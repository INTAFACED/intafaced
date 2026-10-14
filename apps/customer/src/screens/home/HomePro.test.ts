import { describe, expect, it } from 'vitest';
import { proCopy } from './pro-copy';

// Rendering is covered by the Playwright test (home-pro.pw.mjs): the preferences hook has no server snapshot, so
// the screen cannot be server-rendered in a unit test.
const banned = /unavailable|not connected|restricted|fixture|lifecycle/i;
const en = proCopy.forLocale('en');

describe('Home Pro words (UI-SPEC 4.3, plain words)', () => {
  it('uses no banned word on screen', () => {
    for (const key of [
      'Switch name',
      'Switch tip',
      'No assets yet',
      'No assets body',
      'Couldn’t load your assets',
      'Couldn’t load markets',
      'Couldn’t load prices',
      'No markets are open right now.',
    ] as const)
      expect(en.t(key), key).not.toMatch(banned);
  });

  it('the switch tooltip says what changes', () => {
    const tip = en.t('Switch tip');
    expect(tip).toMatch(/Simple/);
    expect(tip).toMatch(/Pro/);
    expect(tip).toMatch(/table/i);
  });

  it('names the open orders count for a screen reader', () => {
    expect(en.t('Open orders count', { count: '3' })).toBe('3 open orders');
    expect(en.t('Trade {asset}', { asset: 'BTC' })).toBe('Trade BTC');
  });
});
