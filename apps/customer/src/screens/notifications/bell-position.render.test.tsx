// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

// The bell's reads, answered here: three unread, no owner cap, an empty inbox. No service is contacted.
vi.mock('./use-notifications', async (original) => ({
  ...(await original<typeof import('./use-notifications')>()),
  useUnreadCount: () => 3,
  useInboxPolicy: () => ({ status: 'loading' }),
  useInboxView: () => ({
    inbox: {
      state: { status: 'ready', items: [], nextCursor: null },
      actionFailed: false,
      reload: () => undefined,
      readAll: async () => undefined,
    },
    state: { status: 'ready', items: [], nextCursor: null },
    markets: new Map(),
  }),
}));

import { BellPopover } from './BellPopover';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

// The bell sits in the sticky top bar. Placed in the page (absolute), its popover moves with the page for a frame on
// every scroll, so a press can begin on one row and end off it, and the click opens nothing. Placed against the window
// (fixed), it stays under the bell. The scroll itself is shown in a real browser by the harness test
// "bell: a page scroll under the open popover leaves every row where it was" (notifications.pw.mjs).
it('the open bell popover is placed against the window, so a page scroll never moves it under a press', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<BellPopover path="/home" />));
  const bell = document.querySelector<HTMLButtonElement>('[data-testid="tb-bell"]');
  expect(bell).not.toBeNull();
  await act(async () => bell!.click());
  const popup = document.querySelector('[data-testid="nf-pop"]');
  expect(popup, 'the popover opened').not.toBeNull();
  expect((popup!.parentElement as HTMLElement).style.position).toBe('fixed');
});
