/**
 * Arrow keys in a row of pressed buttons (Segmented, ToggleChips, SectionTabs): the arrow along the row moves focus to
 * the next or previous button, wrapping at the ends, and Home and End go to the first and last. Moving focus never
 * presses a button; Enter and Space still do. The arrows follow reading order, so in a right-to-left page the left
 * arrow goes forward. Every button stays a Tab stop, so Tab and Shift+Tab move as they did before.
 */
import type * as React from 'react';

/** Where focus goes from button `at` of `count` for `key`, or null when the key is not one the row answers. */
export function arrowTarget(key: string, at: number, count: number, rtl = false): number | null {
  if (count < 1 || at < 0 || at >= count) return null;
  const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
  const back = rtl ? 'ArrowRight' : 'ArrowLeft';
  if (key === forward) return (at + 1) % count;
  if (key === back) return (at - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/** The row's `onKeyDown`: moves focus among its own enabled buttons and keeps the key from scrolling the page. */
export function moveFocusByArrow(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const row = event.currentTarget;
  const buttons = Array.from(row.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)'));
  const at = buttons.indexOf(event.target as HTMLButtonElement);
  const view = row.ownerDocument.defaultView;
  const rtl = view ? view.getComputedStyle(row).direction === 'rtl' : false;
  const next = arrowTarget(event.key, at, buttons.length, rtl);
  if (next === null) return;
  event.preventDefault();
  buttons[next]!.focus();
}
