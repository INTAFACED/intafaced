/**
 * Something outside React kept in step with a room: a timer, a listener, an observer, the room still being there. A room
 * calls these instead of writing its own effect (garden/no-effect-in-product); each keeps the latest callback, so a room
 * passes a fresh closure every render and nothing is subscribed again for it.
 *
 * - `useMounted`: a ref that is true while the room is on screen, for a reply that may land after it has gone.
 * - `useInterval` / `useTimeout`: a callback every `ms` / once after `ms`; `null` stops it. A timeout starts again when
 *   its `restart` value changes.
 * - `useNow`: the clock, read again every `ms` while `ms` is not `null`.
 * - `useEventListener`: a listener on `window`, `document`, an element or an element's ref, while the target is there.
 * - `useMediaQuery`: whether a media query matches now, read with useSyncExternalStore.
 * - `useResizeObserver`: a callback when the element behind a ref changes size.
 * - `useRelease`: let go of something held for `key` (a claim, an object URL) when `key` changes or the room unmounts.
 *   Unlike the others it runs the `release` made when `key` took its value, not the latest one.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';

function useLatest<T>(value: T): RefObject<T> {
  const latest = useRef(value);
  latest.current = value;
  return latest;
}

/** True from the room's first layout until it unmounts. */
export function useMounted(): RefObject<boolean> {
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
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

/** Calls `callback` once, `ms` after `ms` became non-null or `restart` last changed; `null` cancels it. */
export function useTimeout(callback: () => void, ms: number | null, restart?: unknown): void {
  const latest = useLatest(callback);
  useEffect(() => {
    if (ms === null) return;
    const timer = setTimeout(() => latest.current(), ms);
    return () => clearTimeout(timer);
  }, [ms, restart, latest]);
}

/** `Date.now()`, read again every `ms` while `ms` is not `null`. */
export function useNow(ms: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), ms);
  return now;
}

type Target = EventTarget | null | undefined;

/** Listens for `type` on `target` (a ref is read once mounted) while it is there; the latest `handler` runs. */
export function useEventListener<E extends Event = Event>(
  target: Target | RefObject<EventTarget | null>,
  type: string,
  handler: (event: E) => void,
  options?: boolean | AddEventListenerOptions,
): void {
  const latest = useLatest(handler);
  const capture = typeof options === 'boolean' ? options : (options?.capture ?? false);
  const passive = typeof options === 'object' ? options.passive : undefined;
  useEffect(() => {
    const node = target && 'current' in target ? target.current : target;
    if (!node) return;
    const listener = (event: Event) => latest.current(event as E);
    node.addEventListener(type, listener, { capture, passive });
    return () => node.removeEventListener(type, listener, { capture });
  }, [target, type, capture, passive, latest]);
}

/** Whether `query` matches now; a change re-renders the room. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Calls `onResize` when the element behind `ref` changes size, while it is mounted. */
export function useResizeObserver(ref: RefObject<Element | null>, onResize: () => void): void {
  const latest = useLatest(onResize);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => latest.current());
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, latest]);
}

/** Runs `release`, as made for `key`, when `key` changes or the room unmounts. */
export function useRelease(key: string, release: () => void): void {
  const latest = useLatest(release);
  useEffect(() => {
    const made = latest.current;
    return () => made();
  }, [key, latest]);
}
