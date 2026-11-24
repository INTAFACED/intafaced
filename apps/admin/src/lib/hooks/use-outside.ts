'use client';
/**
 * Something outside React kept in step with a desk: a timer, a listener, a focus, a mark on the page's body. A desk calls these instead of writing its own effect (garden/no-effect-in-product), the way it loads through
 * use-resource.ts. Each keeps the latest callback, so a desk passes a fresh closure every render and nothing is
 * subscribed again for it. The customer app's equivalents are apps/customer/src/shared/outside.ts.
 *
 * - `useInterval` / `useTimeout`: a callback every `ms` / once after `ms`; `null` stops it.
 * - `useEventListener`: a listener on `window`, `document` or an element while the desk is on screen.
 * - `useCommittedRef`: a ref the latest committed render's value is written into, for async work and listeners that
 *   must read what is on screen now, not what a render that never landed computed.
 * - `useFocusOnChange`: focus moves to the element behind a ref when it appears and whenever `key` changes.
 * - `useBodyData`: `data-*` marks on `document.body` (for parts the layout owns, like the skip link) while the desk is on
 *   screen; an `undefined` value is no mark.
 */
import { useEffect, useRef, type RefObject } from 'react';

function useLatest<T>(value: T): RefObject<T> {
  const latest = useRef(value);
  latest.current = value;
  return latest;
}

/** Calls `callback` every `ms` while `ms` is not `null`. */
export function useInterval(callback: () => void, ms: number | null): void {
  const latest = useLatest(callback);
  useEffect(() => {
    if (ms === null) return;
    const timer = setInterval(() => latest.current(), ms);
    return () => clearInterval(timer);
  }, [ms, latest]);
}

/** Calls `callback` once, `ms` after mount (or after `ms` became non-null); `null` cancels it. */
export function useTimeout(callback: () => void, ms: number | null): void {
  const latest = useLatest(callback);
  useEffect(() => {
    if (ms === null) return;
    const timer = setTimeout(() => latest.current(), ms);
    return () => clearTimeout(timer);
  }, [ms, latest]);
}

/** Listens for `type` on `target` while the desk is on screen; the latest `handler` runs. */
export function useEventListener<E extends Event = Event>(
  target: EventTarget | null | undefined,
  type: string,
  handler: (event: E) => void,
): void {
  const latest = useLatest(handler);
  useEffect(() => {
    if (!target) return;
    const listener = (event: Event) => latest.current(event as E);
    target.addEventListener(type, listener);
    return () => target.removeEventListener(type, listener);
  }, [target, type, latest]);
}

/** Writes `value` into `ref` after every committed render. */
export function useCommittedRef<T>(ref: RefObject<T>, value: T): void {
  useEffect(() => {
    ref.current = value;
  });
}

/** Focuses the element behind `ref` once it is there, and again whenever `key` changes. */
export function useFocusOnChange(ref: RefObject<HTMLElement | null>, key: unknown): void {
  useEffect(() => {
    ref.current?.focus();
  }, [ref, key]);
}

/** Sets each `data-*` mark of `marks` on `document.body` while mounted; a changed mark replaces the old ones. */
export function useBodyData(marks: Record<string, string | undefined>): void {
  const signature = JSON.stringify(marks);
  useEffect(() => {
    const set = JSON.parse(signature) as Record<string, string | undefined>;
    for (const [name, value] of Object.entries(set)) {
      if (value === undefined) delete document.body.dataset[name];
      else document.body.dataset[name] = value;
    }
    return () => {
      for (const name of Object.keys(set)) delete document.body.dataset[name];
    };
  }, [signature]);
}
