/**
 * A modal pane's keyboard focus (garden/no-effect-in-product): while `active`, everything outside the pane is inert,
 * Tab and Shift+Tab cycle through the pane's visible controls, Escape calls `onEscape`, and focus starts on the
 * pane's element matching `initialFocus` (else the pane). When it ends, the inert flags are put back as they were and
 * focus returns to where it was. Knows no screen.
 */
import { useEffect, useRef, type RefObject } from 'react';

const CONTROLS =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(pane: RefObject<HTMLElement | null>, active: boolean, onEscape: () => void, initialFocus: string): void {
  const latest = useRef({ onEscape, initialFocus });
  latest.current = { onEscape, initialFocus };
  useEffect(() => {
    const node = pane.current;
    if (!active || !node) return;
    const started = latest.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = new Map<HTMLElement, boolean>();
    let branch = node;
    while (branch.parentElement) {
      const parent = branch.parentElement;
      for (const sibling of parent.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          background.set(sibling, sibling.inert);
          sibling.inert = true;
        }
      }
      branch = parent;
      if (parent === document.body) break;
    }
    function keyboard(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        started.onEscape();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(node!.querySelectorAll<HTMLElement>(CONTROLS)).filter(
        (element) =>
          element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' && !element.closest('[inert]'),
      );
      const first = controls[0],
        last = controls.at(-1),
        focused = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
        node!.focus();
      } else if (event.shiftKey && (focused === first || focused === node)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (focused === last || focused === node)) {
        event.preventDefault();
        first.focus();
      }
    }
    node.addEventListener('keydown', keyboard);
    (node.querySelector<HTMLElement>(started.initialFocus) ?? node).focus();
    return () => {
      node.removeEventListener('keydown', keyboard);
      for (const [element, wasInert] of background) element.inert = wasInert;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [pane, active]);
}
