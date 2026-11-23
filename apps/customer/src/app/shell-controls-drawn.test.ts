// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderPart } from './render-record/harness';

// HM-shell-03 and product law: the shell's controls (bell, Simple/Pro switch, avatar menu) are always drawn for a
// signed-in person. Feature-registry status is proof state, never visibility, so the shell never asks it whether to draw.
// Here every feature reads as not live, and the signed-in shell must still draw each control.
vi.mock('./feature-registry', async (original) => {
  const real = await original<typeof import('./feature-registry')>();
  return {
    ...real,
    isFeatureLive: () => false,
    featureById: (id: string) => {
      const feature = real.featureById(id);
      return feature && { ...feature, status: 'blocked' as const };
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => void vi.useFakeTimers({ toFake: ['Date'] }));
afterAll(() => void vi.useRealTimers());

describe('the shell draws its controls whatever the feature registry says', () => {
  it('reads every feature as not live here', async () => {
    const { isFeatureLive, featureById } = await import('./feature-registry');
    expect(isFeatureLive('pro-mode-switch')).toBe(false);
    expect(featureById('pro-mode-switch')?.status).toBe('blocked');
  });

  it('draws the bell, the Simple/Pro switch and the account menu, and the menu holds the switch too', { timeout: 120_000 }, async () => {
    const page = document.createElement('div');
    const html = await renderPart({
      name: '/more',
      route: '/more',
      act: (root) => {
        page.innerHTML = root.innerHTML;
        root.querySelector<HTMLButtonElement>('[data-testid="tb-right"] button[aria-label="Account menu"]')!.click();
      },
    });
    const bar = page.querySelector('[data-testid="tb-right"]');
    expect(bar, 'the top bar is drawn').not.toBeNull();
    expect(bar!.querySelector('[data-testid="tb-bell"]'), 'the bell').not.toBeNull();
    expect(bar!.querySelector('.tb-mode [aria-label="Simple or Pro layout"]'), 'the Simple/Pro switch').not.toBeNull();
    expect(bar!.querySelector('button[aria-label="Account menu"]'), 'the account menu').not.toBeNull();
    const opened = document.createElement('div');
    opened.innerHTML = html;
    const menu = opened.querySelector('.tb-account-menu');
    expect(menu, 'the account menu opens').not.toBeNull();
    expect(menu!.querySelector('.tb-account-mode [aria-label="Simple or Pro layout"]'), 'the Simple/Pro switch in the menu').not.toBeNull();
  });
});
