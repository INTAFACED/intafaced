import { useEffect, useLayoutEffect, useRef } from 'react';

/** Move focus into a newly committed Customer room without changing scroll. */
export function useCustomerRoomArrival(pathname: string, customerShell: boolean, redirecting: boolean) {
  const previousPath = useRef(pathname);
  const observed = useRef({ href: location.href, epoch: 0 });
  const frame = useRef(0);

  useLayoutEffect(() => {
    function departed(event: Event) {
      // Native hash events can arrive after a departure-and-return has batched.
      const href = event instanceof HashChangeEvent && event.newURL ? event.newURL : location.href;
      if (observed.current.href === href) return;
      observed.current = { href, epoch: observed.current.epoch + 1 };
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    }
    window.addEventListener('popstate', departed, true);
    window.addEventListener('hashchange', departed, true);
    return () => {
      cancelAnimationFrame(frame.current);
      window.removeEventListener('popstate', departed, true);
      window.removeEventListener('hashchange', departed, true);
    };
  }, []);

  useEffect(() => {
    const previous = previousPath.current;
    previousPath.current = pathname;
    if (previous === pathname || !customerShell || redirecting) return;
    const target = document.getElementById('main');
    if (!(target instanceof HTMLElement)) return;
    const href = location.href;
    const epoch = observed.current.epoch;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (
        location.pathname !== pathname ||
        location.href !== href ||
        observed.current.epoch !== epoch ||
        document.getElementById('main') !== target ||
        !target.isConnected ||
        target.closest('[inert], [hidden], [aria-hidden="true"]') ||
        document.querySelector('dialog[open], [aria-modal="true"]')
      )
        return;
      // Newly focused controls and new dialogs own their current interaction.
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement && active.isConnected) return;
      target.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [pathname, customerShell, redirecting]);
}
