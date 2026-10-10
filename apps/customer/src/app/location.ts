import { useSyncExternalStore } from 'react';

export function navigate(path: string, replace = false) {
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
