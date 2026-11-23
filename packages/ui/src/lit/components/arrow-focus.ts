/**
 * Arrow keys in a row of pressed buttons (Segmented, ToggleChips, SectionTabs): the arrow along the row moves focus to
 * the next or previous button, wrapping at the ends, and Home and End go to the first and last. Moving focus never
 * presses a button; Enter and Space still do. The arrows follow reading order, so in a right-to-left page the left
 * arrow goes forward. Every button stays a Tab stop, so Tab and Shift+Tab move as they did before.
 */
import type * as React from 'react';

/** Where focus goes from button `at` of `count` for `key`, or null when the key is not one the row answers. */
export function arrowTarget({ key, at, count, rtl = false }: { key: string; at: number; count: number; rtl?: boolean }): number | null {
  if (count < 1 || at < 0 || at >= count) return null;
  const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
  const back = rtl ? 'ArrowRight' : 'ArrowLeft';
  if (key === forward) return (at + 1) % count;
  if (key === back) return (at - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/** A key pressed on `from`, one of a row's `buttons`: moves focus and says so (true), or leaves the key to the browser (false). */
export function arrowFocusIn({
  buttons,
  from,
  key,
  rtl = false,
}: {
  buttons: readonly { focus(): void }[];
  from: unknown;
  key: string;
  rtl?: boolean;
}): boolean {
  const next = arrowTarget({ key, at: buttons.findIndex((b) => b === from), count: buttons.length, rtl });
  const to = next === null ? undefined : buttons[next];
  if (!to) return false;
  to.focus();
  return true;
}

/** The row's `onKeyDown`: moves focus among its own enabled buttons and keeps the key from scrolling the page. */
export function moveFocusByArrow(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const row = event.currentTarget;
  const buttons = Array.from(row.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)'));
  const rtl = row.ownerDocument.defaultView?.getComputedStyle(row).direction === 'rtl';
  if (arrowFocusIn({ buttons, from: event.target, key: event.key, rtl })) event.preventDefault();
}
