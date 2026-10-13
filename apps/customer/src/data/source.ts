/**
 * Framework-free reactive sources.
 *
 * A `Source<T>` is the contract React's `useSyncExternalStore` wants
 * (`subscribe` + a referentially stable `getSnapshot`), with the snapshot being
 * a `Loadable<T>` from `types.ts`. Keeping this outside React lets the polling,
 * derivations and combinations be unit-tested without a DOM.
 */
import type { Loadable } from './types';

export interface Source<T> {
  subscribe(listener: () => void): () => void;
  /** Must return the same object until the state actually changes. */
  getSnapshot(): Loadable<T>;
}

type Snap<S> = S extends Source<infer T> ? Loadable<T> : never;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySource = Source<any>;
export type Snaps<I extends readonly AnySource[]> = { [K in keyof I]: Snap<I[K]> };

/** A state that has no data to show. */
export type Blocking = Exclude<Loadable<never>, { status: 'ready' }>;

/**
 * If any input has no data, the state that should win: a typed refusal first
 * (it carries words), then a network error (retries every failed input), then
 * loading, then empty. Null when every input is ready.
 */
export function blockingState(snaps: ReadonlyArray<Loadable<unknown>>): Blocking | null {
  const refused = snaps.find((s) => s.status === 'refused');
  if (refused && refused.status === 'refused') return { status: 'refused', code: refused.code };
  const errors = snaps.filter((s): s is Extract<Loadable<unknown>, { status: 'error' }> => s.status === 'error');
  if (errors.length > 0) return { status: 'error', retry: () => errors.forEach((e) => e.retry()) };
  if (snaps.some((s) => s.status === 'loading')) return { status: 'loading' };
  if (snaps.some((s) => s.status === 'empty')) return { status: 'empty' };
  return null;
}

/** The latest `asOf` among ready inputs (a composite is as fresh as its newest part). */
export function newestAsOf(snaps: ReadonlyArray<Loadable<unknown>>): number {
  let best = 0;
  for (const s of snaps) if (s.status === 'ready' && s.asOf > best) best = s.asOf;
  return best;
}

/** A source that never changes. */
export function constantSource<T>(value: Loadable<T>): Source<T> {
  return { subscribe: () => () => undefined, getSnapshot: () => value };
}

/**
 * Combine several sources into one. `project` runs only when an input snapshot
 * changed, so the result keeps its identity between unrelated notifications.
 */
export function combine<const I extends readonly AnySource[], R>(sources: I, project: (snaps: Snaps<I>) => Loadable<R>): Source<R> {
  let lastInputs: readonly Loadable<unknown>[] | null = null;
  let lastResult: Loadable<R> = { status: 'loading' };
  return {
    subscribe(listener) {
      const unsubs = sources.map((s) => s.subscribe(listener));
      return () => unsubs.forEach((u) => u());
    },
    getSnapshot() {
      const inputs = sources.map((s) => s.getSnapshot() as Loadable<unknown>);
      if (lastInputs && inputs.every((snap, i) => snap === lastInputs![i])) return lastResult;
      lastInputs = inputs;
      lastResult = project(inputs as unknown as Snaps<I>);
      return lastResult;
    },
  };
}

/**
 * Follow an outer source whose data decides which inner source to read, for
 * example "the markets list decides which candle series to fetch". The inner
 * source is rebuilt only when `keyOf` changes, so it is cached between renders.
 */
export function switchMap<A, R>(outer: Source<A>, keyOf: (data: A) => string, build: (data: A) => Source<R>): Source<R> {
  let current: { key: string; source: Source<R> } | null = null;

  function wanted(): Source<R> | null {
    const snap = outer.getSnapshot();
    if (snap.status !== 'ready') return null;
    const key = keyOf(snap.data);
    if (!current || current.key !== key) current = { key, source: build(snap.data) };
    return current.source;
  }

  return {
    subscribe(listener) {
      let subscribed: Source<R> | null = null;
      let unsubInner: (() => void) | null = null;
      const sync = () => {
        const next = wanted();
        if (next !== subscribed) {
          unsubInner?.();
          unsubInner = next ? next.subscribe(listener) : null;
          subscribed = next;
        }
      };
      const onOuter = () => {
        sync();
        listener();
      };
      const unsubOuter = outer.subscribe(onOuter);
      sync();
      return () => {
        unsubOuter();
        unsubInner?.();
      };
    },
    getSnapshot() {
      const inner = wanted();
      return inner ? inner.getSnapshot() : (outer.getSnapshot() as unknown as Loadable<R>);
    },
  };
}
