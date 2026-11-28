/**
 * Drawing by hand on a Lightweight Charts chart element: what is kept in step with the element and the library while a
 * room draws on it. These hooks know no screen (garden/no-effect-in-product); each reads its latest arguments when it
 * runs, so a room passes fresh closures every render and nothing is subscribed again for it.
 *
 * - `usePointerFollow`: a press on the element, followed on the window (a drag or a stroke that leaves the element is
 *   still followed), and every release and cancelled press on the window.
 * - `useTouchAction`: the element's CSS `touch-action` while a value is asked for, put back after.
 * - `useAttributeChanges`: a callback when named attributes of the element change (another part marks the element).
 * - `useSeriesPrimitive`: a series primitive attached to the series shown, again on a new series, and painted again
 *   whenever the scene it draws from changes.
 */
import { useEffect, useRef } from 'react';

export type FollowedEvent = 'pointermove' | 'pointerup' | 'pointercancel';
const FOLLOWED: readonly FollowedEvent[] = ['pointermove', 'pointerup', 'pointercancel'];

/** What each handler is given: the element and owner it was subscribed for, the gesture state, and the following switch. */
export interface FollowContext<O, S> {
  element: HTMLElement;
  owner: O;
  /** The state of the gestures on this element and owner, made fresh for each. */
  session: S;
  /** From now the window's pointermove, pointerup and pointercancel reach `onMove`, `onUp` and `onCancel`. */
  follow(): void;
  /** Stops following the named events (all three when none are named). */
  unfollow(events?: readonly FollowedEvent[]): void;
}

export interface PointerFollow<O, S> {
  session: () => S;
  /** A pointerdown on the element. */
  onDown(event: PointerEvent, ctx: FollowContext<O, S>): void;
  onMove(event: PointerEvent, ctx: FollowContext<O, S>): void;
  onUp(event: PointerEvent, ctx: FollowContext<O, S>): void;
  onCancel(event: PointerEvent, ctx: FollowContext<O, S>): void;
  /** Every pointerup on the window, followed or not; it runs before `onUp`. */
  onAnyUp(event: PointerEvent, ctx: FollowContext<O, S>): void;
  /** Every pointercancel on the window, followed or not; it runs before `onCancel`. */
  onAnyCancel(event: PointerEvent, ctx: FollowContext<O, S>): void;
  /** When the element or the owner changes and when the room goes, after every listener is removed. */
  onStop(ctx: FollowContext<O, S>): void;
}

/** Follows presses on `element` while it and `owner` (what the gestures act on, such as the chart) are there. */
export function usePointerFollow<O, S>(
  element: HTMLElement | null | undefined,
  owner: O | null | undefined,
  spec: PointerFollow<O, S>,
): void {
  const latest = useRef(spec);
  latest.current = spec;
  useEffect(() => {
    if (!element || !owner) return;
    const followed: Record<FollowedEvent, (event: PointerEvent) => void> = {
      pointermove: (event) => latest.current.onMove(event, ctx),
      pointerup: (event) => latest.current.onUp(event, ctx),
      pointercancel: (event) => latest.current.onCancel(event, ctx),
    };
    const ctx: FollowContext<O, S> = {
      element,
      owner,
      session: latest.current.session(),
      follow: () => {
        for (const type of FOLLOWED) window.addEventListener(type, followed[type]);
      },
      unfollow: (events = FOLLOWED) => {
        for (const type of events) window.removeEventListener(type, followed[type]);
      },
    };
    const onDown = (event: PointerEvent) => latest.current.onDown(event, ctx);
    const onAnyUp = (event: PointerEvent) => latest.current.onAnyUp(event, ctx);
    const onAnyCancel = (event: PointerEvent) => latest.current.onAnyCancel(event, ctx);
    element.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onAnyUp);
    window.addEventListener('pointercancel', onAnyCancel);
    return () => {
      element.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onAnyUp);
      window.removeEventListener('pointercancel', onAnyCancel);
      ctx.unfollow();
      latest.current.onStop(ctx);
    };
  }, [element, owner]);
}

/** Sets `element`'s `touch-action` to `value` while it is not null; what the element had before is put back after. */
export function useTouchAction(element: HTMLElement | null | undefined, value: string | null): void {
  useEffect(() => {
    if (!element) return;
    const before = element.style.touchAction;
    if (value !== null) element.style.touchAction = value;
    return () => {
      element.style.touchAction = before;
    };
  }, [element, value]);
}

/**
 * Calls `onChange` whenever one of `attributes` (a constant list) of `element` changes, and `onStop` when the element
 * goes or the room does, after the observer is disconnected.
 */
export function useAttributeChanges(
  element: HTMLElement | null | undefined,
  attributes: readonly string[],
  onChange: () => void,
  onStop?: () => void,
): void {
  const latest = useRef({ onChange, onStop });
  latest.current = { onChange, onStop };
  useEffect(() => {
    if (!element || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => latest.current.onChange());
    observer.observe(element, { attributes: true, attributeFilter: [...attributes] });
    return () => {
      observer.disconnect();
      latest.current.onStop?.();
    };
  }, [element, attributes]);
}

export interface AttachableSeries {
  attachPrimitive(primitive: unknown): void;
  detachPrimitive(primitive: unknown): void;
}

export interface SeriesPrimitive<S> {
  /** The primitive is told the series it draws on before it is attached. */
  bind(series: S): void;
}

export interface PrimitiveBinding<S> {
  /** After the primitive is attached, with the chart's element (when there is one), for a readback of what is drawn. */
  onAttach?: (element: HTMLElement, series: S) => void;
  /** After it is detached. */
  onDetach?: (element: HTMLElement) => void;
  /** Gives the primitive its state again. */
  paint: () => void;
  /** What the primitive draws from, memoised by the room: a new scene paints again. */
  scene: unknown;
}

/** Attaches `primitive` to `series` while it is shown (again on a new series or element) and paints on a new scene. */
export function useSeriesPrimitive<S extends AttachableSeries>(
  series: S | null | undefined,
  element: HTMLElement | null | undefined,
  primitive: SeriesPrimitive<S>,
  binding: PrimitiveBinding<S>,
): void {
  const latest = useRef(binding);
  latest.current = binding;
  useEffect(() => {
    if (!series) return;
    primitive.bind(series);
    series.attachPrimitive(primitive);
    if (element) latest.current.onAttach?.(element, series);
    return () => {
      series.detachPrimitive(primitive);
      if (element) latest.current.onDetach?.(element);
    };
  }, [series, element, primitive]);
  const { scene } = binding;
  useEffect(() => {
    latest.current.paint();
  }, [scene]);
}
