// Observe every URL departure synchronously, including A→B→A in one React batch: a reader that captured the route
// before an await compares it after, and a changed route drops the stale answer.
// Feature-owned wrappers exist only while a viewer or mentor action is mounted.
let observed: { href: string; epoch: number; historyLength: number | undefined } = { href: '', epoch: 0, historyLength: undefined };
const listeners = new Set<() => void>();
let releaseHistory: (() => void) | undefined;
export function currentRoute() {
  if (observed.href !== location.href || observed.historyLength !== history.length)
    observed = { href: location.href, epoch: observed.epoch + 1, historyLength: history.length };
  return observed;
}
export function subscribeRoute(listener: () => void) {
  if (!listeners.size) {
    currentRoute();
    const observe = (event?: Event) => {
      const previous = observed;
      currentRoute();
      if (event instanceof HashChangeEvent && event.oldURL !== event.newURL)
        observed = { href: location.href, epoch: observed.epoch + 1, historyLength: history.length };
      if (previous !== observed) for (const notify of [...listeners]) notify();
    };
    const push = history.pushState,
      replace = history.replaceState;
    const wrappedPush: History['pushState'] = function (this: History, ...args) {
      push.apply(this, args);
      observe();
    };
    const wrappedReplace: History['replaceState'] = function (this: History, ...args) {
      replace.apply(this, args);
      observe();
    };
    history.pushState = wrappedPush;
    history.replaceState = wrappedReplace;
    window.addEventListener('popstate', observe);
    window.addEventListener('hashchange', observe);
    releaseHistory = () => {
      if (history.pushState === wrappedPush) history.pushState = push;
      if (history.replaceState === wrappedReplace) history.replaceState = replace;
      window.removeEventListener('popstate', observe);
      window.removeEventListener('hashchange', observe);
    };
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      releaseHistory?.();
      releaseHistory = undefined;
    }
  };
}
