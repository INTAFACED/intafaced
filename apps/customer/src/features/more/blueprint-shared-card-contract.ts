import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import type { ProcedureOutput } from '@intafaced/contracts/procedure';
import type { BLUEPRINT_CARD_OF } from '@intafaced/contracts/blueprint-procedures';

export const sharedCardSelection = z.object({ userId: z.string().guid(), size: z.enum(['portrait', 'landscape']) }).strict();
export type SharedCardSelection = z.infer<typeof sharedCardSelection>;
export const sharedCardDimensions = { portrait: { width: 1080, height: 1350 }, landscape: { width: 1200, height: 630 } } as const;
/** This caller's check over a `cardOf` reply: the card is the size asked for, at that size's canonical dimensions. */
export function sharedCardMatches(selection: SharedCardSelection) {
  const dimensions = sharedCardDimensions[selection.size];
  return (card: SharedCard) => card.size === selection.size && card.width === dimensions.width && card.height === dimensions.height;
}
export type SharedCard = ProcedureOutput<typeof BLUEPRINT_CARD_OF>;
export function sharedCardHref(selection: SharedCardSelection) {
  const exact = sharedCardSelection.parse(selection);
  return `/blueprint?subject=${encodeURIComponent(exact.userId)}&size=${exact.size}`;
}
export function sharedCardRoute(href: string): { selection: SharedCardSelection | null; invalid: boolean } {
  const url = new URL(href, location.origin);
  const subjects = url.searchParams.getAll('subject'),
    sizes = url.searchParams.getAll('size');
  if (!subjects.length && !sizes.length) return { selection: null, invalid: false };
  const parsed = sharedCardSelection.safeParse({ userId: subjects[0], size: sizes[0] ?? 'portrait' });
  return subjects.length === 1 && sizes.length <= 1 && parsed.success
    ? { selection: Object.freeze(parsed.data), invalid: false }
    : { selection: null, invalid: true };
}
export function sharedCardFailure(result: Extract<ApiResult<unknown>, { ok: false }>) {
  if (result.status === 404 && result.code === 'blueprint.not_found') return 'unavailable' as const;
  if (result.reason === 'unauthorized') return 'unauthorized' as const;
  if (result.reason === 'forbidden') return 'forbidden' as const;
  if (result.reason === 'not_mounted') return 'routeUnavailable' as const;
  if (result.reason === 'invalid_response') return 'invalidResponse' as const;
  return 'failed' as const;
}

// Observe every URL departure synchronously, including A→B→A in one React batch.
// Feature-owned wrappers exist only while a viewer or mentor action is mounted.
let observed: { href: string; epoch: number; historyLength: number | undefined } = { href: '', epoch: 0, historyLength: undefined };
const listeners = new Set<() => void>();
let releaseHistory: (() => void) | undefined;
export function currentSharedCardRoute() {
  if (observed.href !== location.href || observed.historyLength !== history.length)
    observed = { href: location.href, epoch: observed.epoch + 1, historyLength: history.length };
  return observed;
}
export function subscribeSharedCardRoute(listener: () => void) {
  if (!listeners.size) {
    currentSharedCardRoute();
    const observe = (event?: Event) => {
      const previous = observed;
      currentSharedCardRoute();
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
