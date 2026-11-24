import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseTab } from './tabs.mjs';

/**
 * A tab whose first `dropped` clicks are lost, as the follow dialog's "Skipped" was in run 43781336614. Waiting for it to
 * read selected spends the wait on the fake clock and times out the way Playwright's waitFor does.
 */
function tabDropping(dropped) {
  const tab = {
    clicks: 0,
    selected: false,
    async click() {
      tab.clicks += 1;
      if (tab.clicks > dropped) tab.selected = true;
    },
  };
  const chosen = {
    async waitFor({ timeout }) {
      if (tab.selected) return;
      vi.advanceTimersByTime(timeout);
      throw Object.assign(new Error(`waitFor: Timeout ${timeout}ms exceeded.`), { name: 'TimeoutError' });
    },
  };
  const scope = {
    asked: [],
    getByRole(role, options) {
      scope.asked.push({ role, ...options });
      return options.selected ? chosen : tab;
    },
  };
  return { tab, scope };
}

describe('chooseTab', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('finds the tab by its exact name and clicks it once when the click lands', async () => {
    const { tab, scope } = tabDropping(0);
    expect(await chooseTab(scope, 'Skipped')).toBe(tab);
    expect(scope.asked).toEqual([
      { role: 'tab', name: 'Skipped', exact: true },
      { role: 'tab', name: 'Skipped', exact: true, selected: true },
    ]);
    expect(tab.clicks).toBe(1);
  });

  it('clicks again when the page drops the first click, and returns once the tab reads selected', async () => {
    const { tab, scope } = tabDropping(1);
    expect(await chooseTab(scope, 'Skipped')).toBe(tab);
    expect(tab.clicks).toBe(2);
    expect(tab.selected).toBe(true);
  });

  it('fails by the tab name when it never reads selected, after clicking for the whole timeout', async () => {
    const { tab, scope } = tabDropping(Infinity);
    await expect(chooseTab(scope, 'Skipped', { timeout: 10_000, settle: 2_000 })).rejects.toThrow(
      'the tab "Skipped" never read selected within 10000 ms',
    );
    expect(tab.clicks).toBe(5);
  });

  it('passes on any other failure of the wait at once', async () => {
    const { scope } = tabDropping(Infinity);
    const closed = {
      async waitFor() {
        throw new Error('Target page, context or browser has been closed');
      },
    };
    const real = scope.getByRole.bind(scope);
    scope.getByRole = (role, options) => (options.selected ? closed : real(role, options));
    await expect(chooseTab(scope, 'Skipped')).rejects.toThrow('has been closed');
  });
});
