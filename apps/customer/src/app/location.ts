import { useSyncExternalStore } from 'react';
import { betaShownHref } from './beta-volt';

/**
 * Every move the app makes in code goes through here or leaveTo(), never history.pushState or location.assign directly
 * (beta-nav.test.ts): in the beta's build a target the beta hides becomes its nearest shown room (betaShownHref).
 */
export function navigate(to: string, replace = false) {
  const path = betaShownHref(to);
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo({ top: 0, behavior: 'instant' });
}
const subscribe = (listener: () => void) => {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
};
export function useLocation() {
  return useSyncExternalStore(subscribe, () => location.pathname + location.search);
}

const subscribeReturnLocation = (listener: () => void) => {
  window.addEventListener('popstate', listener);
  window.addEventListener('hashchange', listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener('hashchange', listener);
  };
};
export function currentReturnLocation() {
  return location.pathname + location.search + location.hash;
}
export function useReturnLocation() {
  return useSyncExternalStore(subscribeReturnLocation, currentReturnLocation);
}

/** A full page load to `href` (another site, or an app page that must load afresh), with navigate()'s beta rule for app paths. */
export function leaveTo(href: string) {
  location.assign(betaShownHref(href));
}
