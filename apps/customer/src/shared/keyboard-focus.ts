import { useEffect } from 'react';

/** Keep native keyboard focus above fixed phone navigation after responsive reflow. */
export function useKeepKeyboardFocusVisible() {
  useEffect(() => {
    let frame = 0;
    let pointerFocus = false;
    const viewport = window.visualViewport;

    function reveal() {
      frame = 0;
      const target = document.activeElement;
      if (
        pointerFocus ||
        !(target instanceof HTMLElement) ||
        !target.matches(':focus-visible') ||
        target.closest('.mobile-doors, [inert], [hidden], [aria-hidden="true"], dialog, [role="dialog"]') ||
        document.querySelector('dialog[open], [aria-modal="true"]')
      )
        return;

      const rect = target.getBoundingClientRect();
      if (!rect.height || !rect.width) return;
      const top = viewport?.offsetTop ?? 0;
      let bottom = top + (viewport?.height ?? window.innerHeight);
      const nav = document.querySelector<HTMLElement>('.mobile-doors')?.getBoundingClientRect();
      if (nav && nav.height > 0 && nav.top < bottom && nav.bottom > top) bottom = Math.max(top, nav.top);
      if (rect.top >= top && rect.bottom <= bottom) return;

      // Scrolling leaves the original DOM focus and input selection intact.
      const horizontal = target.scrollLeft;
      target.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
      target.scrollLeft = horizontal;
    }
    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reveal);
    }
    function pointer() {
      pointerFocus = true;
    }
    function keyboard() {
      pointerFocus = false;
    }

    document.addEventListener('focusin', schedule);
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', keyboard, true);
    window.addEventListener('resize', schedule);
    viewport?.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('focusin', schedule);
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('keydown', keyboard, true);
      window.removeEventListener('resize', schedule);
      viewport?.removeEventListener('resize', schedule);
    };
  }, []);
}
