import { useEffect } from 'react';

/** Protect typed drafts from reloads and in-app links. Drafts and private fields never enter storage. */
export function useUnsavedForm(dirty: boolean, message: string) {
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const navigate = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(link instanceof HTMLAnchorElement) || link.target === '_blank' || link.hasAttribute('download')) return;
      const target = new URL(link.href);
      if (target.pathname === location.pathname && target.search === location.search) return;
      if (!window.confirm(message)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    // Same-document Back/Forward happens before popstate through the Navigation API.
    // Cancelling here preserves the current history entry and its forward stack.
    const traversal = (event: Event) => {
      const destination = event as Event & { navigationType?: string; destination?: { url: string } };
      if (destination.navigationType !== 'traverse' || !event.cancelable || !destination.destination) return;
      const target = new URL(destination.destination.url);
      if (target.pathname === location.pathname && target.search === location.search) return;
      if (!window.confirm(message)) event.preventDefault();
    };
    const navigation = (window as Window & { navigation?: EventTarget }).navigation;
    navigation?.addEventListener('navigate', traversal);
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', navigate, true);
    return () => {
      navigation?.removeEventListener('navigate', traversal);
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('click', navigate, true);
    };
  }, [dirty, message]);
}
