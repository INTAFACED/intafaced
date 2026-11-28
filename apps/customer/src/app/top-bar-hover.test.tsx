// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Issue 11119: clicking Trade from another page left the Trade menu open over Markets until the pointer moved. Every move to
// another page draws a new top bar (App.tsx keys the frame by path), and the browser sends mouseenter to the new tab under a
// pointer that has not moved. A menu opens on the pointer's own movement only.
vi.mock('../features/session/session', async (original) => {
  const real = await original<typeof import('../features/session/session')>();
  const api = { query: () => new Promise(() => undefined), call: () => new Promise(() => undefined) };
  return { ...real, useSession: () => ({ session: null, restoring: false, api }) as never, useApi: () => api as never };
});

import { TopBar } from './TopBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<TopBar door="Trade" path="/trade" onSignOut={() => undefined} />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const tradeItem = () => {
  const tab = [...host.querySelectorAll<HTMLAnchorElement>('[data-testid="tb-tab"]')].find((a) => a.getAttribute('href') === '/trade');
  if (!tab) throw new Error('no Trade tab in the top bar');
  return tab.closest<HTMLLIElement>('[data-testid="tb-item"]')!;
};
const menu = () => host.querySelector('[data-testid="tb-menu"]');
const pointerMove = (target: Element, pointerType: string) =>
  act(() => {
    target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType }));
  });

it('a newly drawn Trade tab under a pointer that has not moved keeps its menu closed', () => {
  const item = tradeItem();
  // What the browser sends a new element under a still pointer: mouseover into it (React's onMouseEnter listens to it).
  act(() => {
    item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
  });
  expect(menu()).toBeNull();
});

it('the pointer moving over the Trade tab opens its menu, a touch does not', () => {
  const item = tradeItem();
  pointerMove(item, 'touch');
  expect(menu()).toBeNull();
  pointerMove(item, 'mouse');
  expect(menu()).not.toBeNull();
  expect(item.querySelector('a[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
});
